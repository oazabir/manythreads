# search

Search over messages, thread titles, file names and pages, with filters you can type or click, and searches you can save: `GET /api/search`, `/api/search/saved` and the capabilities `messages.search` and `files.search` (SPEC section 12, PLAN P3-10, P14-11).
Code: `packages/plugins/search`. Schemas: `packages/shared/src/api/search`. There is no search service and no index of its own: the GIN trigram indexes of `messages.body_plain`,
`threads.title` and `files.name` already exist, the plugin adds three SQL functions and one planner fact (below). Semantic search is the knowledge plugin's job (phase 5).

## What it matches

`pg_trgm` **word similarity**: the query is similar to some run of words of the text. `%>` with the column on the left (the form the GIN index answers), score `word_similarity(query, text)`.
"rolback" finds "rollback" (0.70), a missing, extra or wrong letter in a word of six letters or more is forgiven; a word is found inside a 2,000-character message. Plain `similarity`
would compare the query with the whole text and miss both.

| Kind | Column | Threshold | Notes |
|---|---|---|---|
| messages | `body_plain` (the markdown with its marks removed, `''` once deleted) | 0.5 for one or two words, 0.6 for three or more | a phrase has many trigrams; 0.5 makes the index return a tenth of the table |
| threads | `title` (the first 120 characters of the root message; a thread exists once it has a reply) | 0.5 | |
| files | `name` | 0.4 | names are short |
| pages | `repo_entries.text_plain` and `path` | 0.5 | only paths under `pages/` |

Hits come best score first, newest first among equal scores. Each kind has its own list (`messages`, `threads`, `files`), each at most `limit` (1 to 50, default 20); a scope that leaves a
kind out gives an empty list. Query: 2 to 200 characters after trimming, whitespace collapsed (`q`), `scope` `messages|threads|files|all`, optional `teamId` (only channels of that team).
Wildcards, quotes and backslashes are plain characters: the text is a bound parameter of a trigram operator, never a pattern or SQL. 120 requests per minute per caller.

## Filters (P14-11)

The search box takes plain words and filter words together. The same function, `parseSearchText` in `packages/shared/src/api/search/syntax.ts`, reads them in the browser (to draw chips) and on
the server (to search), so a typed word and a chip are the same thing. A filter word that is not valid stays in the text and is searched as text.

| Word | Meaning |
|---|---|
| `from:nadia`, `from:"Nadia Hamdan"`, `from:me` | the person who wrote the message, uploaded the file, or last saved the page. A name matches the start of the display name or of any later word of it, case-insensitively. Bots have no display name in the database and are not found by name. |
| `in:dev`, `in:#dev` | the channel (by name, among the channels the person can read). Files with no channel and pages are left out. |
| `has:file`, `has:link` | a message with an attachment, or with a web address (`http://` or `https://`). Only messages (and, for `has:file`, files) are listed. |
| `is:thread` | a message that belongs to a thread (a reply, or a root with replies). Messages and threads are listed. |
| `before:2026-10-01`, `after:2026-10-01` | a day, year-month-day, read as UTC, from 0001-01-01 to 9998-12-31 (the database has no year 0000; a day outside that range stays plain text). `before:` is up to the start of that day, `after:` is from the day after it. |

At most five names after `from:` and five after `in:`. **`has:pin` is not supported**: pins do not exist yet (PLAN P9-09), so the word stays plain text until the pins table does.
A box holding only filter words is a search too (`from:nadia in:dev`): newest first, no ranking (score 0), by recency slices (one day, 16 days, all) like the text search.

**Names are resolved as the reader.** `from:` goes through `app.search_resolve_people` (a definer function that checks the caller with `lookup_workspace_role`): an owner, admin or member resolves
anyone in the workspace (the same set `people_select` shows), a guest only themself. `in:` reads `app.channels` through its policy, so a private channel the person is not in is "not found" exactly
as a channel that does not exist (`unmatched`); a name that matches nothing finds nothing (it is not turned into text). Filters only narrow: `p_in` is intersected with the reader's
readable channel set, never added to it.

**Cost.** A filter is one more condition on the plans above, so `from:`, `in:`, `before:`/`after:` and `is:thread` with a word cost what the word costs (`bench:search`, 300,000 messages: 40 to 60 ms median). A filter that
removes almost every hit of a common word pushes the search past the newest slices to the whole history (`has:link` on a corpus with no link at all: 360 ms at 300,000 messages, about 1 s expected at 1,000,000,
capped by `gin_fuzzy_search_limit`); with a realistic share of messages holding a link it is 70 ms. `bench:search` has six filter cases and puts a web address in one message in twenty.

**Counts.** Every list is built from rows the policies let the reader see, and `more.<kind>` only says that list went past `limit` (the functions are asked for `limit + 1` and the extra row is
dropped). No number counts anything before the policy has run, so a hit count cannot show a hidden hit; `test/search-filters.test.ts` checks that an outsider gets byte-for-byte the answer for a word
nobody wrote, even when 25 hidden messages match.

## Pages

Pages are the Markdown files under `pages/` of a team's repository. They are searched in `repo_entries` (repo-git; a trigram index on `text_plain` and on `path`), through the team read policy,
matched on the text and the name, scored by the better of the two. `from:` is the author of the commit that last changed the page, `before:`/`after:` its commit time. `GET /api/search?scope=pages` or
`all`. The hit carries `teamId`, `path`, `name`, `snippet` (the start of the text), `updatedAt`; the web opens it in Files (`/t/<team>/files?open=<path>`). `text_plain` is bounded to 1 MiB and
`path` to 1024 characters by constraint, so the LEAKPROOF mark of the trigram operators stays honest for this table too.

## Saved searches

`GET /api/search/saved`, `POST /api/search/saved` `{ name, query }`, `DELETE /api/search/saved/:id`. A saved search is a name (1 to 80 characters, one per person whatever the case) and the text of the
box (2 to 200); at most 50 per person. The table `app.saved_searches` has `owner_id`-only policies (not even an admin reads another person's list). It stores no result: the text runs again, as the
person who opens it, every time. The web client keeps the list under "Saved searches" in the results panel.

## Who finds what (no rule of its own)

The three functions are `SECURITY INVOKER`: they run as the caller, so every row is filtered by the hoisted read policies of `messages`, `threads` and `files`
(`channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])`), exactly as a plain `SELECT` is. A private channel's text is never found by a non-member (not by a team member, not
by a workspace admin who is not in it, not by a guest), a DM only by its two people, a guest only inside a grant, another team's channels never. The system role and a request without an
actor find nothing (`visible_channel_ids` is empty for them). The hit's channel comes from a second `SELECT` as the caller; a hit whose channel cannot be read would be dropped, though
the policy makes that impossible. `teamId` narrows and never widens.

The functions also repeat `channel_id = ANY(visible set)` as a plain predicate for messages. That is for the planner (it needs to see the caller's channels to choose the channel index); the
policy still applies on top and nothing is granted by it. `test/rls/search-rls.test.ts` checks, for every persona, that every hit is in `visible_channel_ids` and that the typo finds
the same channels as the exact word.

## Why it needs LEAKPROOF, and why messages are not one query

**Trigram under row level security (the finding of docs/retro/bench-phase-1.md).** A policy is a security barrier: the planner may give a user predicate to an index only when its function is
`LEAKPROOF`, otherwise it must run the policy first, row by row, and it falls back to a sequential scan with the GIN index present (2.3 s for 300,000 messages as a member). The pg_trgm
operators never fail on any text and reveal only their boolean, so the migration marks `word_similarity_op`, `word_similarity_commutator_op` and `similarity_op` `LEAKPROOF`. That needs a
superuser, which `manythreads_owner` is in compose and on CloudNativePG (MISTAKES P1-13); without it the migration warns and search still works, only slowly. A test asserts the flags and
that the planner picks the GIN index for all three tables as a member.

**Messages: three plans.** A common word matches tens of thousands of messages and ranking all of them cost 1.6 s at 1,000,000 messages (a heap fetch and a trigram comparison per row).
`app.search_messages` picks by what the caller reads and what the term matches (the migration's comment has the reasoning; numbers in [retro/phase-3.md](../retro/phase-3.md)):

1. A caller who can read at most 6,000 messages (a guest with one channel; counted through the `(channel_id, id)` index) has each row compared: bounded by the rows, whatever the term.
2. Otherwise, for one or two words, the newest slice is searched first through a `BitmapAnd` of the trigram index, the channel index and the primary key range (uuid v7 ids carry the time): one
   day, then 16 days. The first slice with `limit` hits is ranked and returned.
3. Fewer hits than that means the term is rare among what the caller reads: the whole history through the trigram index. `gin_fuzzy_search_limit` (30,000) caps the pathological case of a
   term that is common only in channels the caller cannot read; the answer is then a sample, never a leak. **A phrase of three words or more skips the slices** (`0003_phrase_plan.sql`): each
   slice costs a full trigram scan (about 100 ms at 1,000,000 messages) and a phrase at the 0.6 threshold is selective, so it goes straight to the whole history, ranked by similarity then
   newest, with `gin_fuzzy_search_limit` at 3,000 (a phrase of words most messages share is answered from a sample of the index rows). That took the benchmark's phrase from 292 ms to 182 ms median.

So **ranking is by similarity within the slice that answered**: a common word is answered from the last day, and an older but better spelled hit is not shown when the last day already holds
twenty. Plain index scans are switched off for the function because the planner mistakes `%>` for a cheap filter and walks a key range row by row (1.3 s); `uuidv7()` is evaluated once into a
variable because it is volatile (inside the query it is called per row and the range cannot use the index).

## Capabilities

`messages.search` and `files.search` (not destructive; manifest-declared, registered with the broker), input `{ query, teamId?, limit? }`, output `{ hits }` (the same hit shapes). They run in the
transaction of the asking actor, so the same policies decide what comes back; the gateway (phase 5) combines them with the bot's grants.

## Manifest

| Field | Value |
|---|---|
| name / version / kind | `search` / `0.1.0` / `server` |
| dependsOn | `channels`, `files`, `repo-git` (the functions read their tables) |
| capabilities | `messages.search`, `files.search` |
| migrations | `migrations` (`0001_search.sql`: the pg_trgm LEAKPROOF marks, type `app.search_message_hit`, functions `app.search_messages`, `app.search_threads`, `app.search_files`; `0002_leakproof_bounds.sql`: the length CHECKs that make LEAKPROOF true; `0003_phrase_plan.sql`: phrases scan the index once; `0004_filters_pages.sql`: the three functions take filter arguments, `app.search_pages`, `app.search_resolve_people`; `0005_saved_searches.sql`: the table) |

## Benchmark

`pnpm --filter @manythreads/tools-bench bench:search` loads 1,000,000 messages (200 channels, a word of the vocabulary in about 4%, a pseudo-word in 0.3%, one word in 0.05%), 50,000 threads and
20,000 files with the real schema and policies, then runs eight queries (typos, exact words, two words, a four-word phrase) as Nadia (110 channels, about half of the messages), Sameera (60 channels,
a third) and Lena (guest, one channel), checking p95 under 300 ms per persona (exit 1 otherwise). `BENCH_RUNS`, `BENCH_ROWS`, `BENCH_BUDGET_MS`, `BENCH_SETUP_ONLY=1` (keep the database for `psql`), `BENCH_REUSE=<db>`.

## Not here

Highlighting on the server (the snippet is the start of the text; the web client marks the words close to the query with the same trigram measure, `clients/web/src/search/highlight.ts`), pagination of results (a `limit` of 50 at most; `more` says a list went on), transcripts (phase 15 adds them to the same page), `has:pin` (no pins table yet), bots by name in `from:`, semantic search, a search for people and channels (the quick switcher), stemming and stop words (trigrams need neither).

## Tests

`test/search-filters.test.ts` (filters, filters-only searches, pages, saved searches, and the hidden-hit rules checked with a second person), `packages/shared/test/search-syntax.test.ts` (the parser, including hostile input), `test/search-api.test.ts` (typos, markdown, long messages, private channel, DM, other team, guest grant and revoke, edit and delete, ranking, slices on the small and the large plan with 6,500 filler
messages, threads, files, validation, hostile text), `test/rls/search-rls.test.ts` (`pnpm test:rls`), `e2e/api/search/trigram.spec.ts` (`pnpm e2e --project=api`).
