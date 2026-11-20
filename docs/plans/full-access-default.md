# P35-01 · Full access by default for Claude Code and Codex

**Owner decision, 2026-11-20:** "allow user to run `codex --dangerously-bypass-approvals-and-sandbox` as default (optionally can be turned off) and
`claude --dangerously-skip-permissions` as default to reduce approval needs." This replaces the open question of item 10 of the Next ten (P31-02's
default allow list): P31-02 shrinks to the allow list a runner with full access *off* still gets.

## What there is today (2026-11-20)
- `app.bot_runners.full_access` (bot-runners 0007): Codex only (`codex_cli`, or `server_agent` whose agent is `codex`), admin-set; a new `codex_cli`
  runner starts on (`routes.ts`: `body.fullAccess ?? true`). The route refuses it for any other kind.
- Two keys: the site's switch travels in the run as `manythreads.fullAccess`; the bridge honours it only when its own profile allows it
  (`tools/agent-bridge/src/config.ts` `fullAccess: true | 'allowed'`, codex profiles only). Pods: the controller writes `fullAccess: true` into the pod's
  bridge config from the runner's switch (`claude-pods/src/render.ts`, `acp && agent === 'codex' && runner.fullAccess`). Enrolled servers: the installer's
  `--allow-full-access` (off by default) makes the profile `'allowed'` and is reported in the hello (`bot_servers.allow_full_access`).
- Claude never runs with full access: `desiredMode` puts claude-code-acp in mode `default` (every tool outside the allowed list asks, and each ask
  becomes an approval card through the one approvals path), and `sessionMeta` sends `allowDangerouslySkipPermissions: false`.
- The six P26 proofs needed about 130 approval presses with full access off.

## Design
1. **Data (bot-runners migration 0011, forward-only):** the check `bot_runners_full_access_codex` becomes `bot_runners_full_access_agent`: full access is
   allowed for `claude_cli`, `codex_cli`, a `server_agent` whose agent is `claude` or `codex`, and a `hermes_gateway` runner whose bridge agent is `claude` or
   `codex` (the host bridge of mode A). The column default becomes `true`. Existing rows of those kinds are switched on in the same migration **and** an
   `bot_runner.updated` event per row is written with `changed: ['fullAccess']` and actor `system` (the audit page shows who/why: "owner decision
   2026-11-20"). Hermes (`hermes_pod`, Hermes agent) and `llm_gateway` stay without the switch (no command prompts of their own to bypass).
2. **Routes:** create takes `fullAccess` for every kind above, default `true`; update may turn it off or on. The rule that kept a full-access Codex runner to
   one team goes only if each team's run is in its own pod or Unix user (pods: one pod per team, P26-21, so it goes; a `server_agent` on a server: every
   team on that server runs as its own team user since P26, check in the review; a host `hermes_gateway` bridge runs every team in one Unix user, so full
   access there stays one-team).
3. **Bridge (`tools/agent-bridge`):** `config.ts` accepts `fullAccess` for `claude` profiles too. `fullAccessOn` covers both agents. Claude with full access:
   `desiredMode` → `bypassPermissions`, `sessionMeta` → `allowDangerouslySkipPermissions: true`; tools outside the bot's grants stay off (the `tools` list is
   unchanged: full access removes questions, not the grant model). The stream-json CLI drivers (`drivers/claude-code.ts`, `codex.ts`, kept until P25-17) get
   `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` under the same test. `claude` refuses the flag as root unless
   `IS_SANDBOX=1`: the pods run as a non-root user and a server agent as its team user; the bridge refuses (clear error in the thread) rather than set
   `IS_SANDBOX` for a root process.
4. **Pods (`claude-pods/src/render.ts`):** `fullAccess` for Claude pods too; the instructions line "Your commands run without a question in this pod" for
   both. The pod is the sandbox: its NetworkPolicy, egress proxy, no host mounts, non-root, read-only service account; unchanged.
5. **Enrolled servers:** `bridge.sh` allows full access by default; `--no-full-access` turns the machine's key off (the old `--allow-full-access` is accepted
   and ignored with a note). The server page shows the state as today.
6. **Mode A host bridge on the devbox** (the live Engineering bots): its profile config gets `fullAccess: true` for the claude and codex profiles, written by
   the host install step (`tools/agent-bridge/install`), not by hand.
7. **Web:** `hasFullAccessChoice` covers the Claude kinds; the Full access dialog's words name both agents ("Commands run without asking. The pod (or the
   team's user on the server) is the boundary: what it can reach on the network, and the team's files."); a new runner shows the switch on; the badge stays.
8. **What does not change:** `approvals.ask` (a bot asking a person for a decision), BOT.md approval rules, protected environments (`needsApproval` on tagged
   tools), the MCP tools' own guards (publish, deploy, mail), the egress proxy and the DLP guardrails. Full access removes only the agent CLI's own
   command and file-edit questions.
9. **Docs:** `docs/engineering/security.md` (the boundary table: with full access the pod/user is the only boundary for commands), `docs/plugins/bot-runners.md`,
   `docs/plans/agents-anywhere.md` §4 pointer, MISTAKES.md if something bites.

## Tests
- Migration: constraint accepts the new kinds, refuses Hermes/LLM; existing rows switched on with one event each.
- Routes: default on at create, off on request, refused for Hermes; the one-team rule only for the host gateway.
- Bridge: `desiredMode`/`sessionMeta` for claude on/off, the two keys (`true`, `'allowed'`, run says false), the CLI flags, the root refusal.
- Render: Claude pod config carries `fullAccess`; instructions line.
- Web: dialog words and the choice for Claude runners.

## Done
On the live site: an Engineer-led delivery on Claude and one on Codex with **no command approval cards** (only `approvals.ask` cards a bot files on
purpose); a runner switched off asks again as before. Measured: cards per delivery before (P26 proofs) and after.

## Risks
- A bot with full access can do anything its pod or user can: delete the team's work folder, run network calls through the egress proxy. The boundary is
  the pod/user and the network policy; this is the owner's choice, stated on the runner card and in security.md.
- Prompt injection from fetched pages now runs commands without a person seeing them. The DLP and egress guards still apply; the `approvals.ask` rule in
  the instructions stays.
- Switching existing runners on silently: the migration writes an audit event per runner, and the release note says so.

## Corrections after the independent review (2026-11-20, binding; they override the design above where they differ)
1. **`--restricted` refuses bypass.** The ACP `sessionMeta` passes `extraArgs.restricted` (`acp/adapter.ts:93`) and the stream-json driver `--restricted`
   (`drivers/claude-code.ts:49-50`); the pinned CLI (2.1.323 via claude-agent-acp 0.107.0) "refuses bypassPermissions" with it. A full-access Claude run
   drops `restricted`. What that gives up: file tools may leave the work folder and the agent may write its own settings and git config. The boundary
   becomes the pod (uid 1000, its NetworkPolicy) or the team's Unix user (`mt-team-<team>`), the same as Codex full access. `settingSources: []` and
   `strict-mcp-config` stay, so the operator's settings, memory, hooks and claude.ai connectors stay out.
2. **The column default stays `false`.** `adopt.ts:102,126` and `servers.ts:94` insert Hermes rows without naming `full_access`. Full access is set
   explicitly at create (`routes.ts`) and in `syncServerRunners` for `claude-code` and `codex` runners.
3. **Names.** The agent word is `claude-code`, not `claude`. The constraint is `bot_runners_full_access_codex` (0007). The next migration is **0010**.
4. **Switching existing runners on is a TypeScript data step**, not SQL. It runs once as the system actor through `emit()`, so `bot_runner.runner.updated`
   (`changed: ['full_access']`, an `actorId`) is parsed and goes through the outbox.
5. **No `hermes_gateway` and no host bridge.** The root host bridge was retired. `conventions.md` keeps "never give the host bridge full access", and the
   resolver's gateway path sends no `fullAccess`. The live devbox bridge is an **enrolled server** (`manythreads-bridge.service`, team users), so plan
   step 6 is step 5. The "one-team rule" is no longer in the code, so nothing needs removing.
6. **Site, server runners:** `resolve.ts:103` sends `fullAccess` for `claude-code` too. Rename `isCodexRunner` (`routes.ts:79`).
7. **Bridge, servers:**
   - `server-mode.ts:84` reads `allowFullAccess` from the codex template only.
   - `install/bridge.sh:300` writes `fullAccess: "allowed"` only for codex.
   - `config.ts:264` refuses non-codex profiles.
   - `fullAccessOn` (`adapter.ts:50`) is codex only.

   All four cover `claude-code`. The installer default becomes allowed, with `--no-full-access` to refuse. Re-check why the live server's
   `/etc/manythreads-bridge/config.json` has no `fullAccess` under codex although it was installed with `--allow-full-access`.
8. **No team users, no full access:** the bridge refuses full access on a server whose config has no `teamUsers` (`runs.ts:254`, `hasTeamUsers`), with
   a line in the thread.
9. **The mode check is the guard.** As root without `IS_SANDBOX`, the adapter quietly leaves `bypassPermissions` out of its modes
   (`claude-agent-acp/dist/permissions/modes.js:2-3`). The bridge already fails a run whose wanted mode is not offered (`acp/session.ts`); keep and test it,
   and never set `IS_SANDBOX`. A resumed session takes its old mode only when offered (`session-mode.js:38-45`): test a resume after the switch flips.
10. **Tests that pin today's behaviour:**
    - `acp-frames.test.ts:248`, `acp-driver.test.ts:36`, `acp-review-driver.test.ts:169`
    - `full-access.test.ts:54-55,87`, `resolve.test.ts:249`
    - `clients/web/test/runners-commands.test.ts:514-515`
    - the fake agent's claude modes (`tools/fake-acp-agent/src/agent.ts:73`) gain `bypassPermissions`
11. **Codex-only words to widen:**
    - `ServersSection.tsx:198`, `commands.ts:628-639`, `dialogs.tsx:592-595`
    - `packages/shared/src/api/bot-runners/index.ts:70,89`, `api/hermes/bridge.ts:29`
12. **Docs:**
    - the binding rule is `docs/engineering/conventions.md` "Full access for Codex"
    - the security page is `docs/plugins/security.md`
    - also `docs/agent-bridge.md`, `docs/guide/add-a-server.md`, `docs/plugins/claude-pods.md`
    - the Codex stream-json driver swaps `sandbox_mode` for `--dangerously-bypass-approvals-and-sandbox`
