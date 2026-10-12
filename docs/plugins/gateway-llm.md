# gateway-llm

The workspace's door to the models (SPEC §10.1, PLAN P5-06). One LiteLLM proxy runs beside the server; this plugin owns its
configuration and mints a virtual key per bot.

## Where the package lives

PLAN.md writes `packages/gateway-llm`. The server's `discoverPlugins` only scans `packages/plugins/*`, and a plugin must carry
a `manythreads.entry` in its `package.json` (P5-03/P5-04 recorded the same deviation), so the package is
**`packages/plugins/gateway-llm`**.

## What the database holds

| table | rls | what it is |
|---|---|---|
| `app.llm_providers` | workspace | one row per configured model provider. The API key is `secret_id` — envelope-encrypted in `app.secrets`, never a column, exactly as a sign-in provider's client secret (kernel 0004/0007). |
| `app.llm_aliases` | workspace | one row per bound alias. The alias set is closed by a CHECK: `smart fast code local embed vision image transcribe`. `fallbacks` is at most three of those, never the alias itself. |
| `app.llm_keys` | workspace | one live virtual key per bot. `secret_id` is the key, `key_prefix` its non-secret head. No foreign key to `app.bots`, so the row outlives the bot long enough for the revoke job (below). |
| `app.llm_limits` | workspace | one row per limit target: budgets workspace → team → bot → session and the rate limit beside them (P5-07). A row carries a spend cap, a calls-per-minute cap, or both. |
| `app.llm_settings` | workspace | one row per workspace: the guard preset, the hosts `strict-egress` may reach, and the caching flag. A workspace with no row runs the default (`standard`, caching on). |
| `app.llm_spend` | workspace | the append-only ledger of what model calls cost, one line per call (P5-07). |

Only workspace **owners and admins** read or write the config, limit and settings tables (the same rule as the sign-in
provider admin API). A member or a guest sees no row at all; the spend ledger is read by admins too, and only the system
role writes a line of it. The kernel's security docs describe the `provider.llm` door this plugin declares for
`ctx.secrets` (`docs/plugins/security.md`).

## Aliases, never models

A bot's profile names an alias (SPEC §10.2). The plugin expands each alias into LiteLLM's `model_list`:

```yaml
model_list:
  - model_name: smart
    litellm_params: { model: anthropic/claude-sonnet-4, api_key: <decrypted> }
fallbacks:
  - smart: [fast]
```

A `model` that already contains `/` is used as written; otherwise the provider's kind supplies the prefix (`openai`,
`anthropic`, `azure`, `bedrock`, `gemini`, `ollama`). A disabled provider's aliases are pushed as deletions, and because the
alias set is closed the plugin always knows the whole universe, so a stale model cannot linger.

## Routes

Workspace-admin only, mounted under `/api/workspace/llm`:

| method | path |
|---|---|
| GET/POST | `/providers` |
| PATCH/DELETE | `/providers/:providerId` |
| GET | `/aliases` |
| PUT/DELETE | `/aliases/:alias` |
| GET/PUT | `/limits` |
| DELETE | `/limits/:limitId` |
| GET/PUT | `/settings` |
| GET | `/spend` |

Every write commits the row and enqueues `gateway-llm.apply-config` in the same transaction; the job reads the rows back,
decrypts the keys (a system transaction — `ctx.secrets.get` refuses any other) and pushes the document. The response says
whether a provider has a stored secret, never the secret.

The web page (`screens/admin/llm`) and the onboarding step that first fills this in are P5-08/P5-22; the plate is
`docs/spec/mockups-all.html` §01 plate 7.

## Keys: minted with the bot, deleted with it

- `bots.bot.loaded` → enqueue `gateway-llm.sync-key` `{ action: 'mint' }`.
- `bots.bot.removed` → enqueue `gateway-llm.sync-key` `{ action: 'revoke' }`.

The subscriber only enqueues: an event subscriber runs inside the outbox transaction, and a network call has no business
there. The job mints a caller-chosen key (`sk-` + 24 random bytes, base64url), stores it through `ctx.secrets`, records
`key_prefix`, and registers it with the proxy (`POST /key/generate`) limited to the workspace's bound aliases. Revoking goes
the other way: `POST /key/delete`, then the secret and the row go. Both are idempotent, so an event replay or a job retry
changes nothing twice.

A daily reconcile (`gateway-llm.reconcile`, 03:23 UTC) mints what is missing, revokes what is orphaned — a bot deleted while
its job was dead-lettered leaves a key behind — and re-queues the config push. That is what makes the guarantee self-healing.

`provider.llm` is how a runtime gets the key: `ctx.providers.get<LlmProviderServices>('llm').botKey(tx, botId)`, in a system
transaction. P5-09/P5-10 use it to point a bot's profile at the gateway with the bot's own key.

## Budgets, rate limits and the spend ledger (P5-07)

Every scope of SPEC §10.1 is a row: workspace, team, bot and session ("session" is the runtime's own session id — a
conversation or a run). A workspace, team or bot budget counts its calendar window (`day` or `month`, UTC); a session
budget counts the whole session, so the session id is its window. Rate limits are calls per minute at the same scopes.

`provider.llm.preflight(tx, request)` is the gate, and a runtime calls it before each model call. It answers a decision —
never an exception — so a run can log it and stop cleanly:

1. the preset's egress rule (`air-gapped` allows the `local` alias only; `strict-egress` needs the target host on the
   workspace's allowlist; a local endpoint is never egress and needs no entry),
2. the pre-call DLP hook (below),
3. every applicable limit, narrowest scope first: session → bot → team → workspace, and at each scope the budget before
   the rate limit. The narrowest exhausted scope is the one the refusal names.

A refusal writes one event: `llm.budget.exceeded` (`reason` `budget` or `rate`) or `llm.guard.decided` (`reason` `preset`
or `dlp`). Neither carries the prompt. The rate counters live in the process (PLAN D3: in-memory sliding window per
replica, never the database), so they are per-replica and a restart forgets them — a budget is the durable limit, the rate
limit is the courtesy one.

`recordSpend(tx, line)` appends to `app.llm_spend` *after* a call (prompt tokens, completion tokens, dollars, the alias
and the model). The ledger is append-only: the application role has no UPDATE or DELETE grant, and the policy set gives no
role an UPDATE policy, so neither a caller nor an admin can rewrite what a call cost. `GET /spend` rolls it up for the
workspace page; the default range is the current month.

A budget is checked against what has been recorded, so a single call can still cross the line (the platform never
estimates a model call's price). That is the honest reading of "enforced before the call": the next call is refused.

## Presets and the pre-call hook (P5-07)

The four presets of SPEC §15 are data (`LLM_GUARD_PRESETS` in `packages/shared/src/entities/llm-limits.ts`), so the page of
P5-08 and this hook read one definition:

| preset | egress | on a detection |
|---|---|---|
| `standard` | any configured provider | `redact` |
| `strict-egress` | hosts on the workspace allowlist | `redact` |
| `air-gapped` | the `local` alias only | `redact` |
| `customer-facing` | any configured provider | `block` |

The hook (`src/dlp.ts`) is plain string work with a bounded quantifier per detector: a private-key header, an API key
(`sk-…`, `AKIA…`, `ghp_…`, `xox…`), a `Bearer` token, a URL with credentials in it, and a card number (13–19 digits with
separators, confirmed by Luhn so a long id is not a card). `redact` answers the text with each span replaced by
`[redacted:<rule>]` and the call continues; `block` refuses it and the text is unchanged. Rules are names, never the
matched text: the event, the decision and the audit line carry `api-key`, not the key.

`require_approval` is in SPEC §15's vocabulary but no preset uses it yet: it needs the approvals plugin of P5-20, which
owns the pending-approval path. Until then the hook answers `allow`, `redact` or `block`.

## Without a proxy

With `MANYTHREADS_LITELLM_URL` unset the gateway mints and stores keys and records the config, but pushes nothing (the
apply-config job logs the omission). That keeps a dev box and the test suite working with no proxy; `pnpm llm:up` starts one
(compose profile `llm`, `deploy/compose/litellm.yaml`, keys in the `litellm` database of the dev Postgres).
