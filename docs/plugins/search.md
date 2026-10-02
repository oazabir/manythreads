# search

Search over messages, thread titles and file names: `GET /api/search` and the capabilities `messages.search` and `files.search` (SPEC section 12, PLAN P3-10, criterion 6).
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

Hits come best score first, newest first among equal scores. Each kind has its own list (`messages`, `threads`, `files`), each at most `limit` (1 to 50, default 20); a scope that leaves a
kind out gives an empty list. Query: 2 to 200 characters after trimming, whitespace collapsed (`q`), `scope` `messages|threads|files|all`, optional `teamId` (only channels of that team).
Wildcards, quotes and backslashes are plain characters: the text is a bound parameter of a trigram operator, never a pattern or SQL. 120 requests per minute per caller.

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
2. Otherwise the newest slice is searched first through a `BitmapAnd` of the trigram index, the channel index and the primary key range (uuid v7 ids carry the time): one day, then 16 days (a
   phrase of three words pays for the trigram scan once per slice, so it gets the day only). The first slice with `limit` hits is ranked and returned.
3. Fewer hits than that means the term is rare among what the caller reads: the whole history through the trigram index. `gin_fuzzy_search_limit` (30,000) caps the pathological case of a
   term that is common only in channels the caller cannot read; the answer is then a sample, never a leak.

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
| dependsOn | `channels`, `files` (the functions read their tables) |
| capabilities | `messages.search`, `files.search` |
| migrations | `migrations` (`0001_search.sql`: the pg_trgm LEAKPROOF marks, type `app.search_message_hit`, functions `app.search_messages`, `app.search_threads`, `app.search_files`) |

## Benchmark

`pnpm --filter @manythreads/tools-bench bench:search` loads 1,000,000 messages (200 channels, a word of the vocabulary in about 4%, a pseudo-word in 0.3%, one word in 0.05%), 50,000 threads and
20,000 files with the real schema and policies, then runs eight queries (typos, exact words, two words, a four-word phrase) as Nadia (110 channels, about half of the messages), Sameera (60 channels,
a third) and Lena (guest, one channel), checking p95 under 300 ms per persona (exit 1 otherwise). `BENCH_RUNS`, `BENCH_ROWS`, `BENCH_BUDGET_MS`, `BENCH_SETUP_ONLY=1` (keep the database for `psql`), `BENCH_REUSE=<db>`.

## Not here

Highlighting on the server (the snippet is the start of the text; the web client marks the words close to the query with the same trigram measure, `clients/web/src/search/highlight.ts`), pagination of results (a `limit` of 50 at most), page text and repo files (phase 4 adds `repo_entries` to the same
functions), semantic search, a search for people and channels (the quick switcher), stemming and stop words (trigrams need neither).

## Tests

`test/search-api.test.ts` (typos, markdown, long messages, private channel, DM, other team, guest grant and revoke, edit and delete, ranking, slices on the small and the large plan with 6,500 filler
messages, threads, files, validation, hostile text), `test/rls/search-rls.test.ts` (`pnpm test:rls`), `e2e/api/search/trigram.spec.ts` (`pnpm e2e --project=api`).
