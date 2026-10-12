# guardrails-dlp

The content half of the `pre_egress` chain (SPEC §15, PLAN P5-21). Whatever is about to leave the platform passes the hooks the guardrails plugins registered, and the chain answers one of
four outcomes: `allow`, `redact`, `require_approval`, `block`. This plugin reads **what the text carries**; [guardrails-egress](./guardrails-egress.md) reads **where it is going**. Basic on purpose:
secrets and card numbers with the four presets. The full DLP of phase 10 (personal data, custom regex, the MCP gateway) is P10-04 and extends this plugin, not the caller.

## The chain (`hook.pre_egress`)

```ts
// a guard: register a hook (needs `hook.pre_egress` in `extends`)
ctx.hooks.preEgress((input, tx) => ({ outcome: 'redact', text: input.text.replace(…), rules: ['my-rule'] }));  // or nothing: no objection

// a caller: describe what would leave, obey the answer (needs `hook.pre_egress` in `extends` too)
const decision = await ctx.hooks.runPreEgress(tx, { destination: 'email', workspaceId, text, preset: 'standard', targets, allowlist });
if (decision.hooks === 0) refuse();                 // nothing guards this destination: do not send it unguarded
if (decision.outcome === 'block') refuse(decision.message);
if (decision.outcome === 'require_approval') holdForApproval(decision.text);   // the redacted text is what an approver may see
send(decision.text);                                // redacted for `redact`
```

Types are in `@manythreads/sdk` (`src/egress.ts`), the chain in `packages/kernel/src/plugins/egress.ts`. Rules of the chain, each pinned by `kernel/test/plugins/egress-chain.test.ts`:

* hooks run in **load order** on the text the hooks before them left (a redaction is what the next hook sees); `dependsOn` fixes the order (`guardrails-egress`, then `guardrails-dlp`, then callers);
* the **strongest outcome wins** (`allow` < `redact` < `require_approval` < `block`); a later hook can raise it, never lower it; rules accumulate once each;
* a **`block` ends the chain** and keeps the original text; the verdict's `reason` is `preset` (the workspace's egress rule) or `dlp` (a detection);
* a **hook that throws blocks** (`reason: 'error'`): a guard that failed is not a guard that allowed. The error's message is not passed on (it may quote the text);
* the hooks get the guarded transaction (no session-changing SQL);
* the answer carries `hooks`, how many ran. Zero means nothing guards the destination, and a caller that must be guarded refuses (the LLM gateway does).

## What it finds

Plain string work, no database, no network; a bounded quantifier per detector, linear in the text (`test/dlp.test.ts` and `test/hook.test.ts` time hostile input).

| rule | finds |
|---|---|
| `private-key` | a `-----BEGIN … PRIVATE KEY-----` block from header **through footer** (a truncated one up to 16 KB; a text of footerless headers is scanned once) |
| `api-key` | `sk-…` (up to 512 characters, so `sk-proj-…` is whole; a hyphenated word such as `sk-learn-pipeline` is not a key), `AKIA…`, `ghp_…`, `xox…` |
| `bearer-token` | `Bearer <token>` |
| `credential-url` | `scheme://user:password@host` |
| `card-number` | 13–19 digits with separators, confirmed by Luhn |

What a finding does is the **preset's** rule, read from `input.preset` (`standard`, `strict-egress`, `air-gapped` redact; `customer-facing` blocks) unless the caller sets `mode`: `hold` — a person must see it first
(`require_approval`, with the redacted text), `approved` — a person just approved exactly this call (a finding passes as written, but never past a preset that refuses outright). A preset name the plugin does not
know is treated as `standard`, never as "no rule". Findings are rule **names**, never the matched text.

## Events

`guardrails.dlp.decided` — `workspaceId`, `destination`, `botId`, `preset`, `outcome` (`redact`, `require_approval`, `block`), `rules`, `at`. Written for every destination whose caller does **not** record its own
decision (`input.recorded`); the LLM gateway writes `llm.guard.decided` (it alone knows the alias) and passes `recorded: true`, so one decision is not recorded twice. Never carries text.

## Tests

`test/dlp.test.ts` (the detectors; moved from gateway-llm with the code), `test/hook.test.ts` (the hook as a link of the real chain: presets, `hold`, `approved`, unknown preset, the event in its registry shape, `recorded`, hostile input).
