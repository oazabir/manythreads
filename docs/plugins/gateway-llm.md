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
`anthropic`, `azure`, `bedrock`, `gemini`, `ollama`). A disabled provider's aliases are not pushed, and because the
alias set is closed the plugin always knows the whole universe, so a stale model cannot linger. Deleting a provider deletes its
aliases with it (a model with no key would be pushed and fail at the provider); a fallback chain names only aliases the proxy
has.

### What the real proxy does (LiteLLM 1.105, `main-stable`)

Checked against the container, and kept honest by the env-gated `test/litellm.integration.test.ts`:

* `POST /model/new` of an existing `model_name` is a **200 that adds a second deployment** (the proxy then load-balances across
  both) — it is not "already exists". The client therefore gives every deployment an id of its own (`mt-<alias>`), lists
  `GET /model/info`, **updates by id** (`POST /model/update` with `model_info.id`) or creates, and deletes any other deployment
  under an alias name (an unbound alias, a deleted provider's model, a duplicate an older push left) with `POST /model/delete
  { id }`. Repeating a push changes nothing.
* Delete of an unknown id is a **400** ("not found in db"), not 404; update of an unknown id is a 400; a repeated explicit id on
  create is a 500 (the client turns it into an update).
* `POST /config/update` refuses (400) any `router_settings` key the config *file* names, so `deploy/compose/litellm.yaml` has no
  `router_settings`: the fallback chains are the database's.
* A key's `models: []` means **every model**: the client refuses to send an empty list. `/key/generate` of an existing key is a 200;
  `/key/update` and `/key/delete` of an unknown key are 404 (and `/key/info` answers from a cache for a moment after a delete).
* Errors echo request fields, so `LiteLlmError` scrubs `sk-…`, key-ish fields, bearer tokens and long token-looking runs.

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

Every write commits the row and enqueues `gateway-llm.apply-config` in the same transaction (deduped while one is ready or running; the job fingerprints its rows before and after the push and queues one follow-up when they changed meanwhile, so an edit made mid-push is not lost); the job reads the rows back,
decrypts the keys (a system transaction — `ctx.secrets.get` refuses any other) and pushes the document. The response says
whether a provider has a stored secret, never the secret.

The web page (`screens/admin/llm`) and the onboarding step that first fills this in are P5-08/P5-22; the plate is
`docs/spec/mockups-all.html` §01 plate 7.

## Keys: minted with the bot, deleted with it

- `bots.bot.loaded` → enqueue `gateway-llm.sync-key` `{ action: 'mint' }` (deduped per definition sha, so an edit made while an earlier sync runs is not swallowed).
- `bots.bot.removed` → enqueue `gateway-llm.sync-key` `{ action: 'revoke' }`.

The subscriber only enqueues: an event subscriber runs inside the outbox transaction, and a network call has no business
there. The job mints a caller-chosen key (`sk-` + 24 random bytes, base64url), stores it through `ctx.secrets`, records
`key_prefix`, and registers it with the proxy (`POST /key/generate`) limited to **the aliases the bot's own `BOT.md` names** (`model.aliases` and
`model.fallbacks`, kept on `bots.model_aliases` by the loader) that the workspace has bound, plus their fallback chains — never
the whole workspace set, and never an empty list (a bot with nothing bound has no key until one is: every config push re-syncs
the workspace's keys, `/key/update` when the set moved, a revoke when it emptied; `llm_keys.models` remembers what the proxy was told). Revoking goes
the other way: `POST /key/delete`, then the secret and the row go. Both are idempotent, so an event replay or a job retry
changes nothing twice.

A daily reconcile (`gateway-llm.reconcile`, 03:23 UTC) syncs every active hermes bot's key (mint, update or revoke), revokes what is orphaned — a bot deleted while
its job was dead-lettered leaves a key behind — and re-queues the config push. That is what makes the guarantee self-healing. Syncs of one bot are serialised by `pg_advisory_xact_lock(hashtext('llm-key:' || bot_id))`, so two jobs that both saw "no key" cannot each mint one (an orphaned secret and a stray proxy key). A bot loaded before `bots` migration 0008 has an empty `model_aliases` and so no key: the bots plugin's own daily job fills it from `BOT.md` and re-announces `bots.bot.loaded`, which is what mints it (see [bots.md](./bots.md)).

`provider.llm` is how a runtime gets the key: `ctx.providers.get<LlmProviderServices>('llm').botKey(tx, botId)`, in a system
transaction. P5-09/P5-10 use it to point a bot's profile at the gateway with the bot's own key.

## Budgets, rate limits and the spend ledger (P5-07)

Every scope of SPEC §10.1 is a row: workspace, team, bot and session ("session" is the runtime's own session id — a
conversation or a run). A workspace, team or bot budget counts its calendar window (`day` or `month`, UTC); a session
budget counts the whole session, so the session id is its window. Rate limits are calls per minute at the same scopes.

`provider.llm.preflight(tx, request)` is the gate, and a runtime calls it before each model call. It answers a decision —
never an exception — so a run can log it and stop cleanly:

1. the guardrails: the `pre_egress` chain ([guardrails-dlp](./guardrails-dlp.md), [guardrails-egress](./guardrails-egress.md)) — first the preset's egress
   rule over the alias **and its whole fallback chain** (`air-gapped` allows the `local` alias only **and only when it really is local** — a provider the admin marked, or a loopback host; host, not name; `strict-egress` needs the target host on the
   workspace's allowlist; a local endpoint is never egress and needs no entry), then the DLP check (below). The gateway describes the call (alias, every link of
   the chain with the host it reaches, the preset, the allowlist, the text) and obeys the answer; with no guardrail loaded the call is refused (`dependsOn`
   makes that unreachable in a server),
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

The hook is `guardrails-dlp`'s (P5-21 moved it out of this plugin; the detectors, `redact` and `block` are described in [guardrails-dlp.md](./guardrails-dlp.md)). The preset
data stays here and in `@manythreads/shared`; the gateway passes the preset's name with the call, so the guardrails and the page of P5-08 read one definition. The gateway still
writes `llm.guard.decided` itself (it alone knows the alias and the bot) and tells the guardrails not to write theirs (`recorded: true`).

`require_approval` (SPEC §15) is a **bot's** choice, not a preset's: a request carries `dlpMode` — `hold` when the bot's `guard.rules` carries
`dlp:require_approval`, `approved` for the call a person has since approved, the preset's own rule otherwise. In `hold` mode a finding answers
`allowed: false`, `outcome: 'require_approval'`, `reason: 'dlp'` and `text` = the **redacted** text (what an approver may be shown); the runtime
files the approval through the approvals plugin ([approvals](./approvals.md)) and stops the run. In `approved` mode the finding passes as written,
but a preset that refuses outright (`customer-facing`) still refuses, and the egress and budget checks still apply. `llm.guard.decided` is emitted
for the hold like any non-`allow` outcome.

## What "local" means (migration 0004) and the classifier call (P5-11)

**"Local" is one thing**, answered by `loadEgress` (`EgressTarget.local`) and read by every rule that cares: the `strict-egress` allowlist does not apply to a local target, the `air-gapped` preset accepts only
a local one, and the gate's classifier runs only on one. A target is local when **the admin said so** — `llm_providers.local` (migration `0004_provider_local.sql`, `NOT NULL DEFAULT false`; the checkbox
"Runs inside this deployment — never egress" on Workspace → LLM → Model providers, `data-testid="llm-provider-local"`, and a Local switch per row) — **or** its host is loopback (`localhost`, `127.0.0.1`, `::1`,
which is what a provider-less `ollama/…` model string and an `ollama` provider with no base URL resolve to). Nothing else is inferred: an in-cluster Service (`*.svc`, `*.cluster.local`) or a LAN address is the
network's business, which the platform cannot see, so it is local only when marked; an unknown host is not local. The column is covered by the table's existing admin-only policies and grants.

`provider.llm.classify(tx, request)` is the call the gate's classifier makes ([runtime-hermes](./runtime-hermes.md)). It is not a general "complete": what makes it safe with a person's message is inside it
and no caller can switch it off. The alias is `local`; the alias **and every link of its fallback chain** must be local (above), else the answer is `unavailable` and nothing is sent (SPEC §7.3: the classifier
never uses a remote provider; an admin can bind `local` to a hosted one); only `piece` 0 of a message is a hit on the rate limit (later pieces count against budgets). Then the same pre-call check as any call (the
guardrails see the **text** and only the text — the fixed system turn is ours —, the bot's budgets and rate limits count it), `POST /chat/completions` on the proxy with the **master key** (not the bot's virtual key,
whose allowed aliases are the bot's business), and a line on the ledger (`llm_spend`, alias `local`, tokens as the proxy reported them, cost 0). It never throws for an unavailable model; it answers
`{ ok: false, reason }` — `refused` (with the decision: a budget, a rate limit, the preset, a detection), `unbound` (the alias is bound to nothing) or `unavailable` (not local, no proxy URL, an error, a
timeout, an answer with no text; the detail is scrubbed of anything credential-shaped) — and the caller decides what that means.

## Without a proxy

With `MANYTHREADS_LITELLM_URL` unset the gateway mints and stores keys and records the config, but pushes nothing (the
apply-config job logs the omission). That keeps a dev box and the test suite working with no proxy; `pnpm llm:up` starts one
(compose profile `llm`, `deploy/compose/litellm.yaml`, keys in the `litellm` database of the dev Postgres).
