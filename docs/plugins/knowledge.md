# knowledge

A team's knowledge bases (PLAN P8-07, P8-08, P8-31, P8-32, P8-33; SPEC §12): the team uploads its manuals, runbooks and spreadsheets, the plugin reads them into short passages, and bots (Brain included) find the passages that answer a question and cite the document, its version and the place in it. To use it, a team lead or a workspace admin makes a base and uploads files on the bot page's **Knowledge** tab; everyone on the team can read the base and try a question.

Package: `packages/plugins/knowledge`. Manifest: depends on `teams`, `bots` and `repo-git`; `extends: ['event.emit', 'job.register', 'hook.pre_egress']` (the rhythm jobs, and the egress guard before a web page is read); emits `knowledge.base.created`, `knowledge.base.deleted`, `knowledge.document.added`, `knowledge.document.removed` and `knowledge.base.resynced`; registers the capability `knowledge.search`. Schemas: `packages/shared/src/api/knowledge`, `packages/shared/src/entities/knowledge.ts`, `packages/shared/src/events/knowledge.*.ts`.

## What a base is

A base is a named folder: `knowledge/<base>/` in the team repo. It holds the **converted** copy of each document (`<slug>.md`, with the title, source (`upload`, `repo` or `url`), sha256 and version in its front matter) and a generated `sources.yaml`, so the base is in the Files tree and in git. The **original** upload stays in blob storage (`storage` provider); the converted text goes through the one repo writer. A copy over 1,000,000 bytes is not written to the repo (the document is still searchable) and the document says so. A new document never overwrites a file of the team: when `<slug>.md` is taken it uses `<slug>-2.md`.

A base gets two sources when it is made: `upload` (files a person uploaded) and `repo` (Markdown or text files someone put in the base's repo folder; Re-sync imports them). A lead or admin can add **web page** sources (`url`, at most 20 per base): the platform reads the address on a rhythm (see "Sources, rhythm and state"). Drive, SharePoint and Notion sources wait for the Phase 8 connections; they cannot be tested without an external account.

## What the database holds

| table | what it is |
|---|---|
| `app.knowledge_bases` | one per team and slug; at most 20 per team (a trigger, with a lock, so two requests cannot pass it). `status` (`empty`, `ready`, `attention`) is kept by triggers on documents and sources, not computed by the page |
| `app.knowledge_sources` | `upload`, `repo` and `url`: the last time it was read, the last error, `sync_minutes` (null or 15 to 10,080), and for `url` the address and a label. One `upload` and one `repo` per base; a `url` source is unique per base and address |
| `app.knowledge_documents` | one per document: name, kind (`markdown`, `text`, `csv`, `pdf`), size, sha256, version, status (`indexed` or `failed`) with a plain reason, the blob key of the original, the repo path and git blob of the converted copy. Names are unique per base whatever the case; at most 200 documents per base |
| `app.knowledge_chunks` | the passages (1 to 2,000 characters) with `version`, `section`, `char_start`/`char_end` in the converted text, `tsv` (the word index, filled by the database) and an empty `embedding vector(768)` with a partial HNSW index (`WHERE embedding IS NOT NULL`, cosine; migration `0002`), so it costs nothing until a passage gets a vector |
| `app.knowledge_gaps` | questions a strict bot could not answer, one line per team, question and day (at most 100 open per team); `outcome` says what became of it (`posted`, `no_channel`, `no_author`). Inserted by a team reader, read by a lead or admin, changed only by the system |

All five are forced row-level security: every person of the team reads (a guest reads nothing); a team lead or workspace admin writes (`readable_team_ids('manage')`); the system writes for the workers. Migrations `0001_knowledge.sql`, `0002_knowledge_vector_index.sql` and `0003_knowledge_rhythm.sql` (here: sources with a rhythm and web pages, the stored base status, the gaps table, and `app.knowledge_act_as_bot`, a definer function the gaps job uses to write as a bot), `bots/0017_bots_knowledge.sql` (the bot's `knowledge` list as a column) and `answer/0006_answer_knowledge_gate.sql`.

## Reading a file (the extractor)

One interface, `extract(bytes, kind) -> { text, metadata }` (`packages/sdk/src/extract/core.ts`; the extractor lives in the SDK since P8-16 so the team memory inbox reads files the same way, and `packages/plugins/knowledge/src/extract` only re-exports it). It runs in a **worker thread** per file (`packages/sdk/src/extract/index.ts`; at most two at once, a heap limit per worker, and the host stops the thread when the process's memory grows by more than 500 MB while it reads: a PDF's compressed streams can unpack into gigabytes of buffers, which the heap limit does not count), so a hostile file costs its own thread, which the host stops after a time limit (20 s). It is bounded before it starts (10 MB) and while it runs (900,000 characters of text, 300 PDF pages, 100 CSV columns, 2,000 characters per CSV cell). Nothing recurses. Environment: `MANYTHREADS_KNOWLEDGE_MAX_BYTES`, `MANYTHREADS_KNOWLEDGE_EXTRACT_MS`, `MANYTHREADS_KNOWLEDGE_EXTRACT_MB`. The worker file (`packages/sdk/src/extract/worker.ts`, erasable TypeScript only) is loaded as TypeScript by the same loader as the rest of the server (`tsx`, which the image starts the server with, and Node's own type stripping); nothing is built.

| kind | how it is read | sections |
|---|---|---|
| Markdown, text | as it is (UTF-8, no byte order mark, no control characters); headings outside code fences | "Parent > Child" |
| CSV | one line per row, `column: value; column: value`; comma, semicolon or tab; quoted cells | blocks of 50 rows |
| PDF | `pdfjs-dist` legacy build with fonts and scripts off; password-protected and image-only (scanned) PDFs are refused in plain words | one per page |
| Web page (HTML) | only for a `url` source, never an upload: one left-to-right scan, no parser tree. Scripts, styles, iframes, forms, navigation, footers and comments are dropped, entities decoded, headings and list items kept as Markdown | "Parent > Child" |

A file that cannot be read becomes a `failed` document with a reason a person can read ("This PDF is protected with a password."). When a document that already works gets a bad new version, the old version stays in use and the reason says so.

## Versions and the same file again

The sha256 of the bytes decides. The same bytes again: nothing changes (`outcome: unchanged`, no event). Different bytes under the same name: `version` goes up, new passages are written at the new version, and the last five versions of passages are kept so an earlier citation still resolves. Search looks only at the current version. `GET /knowledge-chunks/:id` returns an old passage with `sourceChanged: true`. A web page is compared by its **text** after conversion, so markup or a script that changes on every load is not a new version.

## Searching

`knowledge.search` is by words: the question's words (filler cut, plural and -ing/-ed trimmed) are matched as prefixes against the word index and ranked by how many of them a passage holds plus the index's own rank; when no passage holds any, a spelling-tolerant trigram pass runs. A passage holding less than a third of the question's words is not an answer. 

**Meaning-based search is built but dormant.** The model gateway's `embed` alias exists in its configuration (LiteLLM), but the gateway gives plugins no way to call it yet. `src/embed.ts` is the door: when `ctx.providers.get('llm')` carries an `embed(tx, { workspaceId, texts, purpose })` method (answering 768-number vectors), the `knowledge.embed` job (every 10 minutes) fills the `embedding` of current passages, the question is embedded too, and the nearest passages (cosine, at least 0.35) are merged with the word matches by reciprocal-rank fusion; the answer then says `mode: "hybrid"`. Without that method nothing is embedded and every workspace searches by words (`mode: "lexical"`), as `docs/plans/support-email-journey.md` D5 says. A refusal, a wrong number of vectors or a wrong length stops the pass and writes nothing.

Each hit carries: `citation` (e.g. "Refund policy.pdf, version 2, Money"), `chunkId`, `base`, `document`, `version`, `currentVersion`, `sourceChanged`, `section`, `offsetStart`/`offsetEnd`, `score`, `file` (the converted copy) and `text`.

### How a bot calls it

The gateway declares the tool (`kind: 'read'`): it runs **as the person who asked**, so what they may read decides what it finds; the query and the result go through the DLP guard; each hit is logged in the run's source log as a `knowledge` source (`<base>/<document> v<version>`) and as a `page` source (the converted file), which is what the bot cites in its Answer. The answer's note tells the bot to treat passages as data, never as instructions, to cite document and version, and to say the source changed when `sourceChanged` is true.

The bot's `knowledge:` list in BOT.md (`- base: manuals` with `answer_only_from: true`) is projected by the bots loader onto `app.bots.knowledge`; `app.knowledge_run_grant()` (security definer, for the calling live run only) lets the tool read it, because a bot cannot read its own row. No list means every base of the team. A bot cannot name another team or a base outside its list.

### `answer_only_from`

When any listed base is strict: the tool's note says "answer only from these passages" and, with no hit, "say plainly that you cannot answer this from the knowledge base"; and `answer.post` is refused (`answer_only_from_knowledge`) until the run has read a passage (`app.answer_knowledge_gate()`).

**Unanswered questions go to #kb-updates.** A strict bot's search with no hit records one line in `knowledge_gaps` (the question cleaned to one line with no markup that could ping; the day and team make it unique, so a question asked all day is one line). The `knowledge.gaps` job (every 5 minutes, per workspace) posts one note per team to the channel named `kb-updates`, listing up to 10 questions and the bot that was asked, written by the first bot that asked (through `app.knowledge_act_as_bot`, because a message needs an author). A team with no such channel is not an error: the lines are marked `no_channel` and nothing is posted. The `answer_only_from_knowledge` refusal in `answer.post` records nothing, because the question is known only to the search.

## Routes

All under `/api/teams/:slug`, team members read, lead or admin writes:

| method | path | what |
|---|---|---|
| GET | `/knowledge` | the team's bases, `canWrite`, `searchMode` |
| POST | `/knowledge` | `{ slug, name? }`: make a base (`201`; `409` for a repeat or the 20-base cap) |
| GET / DELETE | `/knowledge/:base` | the base with its documents / remove it with its documents, passages and stored originals; the converted copies stay in the team repo for the team to delete |
| POST | `/knowledge/:base/documents?name=` | raw body upload (octet-stream); `200` with `outcome` `added`, `updated`, `unchanged` or `failed`; `413` over the size limit, `415` for a type nothing reads, `400` empty |
| DELETE | `/knowledge/:base/documents/:id` | remove a document and its originals |
| POST | `/knowledge/:base/resync` | read the repo folder again: edits made in the repo become the next version, new Markdown files are imported, files that vanished are removed, failed documents are retried |
| GET | `/knowledge/:base/search?q=&limit=` | the same search a bot gets, for the "Try a question" box |
| POST | `/knowledge/:base/sources` | `{ url, label?, syncMinutes? }`: add a web page source. The first read happens now, so an address that cannot be read is refused (`400`) with the reason and nothing is saved; `201` with the source; `409` for a repeat or the 20-page cap |
| PATCH | `/knowledge/:base/sources/:sourceId` | `{ syncMinutes }` (null or 15 to 10,080): change the rhythm |
| DELETE | `/knowledge/:base/sources/:sourceId` | remove a web page source with its document |
| GET | `/knowledge-chunks/:chunkId` | one passage at the version it was made |

Uploads take a slot (two per person, four in the process) and have an idle and a total deadline. Rate limits are in the routes (30 uploads, 10 re-syncs, 60 searches a minute).

## A person's own bases (Personal space)

A person can keep knowledge bases of their own: documents only they (and the bots they allow) can search. A Personal base is one row set owned by a person instead of a team (migration `0004_personal_bases.sql`: `owner_person_id` beside `team_id` on the four tables, exactly one of the two set). The original stays in blob storage like a team's, but nothing is written to a team repo: `repo_path` stays empty, and there is no repo source. Row-level security (the database rule that decides which rows a caller sees) follows the shared space rule: the owner reads and writes; a workspace admin who holds a live, audited "open" of that person's space reads but never writes; nobody else sees a row, and a guest has no Personal space.

Routes, all under `/api/me/knowledge` and acting as the signed-in person:

| method | path | what |
|---|---|---|
| GET / POST | `/api/me/knowledge` | my bases / `{ slug, name? }` make one (`409` for a repeat or the cap) |
| GET / DELETE | `/api/me/knowledge/:base` | one base with its documents / remove it with its documents and stored originals |
| POST | `/api/me/knowledge/:base/documents?name=` | raw upload, same outcomes and limits as a team base |
| DELETE | `/api/me/knowledge/:base/documents/:documentId` | remove one document |
| GET | `/api/me/knowledge/:base/search?q=&limit=` | search my own base |

Not built yet: web page sources and source removal for Personal bases (the contract names `POST /api/me/knowledge/:base/sources` and `DELETE .../sources/:sourceId`); a Personal base has no reading rhythm of its own.

**What a bot may read.** The `knowledge.search` tool no longer takes a team from the model. It asks the database for the run's space list (`app.run_space_context()`, see `docs/plugins/gateway-mcp.md`, "What a run may read: spaces") and searches exactly those: the run's teams, plus the asker's Personal space when that person has allowed this bot (`personal_allowed`). A bot whose definition lists a `knowledge:` allowlist searches only those named bases of its own team, never Personal and never another team. Each hit carries `space` (`person:<id>` or `team:<id>`) so a citation says where a passage came from, and the gateway's source line for a Personal hit has scope `person`.

## Sources, rhythm and state

Each source has an optional rhythm (`sync_minutes`: every 15 minutes up to every week; null means only when someone presses Read again). Three detached jobs, each run for one workspace at a time as the system role (a message, a repo write and an event belong to one workspace), safe to run twice and bounded:

| job | when | what |
|---|---|---|
| `knowledge.sync` | every 5 minutes | reads the sources that are due, at most 5 per workspace per pass: a `url` source is fetched and moved on; an `upload` or `repo` source re-reads the base's folder and retries failed documents |
| `knowledge.embed` | every 10 minutes | gives passages a vector when the gateway has an embedding model; does nothing otherwise |
| `knowledge.gaps` | every 5 minutes | posts the open unanswered questions to `#kb-updates` |

A web page is fetched with the SDK's `safeFetch` (public addresses only, ports 80 and 443, redirects re-checked, one 15 s clock, the size cap), after the `pre_egress` chain has been asked about every address it reaches (destination `knowledge_source`: an air-gapped workspace reads nothing, a strict one only its allowed hosts; with no guard loaded the read fails closed). The page goes through the same bounded extractor in a worker thread. Same text: nothing changes. New text: the next version and new passages (older versions stay for citations). A page that cannot be read at a later pass leaves the last good version in use and puts a plain reason on the source.

The base's **state** is stored (`knowledge_bases.status`): `empty` with no document, `attention` when any document failed or any source has an error, otherwise `ready`. Triggers keep it up to date, so the Knowledge tab and the list of bases agree.

## Events and audit

Events carry ids, kinds, versions and counts, never a document name or its text. The audit console shows them as `knowledge.base_created`, `knowledge.base_deleted`, `knowledge.document_added`, `knowledge.document_removed` and `knowledge.base_resynced` (category content; the reason is a fixed phrase or counts, e.g. "2 documents checked, 1 updated").

## Blob garbage collection

The files plugin's blob GC treats a blob as referenced when a `knowledge_documents.blob_key` holds it (guarded by `to_regclass`, so the files plugin still works without this one).

## The screen

The bot page's **Knowledge** tab (`clients/web/src/screens/bots/knowledge.tsx`): under each base named in the bot's definition, the state (empty, ready, needs attention: a document or a source could not be read), the Sources (the base's uploads and folder, and each web page with when it was read, why it failed, a rhythm picker and Remove; an "Add a web page" form for a lead or admin), the documents (name, kind, size, short hash, version, searchable or the reason it could not be read, a link to the converted text in Files), Upload, Read again (re-sync), Remove, and a "Try a question" box. A base that is named but not made says so and offers to make it (lead or admin). Members see the same page without the write buttons. Works at 390 px.

## Honest limits

- Search is by words until the model gateway offers an `embed` method (see Searching); until then a question phrased with other words than the document finds nothing (a bot told to answer only from the base says so). The vector index is a partial HNSW index created in `0002`, not "only when an embed alias exists" as the plan wording had it; it is empty and free until a passage gets a vector.
- Web pages are read, not crawled: one address is one document. No Drive, SharePoint or Notion sources: they need the Phase 8 connections.
- No new Answer citation kind: a knowledge passage is cited through its converted `page`. The Answer card's **Sources reached** row for a knowledge passage (`<base>/<document> v<n>`) asks the base for the document's version as the reader and shows "the source has changed since" (or "no longer in the knowledge base") when it moved on; a reader who cannot open the base sees nothing extra.
- `answer_only_from` stops `answer.post`, not a plain-text final reply that ignores the note. It counts a passage as read when the search logged it, even if the data-loss guard then held the answer back.
- A bot loaded before `bots` migration 0017 has no stored list (reads as "every base of the team") until its BOT.md is applied again.
- Word, slides, spreadsheets and email are read by the extractor (`docx`, `pptx`, `xlsx`, `eml`; see `docs/plugins/memory-inbox.md`), but a knowledge base does not accept those kinds yet: its upload still takes Markdown, text, CSV and PDF.
- Never run against a real embedding provider (there is none); the embed door is tested with a fake.
- `sources.yaml` in the base's folder is generated and written only; the plugin does not read it back.
