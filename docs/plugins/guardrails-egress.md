# guardrails-egress

The destination half of the `pre_egress` chain (SPEC §15, PLAN P5-21; the chain itself is described in [guardrails-dlp](./guardrails-dlp.md)). It decides whether a call may reach where it is going,
**before** the content check reads the text (it loads first: `guardrails-dlp` depends on it).

| preset | rule |
|---|---|
| `standard`, `customer-facing` | no restriction on where a call goes |
| `air-gapped` | only the `local` alias, **and only when it really is local** — the rule judges where the call goes, not what the alias is called (an admin can bind `local` to a hosted provider, and then it is refused; an allowlist does not open an air gap) |
| `strict-egress` | only a host on the workspace's allowlist; a **local** target is never egress and needs no entry; a target whose host the caller cannot tell is refused |

**Local** is the caller's one answer (`EgressTarget.local`), never guessed here. The LLM gateway sets it from the provider the admin marked "Runs inside this deployment — never egress"
(`llm_providers.local`, migration 0004) or from a loopback host; an in-cluster Service or a LAN address is local only when marked. See [gateway-llm](./gateway-llm.md), "What local means".

The caller resolves the **targets** — `input.targets`, each `{ name, host, local }`: the call's own target first, then every link of its fallback chain — and the allowlist (`input.allowlist`). The rule holds for the
whole chain: the proxy retries a failed call on the next link, so a chain that ends in a hosted model reaches the internet even when its first link is local. The LLM gateway resolves aliases to hosts from
its own tables (`loadEgress`, `loadFallbackChain`) and passes them; the rule itself (`judgeTargets`, pure, in `src/egress.ts`) moved here from the gateway with its tests. A call that names no target has nothing to judge.

A refusal is `block` with `reason: 'preset'`, no rules, and the sentence the caller shows ("The air-gapped preset allows only the local alias, and this call asks for smart."). The decision is written as
`guardrails.egress.decided` (`destination`, `botId`, `preset`, `outcome: block`, `target`, `host`, `at`) unless the caller records its own (`input.recorded`; the gateway does).

## Per team (P10-04)

Each team can carry its own list of hosts its bots may reach, in `app.team_egress` (migration `0001_team_egress.sql`): `enforce` (when on, a non-LLM call from the team may reach only the workspace allowlist plus the team's hosts), `hosts` (at most 200, lower-case, no scheme or path) and `proxy_url`
(an `http(s)://host[:port]` address, never with a user name or password; stored for the team's outbound proxy and read by the proxy work in P10-08 — nothing in this plugin sends traffic through it). Admins read and write every team's row; a member reads their own teams' rows.

**Model-provider domains are never on a team list.** The save route refuses a host that belongs to a model provider (the known provider domains in `LLM_PROVIDER_DOMAINS` plus the host of any provider the workspace configured), and the check ignores such an entry if one slips in, so
a team list cannot open a way to a hosted model around the model guard (which judges `destination: 'llm'` by the preset and the workspace allowlist alone).

The hook applies the team rule to calls whose destination is not the model (`input.destination !== 'llm'`) and which name a team (`input.teamId`, new in P10-04). No caller in this repository passes both yet apart from the gateway's tests, so today the team list is stored, shown and enforced by the hook but
only the test suite exercises it end to end; wiring the email and webhook senders to pass `teamId` is the remaining step. A refusal is `block`, written as `guardrails.egress.decided` (now with `teamId`). Until a sender passes both, the team list is stored configuration only: the screen says so plainly and does not promise a limit. Migration `0002_team_in_workspace.sql` makes the database refuse a row whose team belongs to another workspace. `isProviderHost` also knows the per-region Bedrock hosts (`bedrock-runtime.<region>.amazonaws.com`) and the newer inference providers; the hook checks only that built-in list, the write-time route also the workspace's own provider hosts.

Routes (`/api/admin/guardrails/egress`, owner or admin only): `GET` lists every team with its list, `enforce` and proxy plus the workspace allowlist and the provider domains; `PUT /:teamId` saves one team. A real change emits `guardrails.policy.updated` (`kind: 'egress'`). Screen: Settings → Workspace → Data protection.

## Tests

`test/egress.test.ts`: `judgeTargets` for every preset, the fallback-chain cases and the case-insensitive host match; the hook in the real chain; the event in its registry shape. `test/team.test.ts`: `judgeTeamHosts` and the hook's team rule. `packages/plugins/guardrails-dlp/test/routes.test.ts` covers the egress routes (the two policy screens share one test world); `test/rls/team-egress.test.ts`: who reads and writes `team_egress`.
