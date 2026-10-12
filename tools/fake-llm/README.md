# fake-llm

A LiteLLM proxy that is not LiteLLM. It speaks the management API the `gateway-llm` plugin drives, so the gateway's
config push and bot-key minting can be exercised without a proxy container, a model provider or an API key.

Two jobs:

1. **A test double for the wire.** Every other test of the gateway's LiteLLM client injects a transport, which proves the
   client's logic but nothing about the protocol. This server is the other end of the socket, so the paths, the JSON
   bodies, the bearer header and the status codes are verified against something that answers — and answers awkwardly,
   the way the real proxy does.
2. **A dev stand-in.** Point a workspace at it and the config push and per-bot keys really happen; the aliases appear
   and the keys are minted, all in memory.

## Run it

```
pnpm -C tools/fake-llm start                 # http://127.0.0.1:4000
FAKE_LLM_PORT=4123 FAKE_LLM_MASTER_KEY=sk-fake pnpm -C tools/fake-llm start
```

Then aim the gateway at it (`deploy/compose/dev.env.example` documents both variables):

```
MANYTHREADS_LITELLM_URL=http://127.0.0.1:4000
MANYTHREADS_LITELLM_MASTER_KEY=sk-fake
```

With no `FAKE_LLM_MASTER_KEY`, the management endpoints are open — convenient in dev, and never what a test does.

This is not a replacement for [the real thing](https://docs.litellm.ai/docs/proxy/model_management): the repo's compose
profile runs actual LiteLLM (`pnpm llm:up`). fake-llm is for when that container cannot be pulled, when a call path
needs to be proven with no provider behind it, and for the test suite.

## What it implements

| Endpoint | Answers |
|---|---|
| `POST /model/new` | `201`, or `400 "already exists"` when the model is there — the client turns that into `/model/update` |
| `POST /model/update` | `200`, or `400` when the model is not there |
| `POST /model/delete` | `200`, or `404` when the model is gone |
| `POST /config/update` | `200`; keeps the `router_settings.fallbacks` it was sent |
| `POST /key/generate` | `201`, or `400 "already exists"` for a key already minted |
| `POST /key/delete` | `200`, or `404` when nothing was deleted |
| `GET /health/readiness`, `/health/liveliness` | `200`, no key required — a probe has no credential to send |
| `POST /chat/completions` | A canned completion with `usage` (12 prompt / 7 completion tokens). **No auth check** — it exists to prove a call path, not to be a provider |
| `GET /state` | The models, keys, fallback chains and a call count, for a test to read back |

Management paths require `Authorization: Bearer <master key>` when a key is configured. An unknown path under `/model/`
answers **401 before 404**, deliberately: telling an unauthenticated caller whether a route exists would be an
information leak.

## In vitest

`test/fake-llm.test.ts` starts it on an ephemeral port and drives the real client from
`packages/plugins/gateway-llm/src/litellm.ts` over HTTP: a config push, a second push that must take the
"already exists" path, key mint/revoke twice over, a refused master key, and the disabled client with no URL.
The state is inspected after each call, so the assertions are on what the client actually sent.

```ts
const fake = await startFakeLlm({ masterKey: 'sk-fake' });
const gateway = createLiteLlmClient({ baseUrl: fake.url, masterKey: 'sk-fake' });
await gateway.applyConfig(doc);
expect([...fake.state.models.keys()]).toEqual(['fast', 'smart']);
await fake.close();
```

## What it does not do

No model traffic beyond that one canned completion, no token accounting, no budget enforcement, no persistence: a
restart is a clean proxy. The limits the gateway enforces are its own — `llm_spend`, the sliding window and the guard
presets live in the plugin's tests, not here.
