# P5-01 spike · slack-compat (Hermes replying in a channel thread)

Question (PLAN P5-01): how does a Hermes agent runtime deliver a reply into a
manythreads channel thread? Spike: a slack-shaped endpoint plus one Hermes
profile replying in a thread. Orchestrator decides; the full model-driven loop
lands in P5-10 (runtime-hermes).

## Decision

- **Hermes's bundled Slack platform cannot be repointed at us.** It is
  slack-bolt **Socket Mode** (`plugins/platforms/slack/plugin.yaml`
  requires `SLACK_BOT_TOKEN` xoxb + `SLACK_APP_TOKEN` xapp): it dials out to
  Slack's servers. There is no webhook-receiver mode to aim at manythreads.
- **Adopted shape: our door + their adapter.** Inbound to us is a narrow
  public route `POST /api/slack-compat/chat.postMessage` with Slack names on
  the wire (`chat.postMessage`, `thread_ts`, `ts`) so the Hermes side stays a
  thin POST. The pairing token in the body IS the credential (hashed, resolved
  server-side via `app.bots_pairing_resolve`; unknown/revoked is one 401).
  The route does no channel reads (an anonymous transaction sees no rows
  through RLS): it validates, resolves, and enqueues `slack-compat.deliver`.
  The SYSTEM job re-validates everything (channel/team/archive, thread root,
  bot actor) and lands the message idempotently on `meta.deliveryId`.
- **Outbound from Hermes is a plugin-path adapter** (`ctx.register_platform`,
  zero core changes): `~/.hermes/plugins/manythreads/` (`plugin.yaml` +
  `adapter.py`), reference copy in `docs/spikes/slack-compat-adapter/`
  (never vendored Hermes source — only our adapter). `send(chat_id,
  content, reply_to)` POSTs `{token, channel, thread_ts, text}`; `chat_id`
  is the channel id, `reply_to` the thread root. The adapter holds no
  provider key, Hindsight address or repo credential — the pairing token
  only, exactly the door P5-09's gateway will use.
- **Prompting the agent (inbound to Hermes)** goes through the generic
  `webhook` platform (HMAC-signed POST → prompt; `gateway/platforms/webhook.py`,
  default port 8644) in the full P5-10 loop. Wiring a live webhook→model→reply
  run needs a model behind LiteLLM (P5-06), so the spike drives `send()`
  directly and the model authorship is deferred — same precedent as P5-02's
  deferred two-run experiment.

## Proof (devbox, Hermes v0.21.5+6232, 2026-10-03)

1. **Door + job** (`packages/plugins/slack-compat/`, docs `docs/plugins/slack-compat.md`):
   `pnpm --filter @manythreads/plugin-slack-compat exec vitest run` → 2 passed:
   token delivers the bot reply into the thread (readable via the messages API,
   `channel.message.posted` emitted once), forged/revoked token is 401 and lands
   nothing.
2. **Adapter loads in Hermes**: `hermes plugins doctor ~/.hermes/plugins/manythreads`
   → `OK: runtime discovery, manifest parsing, import, and registration passed`.
   (Needed `__init__.py` re-exporting `register`, like every bundled adapter.)
3. **Wire shape** (`docs/spikes/slack-compat-adapter/prove_adapter.py`, run with
   `uv run --project ~/.hermes/hermes-agent python …`): `register()` fires into
   the real `platform_registry`, `Platform("manythreads")` resolves through the
   registry-backed `_missing_` hook, `connect()` ok, and `send()` POSTs exactly
   `{token, channel, thread_ts, text}` to `/api/slack-compat/chat.postMessage`
   → `ADAPTER SPIKE PROOF PASSED`. (A fake ctx is not enough: the Platform enum
   only gains the member once the real registry holds the entry.)
4. **Live loop** (`prove_live.mts`: `NODE_ENV=test pnpm exec tsx
   docs/spikes/slack-compat-adapter/prove_live.mts`, needs `pnpm db:up`):
   scratch server, template channels, `spikebot` row (template bots land in
   P5-19), minted pairing token (redacted everywhere), Nadia's root
   "What did the deploy change?", then the REAL `ManythreadsAdapter.send()`
   delivers; the reply reads back in the thread as the bot:

   ```text
   directory status=200 groups=Channels:general,dev,releases,incidents,alerts,standup
   adapter: delivered ts=<delivery-id>
   thread #dev reply author=bot(spikebot)
   thread #dev reply body="[spike P5-01] the deploy changed the loader (via the Hermes manythreads adapter)"
   LIVE LOOP PROOF PASSED: Hermes adapter -> door -> thread, readable via the messages API
   ```

## Status

The plugin is a spike: it is not auto-loaded in production (`MANYTHREADS_SPIKE_SLACK_COMPAT=1` opts in; test servers load
it), posts to public team channels only and only for an `active` bot. P5-10 replaces it with the real runtime door.

## For P5-09 / P5-10

- Reuse the door's auth (pairing token → `app.bots_pairing_resolve`) for the
  per-run MCP endpoint (P5-02 decision); reuse the SYSTEM delivery validation.
- The spike handler writes `app.messages` directly — P5-10 must reuse the
  channels behaviour (route shape or SDK service), never copy the insert.
- Productize the adapter (config surface, `reply_to_mode`, webhook inbound,
  cron/home channel) from the reference copy; keep the no-credential invariant
  (pairing/run token only) — the phase-5 exit gates on it.

## Non-goals

No model call in the spike (devbox holds no model credential: `hermes auth list`
empty, no key env); no LiteLLM/Hindsight wiring (P5-06/P5-12); no Slack API
beyond the three wire names.
