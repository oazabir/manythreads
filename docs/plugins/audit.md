# audit

The audit console: a screen where a workspace admin answers "who did what, when, to what, and what was withheld", filters the answer, and exports it as a signed file. It needs no setup; the plugin builds its rows by itself from what the server already records. The screen is **Settings → Workspace → Audit** (`/settings/workspace/audit`), next to System health. Admins only (PLAN P10-05, SPEC §15 and §18).

Package: `packages/plugins/audit`. Manifest: `extends: ['event.subscribe', 'event.emit', 'job.register', 'secret.seal']`, `dependsOn: ['bots', 'channels', 'memory']`, emits `audit.export.created`. Schemas: `packages/shared/src/{entities/audit.ts,api/audit,events/audit.export.created.ts}`.

## Not a second truth

The event log (`app.events`, every change the server makes, written in the same transaction as the change) stays the record. The `app.audit_events` table is a **projection**: a copy of the events worth auditing, reshaped into one plain row each, so a query does not have to understand sixty event types. The row's id is the id of the event it came from, so building it twice cannot make two rows, and a row can always be traced back to its event. Two things build rows:

- **A live subscriber** takes each audited event type as the outbox hands it over (the outbox is the queue of events written with the change and passed on afterwards). `src/spec.ts` holds the one table that says which event types are audited and how each becomes a row; an event type that is not listed there is not audited.
- **A job every minute** (`audit.sweep`) does what a subscriber cannot: it reads the memory plugin's retain log for lines marked `withheld` (a memory the feed kept back from someone), two minutes behind so a line is settled before it is copied, and it fills in history once, in batches, from events that existed before the plugin was installed.

## What a row holds

Actor (who: person or bot, with the name at the time), action (a fixed word such as `proposal.applied`, with a label), target kind and id and a short label, the team, the time, the outcome (`ok`, `denied`, `failed` or `withheld`) and a short plain reason (at most 200 characters). The source of the row (`event` or `memory_retain_log`) is kept too.

**Rows are content-blind.** A row never holds message text, file content, a page body, a secret, a memory's text, an IP address or a file name from the files area. Reasons are written by the mapper from fixed phrases, enums and counts ("Wrong password", "3 sources held back"), never copied from a payload. Two kinds of text do appear, because a row is useless without them: the **names** of things an admin set up (a person, bot, team, channel, Hermes connection or the workspace) and the **definition path** of a proposal, which is `TEAM.md` or a name under `bots/`, `skills/` or `routines/`. A path anywhere else (a denied write to `memory/…`, `channels/…`) is cut to its top folder, and a guarded path with anything but plain file-name characters is cut to its folder too. Names are copied as typed, so an admin should not put a secret in a team or connection name. `test/spec.test.ts` puts canary strings into every free-text field of every audited event and fails if one reaches a row; `test/audit.test.ts` scans every row and the export file from real flows for the same canaries.

## Who may read it

**Workspace owners and admins only.** A team lead does not see the console, and neither does anyone else: the table's row-level security (RLS, the database rule that filters rows per caller) lets a row through only to the system role or to an owner or admin of the row's own workspace, and the routes check the role again (`403` for a member, `401` signed out). The reasoning: the log holds sign-ins and what happened in every team, which is a workspace-level view; a lead's view of their own team can be added later as a filter on the same table. Rows cannot be changed or removed by any role the server uses (`UPDATE`, `DELETE` and `TRUNCATE` are revoked), and the table is not partitioned by month: the repo's other append-only tables (`app.events`, the memory retain log) are plain tables with a BRIN index (a small index that suits a column that grows with time), and this one follows them. Pruning, if ever needed, is retention's job ([retention.md](./retention.md)), and the plugin does not prune.

## Routes

| Route | What |
|---|---|
| `GET /api/admin/audit` | One page, newest first. Filters: `actor`, `category`, `action`, `team`, `targetKind`, `targetId` (ids and codes: letters, digits, `_ . : -`), `outcome`, `from` (inclusive), `to` (exclusive; years 0001 to 9999 only), `cursor`, `limit` (default 50, most 200). Returns `{ entries, nextCursor }`; `nextCursor` is null on the last page. |
| `POST /api/admin/audit/export` | The same filters (and `after`, to continue a cut-off export) in a strict body. Answers the file (below). 30 requests a minute per client, and one at a time per workspace (a second one while the first is being built answers 429). |
| `GET /api/admin/audit/signing-key` | The workspace's public key: `{ keyId, algorithm: 'ed25519', publicKeyPem, createdAt }`. |

## The export, and how an auditor checks it

The file is NDJSON (one JSON object per line): the first line is the manifest (`kind: 'manythreads.audit.export'`, `version`, `workspaceId`, `generatedAt`, the filters, `rowCount`, `truncated`, `resumeAfter`, `contentBlind: true`, the signature's `algorithm` and `keyId`), then one entry per line, oldest first. The cap is 20,000 rows; when the filter matches more, `truncated` is true and `resumeAfter` is the `after` value for the next file. `MANYTHREADS_AUDIT_EXPORT_MAX_ROWS` lowers the cap (it never raises it).

The signature is **ed25519** (a modern public-key signature) **over the exact bytes of the file**, so changing a word, dropping a row or reordering lines breaks it. The response carries it as base64 in `x-audit-signature`, with `x-audit-key-id` and `x-audit-sha256` (the file's SHA-256). Each workspace has its own key pair, made the first time it is needed; the private half is sealed in the secrets store and never leaves the server. The export itself writes an audit row (`audit.exported`, who, how many rows, truncated or not) through the `audit.export.created` event.

To check a file offline, with the public key from the signing-key route or the console's "Save public key" button (saved as `audit-key.pem`) and the signature saved as `audit.ndjson.sig`:

```sh
base64 -d < audit.ndjson.sig > audit.ndjson.sig.bin
openssl pkeyutl -verify -pubin -inkey audit-key.pem -rawin -in audit.ndjson -sigfile audit.ndjson.sig.bin
# Signature Verified Successfully   (a changed file prints "Signature Verification Failure" and exits 1)
```

**Is the file complete?** The manifest is inside the signed bytes, so these are checked together with the signature: the number of entry lines equals `rowCount`; `truncated: false` means the file holds every matching row that existed at `generatedAt`; `truncated: true` means more follow, and the next file's manifest must show `filters.after` equal to this file's `resumeAfter`, so a missing file in a series shows as a gap in that chain. Cutting lines off the end of one file, or its manifest, breaks the signature. A row can appear after a file was made with an id older than the file's last row (a memory line is copied two minutes late, and an event is projected a moment after it happens), so an export that follows `resumeAfter` over a long time can miss such a row; export the whole range again to be certain.

The same in Node: `crypto.verify(null, fileBytes, crypto.createPublicKey(pem), Buffer.from(signatureBase64, 'base64'))` returns true or false. **Key lifecycle:** there is no rotation or removal. The key lives as long as the workspace; keep the public key beside each export you archive. If the private half were ever lost the signing route would fail rather than make a new key silently, and replacing it is an operator task (delete the row in `audit_signing_keys`, after which the next export makes a new key and the old exports still verify with the old public key). The key id (the first 16 hex digits of the SHA-256 of the public key) is in the manifest and in the header, so a key that was ever replaced can be told apart.

## The screen

A filter bar (who, group, did what, team, outcome, from, to, Clear filters), a table (time in UTC, who, did what, to what, team, outcome), a **Withheld** badge on rows whose outcome is withheld, "Show older" for the next page, and an Export button that saves the file and then offers the signature, the public key and the commands above. With no match it says so. At 720 px and narrower the filters stack and each table row becomes a card; nothing scrolls sideways. Styles are in `clients/web/src/styles/audit.css` (class prefix `audit-`).

## If a row cannot be written

All subscribers of one event run in one database transaction. The audit subscriber therefore never builds a value the table would refuse: every text is cut to its column's limit without splitting a character, and the mappings only produce enum words, ids and codes. A write that fails anyway rolls the event back for every subscriber, and the outbox retries it, so nothing is silently dropped, but the failure is shared; fix the mapping rather than catching the error.

## Policy changes (P10-04)

`guardrails.policy.updated` becomes `guard.policy_changed` (category guardrails): who changed the data-loss policy or a team's host list, the kind (`dlp_policy` or `egress_policy`), the detector, rule or team code as the target label and a fixed reason ("rule added (data-loss check)"). The matched text is never involved; the event only carries names. The data-loss and egress decision events also carry the team now.

## Setup and model tests (P10-01)

`llm.alias.tested` becomes `model_alias.tested` (the alias as the label, the outcome and the cause code as the reason), `onboarding.step.marked` becomes `setup.step_marked`, `onboarding.goal.launched` becomes `setup.goal_launched` and `onboarding.checklist.dismissed` becomes `setup.checklist_dismissed` (all category settings). The question a person asks Brain in their first goal is never in an event.

## Knowledge (P8-07)

`knowledge.base.created`, `.base.deleted`, `.document.added`, `.document.removed` and `.base.resynced` become `knowledge.base_created`, `knowledge.base_deleted`, `knowledge.document_added`, `knowledge.document_removed` and `knowledge.base_resynced`. The target is the base (with its slug as the label) or the document (id only: a document name is not in the event); the reason is a fixed phrase with counts ("New version 2, 4 passages", "3 documents checked, 1 updated, ..."). A document that could not be read shows as a failed outcome.

## Left out on purpose

Message posted and edited, reactions, reading state, presence, notifications, tasks and boards, rhythms, run starts and ends, conversations starting, `ops.health.changed`, and `repo.committed` (the guarded paths are covered by proposals) are not audited: they are volume or content, not decisions. Also not built: a CSV export, a bot filter in the screen (the Who list holds people; the API takes a bot id), team-lead access, and rows for the inbox and digest withheld items (those features do not exist yet).

## Rules to keep

- A new audited event is one entry in `MAPPERS` (`src/spec.ts`), one name in the manifest's `consumes`, one label in `AUDIT_ACTIONS` (`packages/shared/src/entities/audit.ts`) and a canary line in `test/spec.test.ts`. Never copy free text from a payload into `reason` or `label`.
- A new action or outcome word changes an enum: update the migration's CHECK, the Zod enum and `ENUM_COLUMNS` in `packages/kernel/test/schema-enums.test.ts` together.
- Keep the table append-only for every role the server uses.
