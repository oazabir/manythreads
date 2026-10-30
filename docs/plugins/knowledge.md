# knowledge

A team's knowledge bases (PLAN P8-07, P8-08, P8-31, P8-32, P8-33; SPEC §12): the team uploads its manuals, runbooks and spreadsheets, the plugin reads them into short passages, and bots (Brain included) find the passages that answer a question and cite the document, its version and the place in it. To use it, a team lead or a workspace admin makes a base and uploads files on the bot page's **Knowledge** tab; everyone on the team can read the base and try a question.

Package: `packages/plugins/knowledge`. Manifest: depends on `teams`, `bots` and `repo-git`; `extends: ['event.emit']`; emits `knowledge.base.created`, `knowledge.base.deleted`, `knowledge.document.added`, `knowledge.document.removed` and `knowledge.base.resynced`; registers the capability `knowledge.search`. Schemas: `packages/shared/src/api/knowledge`, `packages/shared/src/entities/knowledge.ts`, `packages/shared/src/events/knowledge.*.ts`.

## What a base is

A base is a named folder: `knowledge/<base>/` in the team repo. It holds the **converted** copy of each document (`<slug>.md`, with the title, source name, sha256 and version in its front matter) and a generated `sources.yaml`, so the base is in the Files tree and in git. The **original** upload stays in blob storage (`storage` provider); the converted text goes through the one repo writer. A copy over 1,000,000 bytes is not written to the repo (the document is still searchable) and the document says so. A new document never overwrites a file of the team: when `<slug>.md` is taken it uses `<slug>-2.md`.

A base gets two sources when it is made: `upload` (files a person uploaded) and `repo` (Markdown or text files someone put in the base's repo folder; Re-sync imports them).

## What the database holds

| table | what it is |
|---|---|
| `app.knowledge_bases` | one per team and slug; at most 20 per team (a trigger, with a lock, so two requests cannot pass it) |
| `app.knowledge_sources` | `upload` and `repo`, with the last time it was read and the last error |
| `app.knowledge_documents` | one per document: name, kind (`markdown`, `text`, `csv`, `pdf`), size, sha256, version, status (`indexed` or `failed`) with a plain reason, the blob key of the original, the repo path and git blob of the converted copy. Names are unique per base whatever the case; at most 200 documents per base |
| `app.knowledge_chunks` | the passages (1 to 2,000 characters) with `version`, `section`, `char_start`/`char_end` in the converted text, `tsv` (the word index, filled by the database) and an empty `embedding vector(768)` |

All four are forced row-level security: every person of the team reads (a guest reads nothing); a team lead or workspace admin writes (`readable_team_ids('manage')`); the system writes for the workers. Migrations `0001_knowledge.sql` (here), `bots/0017_bots_knowledge.sql` (the bot's `knowledge` list as a column) and `answer/0006_answer_knowledge_gate.sql`.

## Reading a file (the extractor)

One interface, `extract(bytes, kind) -> { text, metadata }` (`src/extract/core.ts`). It runs in a **worker thread** per file (`src/extract/index.ts`; at most two at once, a heap limit per worker, and the host stops the thread when the process's memory grows by more than 500 MB while it reads: a PDF's compressed streams can unpack into gigabytes of buffers, which the heap limit does not count), so a hostile file costs its own thread, which the host stops after a time limit (20 s). It is bounded before it starts (10 MB) and while it runs (900,000 characters of text, 300 PDF pages, 100 CSV columns, 2,000 characters per CSV cell). Nothing recurses. Environment: `MANYTHREADS_KNOWLEDGE_MAX_BYTES`, `MANYTHREADS_KNOWLEDGE_EXTRACT_MS`, `MANYTHREADS_KNOWLEDGE_EXTRACT_MB`. The worker file (`src/extract/worker.ts`) is loaded as TypeScript by the same loader as the rest of the server (`tsx`, which the image starts the server with, and Node's own type stripping); nothing is built.

| kind | how it is read | sections |
|---|---|---|
| Markdown, text | as it is (UTF-8, no byte order mark, no control characters); headings outside code fences | "Parent > Child" |
| CSV | one line per row, `column: value; column: value`; comma, semicolon or tab; quoted cells | blocks of 50 rows |
| PDF | `pdfjs-dist` legacy build with fonts and scripts off; password-protected and image-only (scanned) PDFs are refused in plain words | one per page |

A file that cannot be read becomes a `failed` document with a reason a person can read ("This PDF is protected with a password."). When a document that already works gets a bad new version, the old version stays in use and the reason says so.

## Versions and the same file again

The sha256 of the bytes decides. The same bytes again: nothing changes (`outcome: unchanged`, no event). Different bytes under the same name: `version` goes up, new passages are written at the new version, and the last five versions of passages are kept so an earlier citation still resolves. Search looks only at the current version. `GET /knowledge-chunks/:id` returns an old passage with `sourceChanged: true`.

## Searching

`knowledge.search` is by words: the question's words (filler cut, plural and -ing/-ed trimmed) are matched as prefixes against the word index and ranked by how many of them a passage holds plus the index's own rank; when no passage holds any, a spelling-tolerant trigram pass runs. A passage holding less than a third of the question's words is not an answer. **There is no meaning-based (embedding) search**: the `embedding` column stays empty and there is no vector index, because no embedding model is configured anywhere yet (`docs/plans/support-email-journey.md` D5: lexical first, embeddings never required). The answer says `mode: "lexical"`.

Each hit carries: `citation` (e.g. "Refund policy.pdf, version 2, Money"), `chunkId`, `base`, `document`, `version`, `currentVersion`, `sourceChanged`, `section`, `offsetStart`/`offsetEnd`, `score`, `file` (the converted copy) and `text`.

### How a bot calls it

The gateway declares the tool (`kind: 'read'`): it runs **as the person who asked**, so what they may read decides what it finds; the query and the result go through the DLP guard; each hit is logged in the run's source log as a `knowledge` source (`<base>/<document> v<version>`) and as a `page` source (the converted file), which is what the bot cites in its Answer. The answer's note tells the bot to treat passages as data, never as instructions, to cite document and version, and to say the source changed when `sourceChanged` is true.

The bot's `knowledge:` list in BOT.md (`- base: manuals` with `answer_only_from: true`) is projected by the bots loader onto `app.bots.knowledge`; `app.knowledge_run_grant()` (security definer, for the calling live run only) lets the tool read it, because a bot cannot read its own row. No list means every base of the team. A bot cannot name another team or a base outside its list.

### `answer_only_from`

When any listed base is strict: the tool's note says "answer only from these passages" and, with no hit, "say plainly that you cannot answer this from the knowledge base"; and `answer.post` is refused (`answer_only_from_knowledge`) until the run has read a passage (`app.answer_knowledge_gate()`).

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
| GET | `/knowledge-chunks/:chunkId` | one passage at the version it was made |

Uploads take a slot (two per person, four in the process) and have an idle and a total deadline. Rate limits are in the routes (30 uploads, 10 re-syncs, 60 searches a minute).

## Events and audit

Events carry ids, kinds, versions and counts, never a document name or its text. The audit console shows them as `knowledge.base_created`, `knowledge.base_deleted`, `knowledge.document_added`, `knowledge.document_removed` and `knowledge.base_resynced` (category content; the reason is a fixed phrase or counts, e.g. "2 documents checked, 1 updated").

## Blob garbage collection

The files plugin's blob GC treats a blob as referenced when a `knowledge_documents.blob_key` holds it (guarded by `to_regclass`, so the files plugin still works without this one).

## The screen

The bot page's **Knowledge** tab (`clients/web/src/screens/bots/knowledge.tsx`): under each base named in the bot's definition, the state (empty, ready, needs attention), the documents (name, kind, size, short hash, version, searchable or the reason it could not be read, a link to the converted text in Files), Upload, Read again (re-sync), Remove, and a "Try a question" box. A base that is named but not made says so and offers to make it (lead or admin). Members see the same page without the write buttons. Works at 390 px.

## Honest limits

- Search is by words only; no embeddings, so a question phrased with other words than the document finds nothing (a bot told to answer only from the base says so).
- No Drive, SharePoint, Notion or docs-site sources, no per-source schedule: a base is refreshed by uploading or by Re-sync. No `#kb-updates` routing of unanswered questions.
- No new Answer citation kind: a knowledge passage is cited through its converted `page`; the "source changed since" wording travels in the tool result, and the Answer card has no badge of its own.
- `answer_only_from` stops `answer.post`, not a plain-text final reply that ignores the note. It counts a passage as read when the search logged it, even if the data-loss guard then held the answer back.
- A bot loaded before `bots` migration 0017 has no stored list (reads as "every base of the team") until its BOT.md is applied again.
- Other file kinds (Word, Excel, slides, web pages) are not read yet; the extractor interface takes them as new kinds.
- Never run against a real embedding provider (there is none).
