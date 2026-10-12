# guardrails-egress

The destination half of the `pre_egress` chain (SPEC §15, PLAN P5-21; the chain itself is described in [guardrails-dlp](./guardrails-dlp.md)). It decides whether a call may reach where it is going,
**before** the content check reads the text (it loads first: `guardrails-dlp` depends on it).

| preset | rule |
|---|---|
| `standard`, `customer-facing` | no restriction on where a call goes |
| `air-gapped` | only the `local` alias, **and only when its host is on this machine**: the rule judges where the call goes, not what the alias is called (an admin can bind `local` to a hosted provider, and then it is refused; an allowlist does not open an air gap). A local endpoint is `localhost`, `127.0.0.1` or `::1`; a model on another machine of the LAN is not "local" to this rule |
| `strict-egress` | only a host on the workspace's allowlist; a local endpoint (`localhost`, `127.0.0.1`, `::1`) is never egress and needs no entry; a target whose host the caller cannot tell is refused |

The caller resolves the **targets** — `input.targets`, each `{ name, host, local }`: the call's own target first, then every link of its fallback chain — and the allowlist (`input.allowlist`). The rule holds for the
whole chain: the proxy retries a failed call on the next link, so a chain that ends in a hosted model reaches the internet even when its first link is local. The LLM gateway resolves aliases to hosts from
its own tables (`loadEgress`, `loadFallbackChain`) and passes them; the rule itself (`judgeTargets`, pure, in `src/egress.ts`) moved here from the gateway with its tests. A call that names no target has nothing to judge.

A refusal is `block` with `reason: 'preset'`, no rules, and the sentence the caller shows ("The air-gapped preset allows only the local alias, and this call asks for smart."). The decision is written as
`guardrails.egress.decided` (`destination`, `botId`, `preset`, `outcome: block`, `target`, `host`, `at`) unless the caller records its own (`input.recorded`; the gateway does).

Not here yet (P10-04): the per-team allowlist, "provider domains on no team list", the per-team proxy configuration. The allowlist today is the workspace's, set on Workspace → LLM.

## Tests

`test/egress.test.ts`: `judgeTargets` for every preset, the fallback-chain cases and the case-insensitive host match; the hook in the real chain; the event in its registry shape.
