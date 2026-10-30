# guardrails-dlp

The content half of the `pre_egress` chain (SPEC §15, PLAN P5-21). Whatever is about to leave the platform passes the hooks the guardrails plugins registered, and the chain answers one of
four outcomes: `allow`, `redact`, `require_approval`, `block`. This plugin reads **what the text carries**; [guardrails-egress](./guardrails-egress.md) reads **where it is going**. Since P10-04 the workspace
sets its own policy on top of the presets: what each built-in detector does (nothing, redact, wait for a person, block) and its own words or patterns to look for. The check runs at the three places text leaves
a bot: the model call (gateway-llm), the MCP gateway (every tool call and every answer a read tool gives back) and any caller of the chain (email, the gate preview).

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
* the answer carries `hooks`, how many ran, and `ran`, the plugins whose hooks ran: a caller that relies on one particular guard checks for it by name (the gate's preview needs `guardrails-dlp`; "some hook ran" is not enough).
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
| `secret-assignment` | `password = …`, `api_key: …`, `secret=…` with a value that looks like a secret (off by default) |
| `email-address` | an email address (off by default) |
| `phone-number` | an international or national phone number (off by default) |
| `iban` | a bank account number in IBAN form, confirmed by the mod-97 check (off by default) |

The five older detectors keep the behaviour they always had (on, following the preset); the four new ones start at `allow` (do nothing) so turning the plugin on changes nothing until an admin chooses.
What a finding does is the **preset's** rule, read from `input.preset` (`standard`, `strict-egress`, `air-gapped` redact; `customer-facing` blocks) unless the caller sets `mode`: `hold` — a person must see it first
(`require_approval`, with the redacted text), `approved` — a person just approved exactly this call (a finding passes as written, but never past a preset that refuses outright). A preset name the plugin does not
know is treated as `standard`, never as "no rule". Findings are rule **names**, never the matched text.

## The workspace's policy (P10-04)

Two tables, both in this plugin's migration `0001_dlp_policy.sql` (every member of the workspace reads them, because the check runs in the sender's transaction; only owners and admins write, enforced by RLS — the database rule that filters rows per caller):

* `app.dlp_detectors` — one row per detector the admin changed: `preset` (follow the preset; choosing it deletes the row), `allow`, `redact`, `require_approval` or `block`.
* `app.dlp_custom_rules` — up to 20 rules per workspace: a lowercase name, a pattern (at most 190 characters), a case switch, an action (`redact`, `require_approval`, `block`) and an on/off switch.

A custom pattern is **not** run by the JavaScript regex engine. It is compiled by the same linear-time matcher that reads BOT.md gates (`packages/shared/src/bot-md/gate-*.ts`; `findSpans` returns each match's position), so a hostile pattern cannot
make the server hang. It supports literals, classes, `.`, groups, `|`, `?`, `*`, `+` and `{n,m}`; it rejects backreferences, lookarounds and a pattern that can match nothing. The rules of one workspace share a budget of 1000 compiled steps, and a
scan that outruns its work budget treats the rest of the text as one finding rather than running on. The budget is per call (10 million steps shared by every text of one tool call, counted in `findSpans`; positions that cannot start a match cost nothing): when it runs out the text gets a `scan-limit` finding, which always blocks (a text that was not read to the end cannot be called clean), and the names `scan-limit`, `unnamed` and the built-in detector names cannot be used for a rule. The database also refuses a 21st rule (trigger in migration `0002_rule_cap.sql`, serialized per workspace).

Before any detector runs, invisible characters (zero-width spaces and joiners, soft hyphen, direction marks, variation selectors; Unicode format characters) are folded out, so a key with a zero-width character pushed into it is still found; the redaction covers the invisible characters inside the match. Not covered: encodings and look-alike letters.

Admin routes (workspace owner or admin only, `403` for anyone else, `401` signed out), all under `/api/admin/guardrails/dlp`:
`GET` (detectors with their effective action, rules), `PUT /detectors/:name`, `POST /rules`, `PATCH /rules/:ruleId`, `DELETE /rules/:ruleId`, `POST /test` (runs a sample text through the policy and answers names and counts with the redacted copy;
limited to 60 a minute per process; the sample is never stored or logged). Each real change emits `guardrails.policy.updated` (`kind: 'dlp'`, the change, the detector or rule name, who) which the audit console lists as `guard.policy_changed`.
The screen is Settings → Workspace → Data protection (`clients/web/src/screens/guardrails`).

## Events

`guardrails.dlp.decided` — `workspaceId`, `destination` (`mcp` for a tool call's arguments, `mcp_result` for what a read tool answered), `botId`, `teamId`, `preset`, `outcome` (`redact`, `require_approval`, `block`), `rules` (detector and custom-rule names), `at`. Written for every destination whose caller does **not** record its own
decision (`input.recorded`); the LLM gateway writes `llm.guard.decided` (it alone knows the alias) and passes `recorded: true`, so one decision is not recorded twice. Never carries text.

## Tests

`test/dlp.test.ts` (the detectors; moved from gateway-llm with the code), `test/hook.test.ts` (the hook as a link of the real chain: presets, `hold`, `approved`, unknown preset, the event in its registry shape, `recorded`, hostile input), `test/policy.test.ts` (the new detectors, per-detector actions, custom rules, hostile patterns timed with `expectLinear`), `test/routes.test.ts` (admin-only, validation, limits, events and audit rows carry no sample text), `test/rls/dlp.test.ts` (who reads and writes the two tables). The MCP side is `gateway-mcp/test/guard.test.ts`.
