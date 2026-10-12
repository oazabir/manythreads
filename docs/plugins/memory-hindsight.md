# memory-hindsight

Team memory on Hindsight (SPEC §12.1, PLAN P5-12 and P5-15). One bank per team, `team:<slug>`; the bank is **derived by the platform**, never chosen by a bot or passed by a plugin. The plugin registers the `memory` provider (`provider.memory`, `MemoryProvider` in `@manythreads/sdk`) and the two tools a bot's run has, `memory.recall` and `memory.retain`. Feeding the bank from team activity is P5-13, the git mirror of the OKF bundle is P5-14, `memory.write` is P5-26: all three call this provider.

Package: `packages/plugins/memory-hindsight` (PLAN writes `plugins/memory-hindsight`; same `discoverPlugins` deviation as the other plugins).

## Where the bank comes from

| Caller | How the bank is found | Guard |
|---|---|---|
| A bot's run (the two tools; later `memory.write`) | `provider.forRun(tx)` calls `app.memory_run_scope()` (migration `0001`), a definer function that answers for the one run the transaction carries (`app.run_id()`, set only by the kernel run service in `asBot` / `asReader`) with the team that run was opened for — which the **pairing token** fixed when the run was minted — and the team's slug | live runs only (`status = 'running'`, `ended_at IS NULL`); `app.actor()` must be the run's bot or the person who asked; no row otherwise → `MemoryError('no_run')` |
| The platform (P5-13 feeding, P5-14 mirror) | `provider.forTeam(tx, teamId)` reads the slug from `app.teams` | `tx.actor.kind === 'system'` **and** `app.is_system()` in the query (the role, not a setting): a transaction that only claims to be the system gets no team (`unknown_team`) |

No input anywhere has a `bank`, `team` or `workspace` field. Every input schema is strict, and `refuseBankFields` runs first: a key matching `bank|team|workspace|tenant` (any case, any spelling: `bank_id`, `teamId`, `memoryBank`) answers `bank_not_allowed` before anything else is looked at (keys only; values are text). On the MCP face the tools' `inputSchema` has `additionalProperties: false` and no such property, so a model is never shown a place to put one. A bot cannot name a **document** either: the tool derives `run:<runId>:<hash of content>` (a repeat of the same call is an upsert; a bot cannot replace a fact that is not its own). Only the platform's `forTeam` bank takes a `documentId` (concept path + content hash, P5-14).

What the platform stamps on everything a run retains (after the caller's own metadata, so it cannot be overridden): `source` (`run`/`platform`), `team` (slug), `run_id`, `bot_id`. Tags the bot supplies are lowercase words; the `mt:` prefix is reserved.

## The tools

`memory.recall {query, limit?, tags?}` → `{ok: true, bank, hits: [{id, text, type, context, tags, documentId}]}`. A *read* tool in gateway-mcp: it runs as the asker (else the bot), and a successful answer writes one `run_source_log` line `memory` / `bank:team:<slug>` / scope `team`.

`memory.retain {content, context?, tags?}` → `{ok: true, bank, retained}`. A *write* tool (runs as the bot). **Refused with `person_scoped`** when the run's source log has any `person` line — a run that read something private to one person may recall from the team bank but never adds to it (SPEC §12.1). That is the person half of the narrowest-source rule; the channel-privacy half and the `memory_retain_log` are P5-13.

Refusals are answers (`{ok: false, code, message}`), not errors: `bank_not_allowed`, `invalid_arguments`, `person_scoped`, `no_run`, `not_configured`, `unavailable`. Both tools need a grant (`memory.recall`, `memory.retain` in BOT.md `capabilities`); the broker decides, and `tools/list` offers only what the bot may call.

## Configuration

`MANYTHREADS_HINDSIGHT_URL` (unset = off: the tools answer `not_configured`, nothing else changes) and `MANYTHREADS_HINDSIGHT_API_KEY` (the engine's `HINDSIGHT_API_TENANT_API_KEY`). Both are read per call.

## The engine in compose

`deploy/compose/docker-compose.dev.yml`, profile `memory`: `pnpm memory:up` / `pnpm memory:down` (`deploy/compose/memory-up.sh` creates the `hindsight` database on a Postgres volume that predates `deploy/postgres/init/20-hindsight-db.sql`). Image `ghcr.io/vectorize-io/hindsight:0.10.3` (override with `MANYTHREADS_HINDSIGHT_TAG`), its own database `hindsight` in the dev Postgres (pgvector is already in `manythreads/postgres:19`), the built-in API-key tenant extension on, facts extracted by an LLM through the LiteLLM proxy (alias `fast`, `MANYTHREADS_HINDSIGHT_LLM_*`; start `pnpm llm:up` and bind the alias). Embeddings are the engine's local model (downloaded on first start).

**Reachable only from the gateway, in this phase, by network:** the container is on the compose network `memory` and nothing else; only postgres, litellm and the manythreads server (profile `app`) join `memory`. Verified on the devbox: a container on `compose_default` (where the Hermes workers of phase 10 will live) cannot resolve `hindsight` (`gaierror`), one on `compose_memory` gets `/health` 200. The loopback port `127.0.0.1:8888` is a dev convenience so tests and a host-run server can reach the engine; the self-host compose and the Helm chart (P6-00/P10-07, with NetworkPolicy checks) must not publish it. The control-plane UI (9999) is not published: it would show every team's bank.

## Observed Hindsight behaviour (0.10.3)

Recorded against the real container, in `chunks` extraction mode (each retained item stored as-is, no LLM; `MANYTHREADS_HINDSIGHT_EXTRACTION_MODE=chunks MANYTHREADS_HINDSIGHT_SKIP_LLM_VERIFICATION=true pnpm memory:up`). `test/hindsight.integration.test.ts` keeps them honest (`MANYTHREADS_TEST_HINDSIGHT_URL=http://127.0.0.1:8888 pnpm exec vitest run packages/plugins/memory-hindsight/test/hindsight.integration.test.ts`).

| Call | Answer |
|---|---|
| `GET /health` | 200 `{"status":"healthy","database":"connected",…}` with or without a key |
| any other route without the key / with a wrong one | 401 `{"detail":"Authentication failed: Invalid API key"}` |
| `POST /v1/default/banks/team%3Aprobe/memories/recall` on a bank never created | **404** `Bank 'team:probe' not found` |
| `PUT /v1/default/banks/{bank}` `{}` | 200 the bank (`bank_id`, `name`, `disposition`, `mission`, `background`); a repeat is 200 again |
| `POST …/memories` `{items:[{content, context?, tags?, metadata?, document_id?}], async?}` | 200 `{success, bank_id, items_count, async, operation_id, usage}`; `async:true` → `operation_id` set, `usage:null`; no `items` → 422 |
| `POST …/memories/recall` `{query, max_tokens?, tags?}` | 200 `{results:[{id, text, type:"world", context, mentioned_at, document_id, metadata, chunk_id, tags, scores, …}], …}`; `metadata` and `tags` round-trip; `tags:["nope"]` → `results: []` |
| a recall in bank B with bank A's exact words | **B's own nearest fact at a near-zero score, none of A's** — the engine always ranks the bank it was asked about, so "gets nothing from the other team" means "nothing of the other bank's content", not "an empty answer" |
| retain again under an existing `document_id` | replaces the document's facts |
| `DELETE …/documents/{id}` | 200 `{success, message, document_id, memory_units_deleted}`; unknown id (bank exists or not) → 404 `Document not found` |
| a bank id with `/` (`team%2Fx`) | routing 404 (slugs cannot contain one) |
| `GET /v1/default/banks` | lists every bank (with `fact_count`): an admin route the API key unlocks, which is why only the server holds the key |

The client creates a bank (`PUT`) before the first call on it per process, and creates it once more if a call 404s with "Bank … not found" (the engine's database was wiped while the server ran).

## Tests

* `test/client.test.ts` (8), `test/provider.test.ts` (23): injected transport and a stub transaction — paths and encoding, the lost-bank retry, derivation, provenance stamping, `forTeam` for the system only, the forged-key table (12 spellings × recall/retain/forget), no engine, engine down.
* `test/cross-team/cross-team.test.ts` (38) — **`pnpm test:memory-cross-team`**, its own vitest project (`memory-cross-team`), a step in `.github/workflows/ci.yml` next to `test:rls`/`test:events`/`test:schema-compat`. A real server and database, the real MCP endpoint and pairing tokens, `tools/fake-hindsight` as the engine (one store per bank, records which bank every request named). Team B's bot retains a fact; team A's bot asking for B's exact words gets no hits; every request made on A's behalf names `team:engineering` only; 12 forged spellings on recall and on retain are refused and the engine is not called / B's bank is unchanged; document ids cannot be named; the tools' schemas have no bank-like property; the pairing token fixes the run's team; a person-asked run reads its team's bank; the source log gets `bank:team:<slug>`; a person-scoped run cannot retain; a finished run's token is refused; no engine → `not_configured`; no grant → not offered, `forbidden`; `app.memory_run_scope()` is empty outside a run.
* `test/hindsight.integration.test.ts` (9, opt-in) — the real container; also the provider end to end across two banks.
* `tools/fake-hindsight/test` (3). `pnpm -C tools/fake-hindsight start` runs the fake on :8888 for a dev server with no container.

## Not here (later tasks)

Feeding the bank from messages, threads, runs, approvals, pages, handovers and the full narrowest-source rule with `memory_retain_log` (P5-13); the OKF git mirror — re-retain on `memory/` commits, forget on delete/`deprecated` (P5-14); `memory.write` (P5-26); `describe_self`. Helm values and NetworkPolicy for Hindsight (P6-00/P10-07). The "one Hindsight per team" deployment option (§12.1): the provider's client is looked up per call, so a per-team URL is a change to `client()` in `src/index.ts` and nothing else.
