# P31-01 and P31-04 · Codex for several teams on one server; a run survives a command that runs out of memory

Item 9 of the approved Next ten (PLAN.md P31-01, P31-04). Written by a planning agent on 2026-11-20 from the code and read-only measurements on the devbox;
an independent review follows before building. Binding: from P35-01 Claude Code and Codex run with **full access by default** (owner 2026-11-20,
`docs/plans/full-access-default.md`), so everything here must hold when a team's Codex has no sandbox: team A's Codex never reads team B's Codex state or
token copy. An enrolled server runs each team as its own Unix user `mt-team-<team>`, started by the root helper `mt-team-helper` (`docs/agent-bridge.md:403-428`).

Words: *sign-in folder* = where a tool keeps its login (Codex: `CODEX_HOME` with `auth.json`); *the helper* = `mt-team-helper`; *run* = one turn of a bot;
*OOM* = out of memory; *cgroup* = a kernel process group with its own memory limit; *scope* = a cgroup systemd makes for processes started elsewhere.

## 1. What exists today (file:line; measured 2026-11-20, names only)
- **Server Codex state is one shared folder.** `<root>/auth/codex` is bridge-user owned, group `mt-agents`, setgid 2770 (`install/bridge.sh:167,184-189`);
  every team user is in `mt-agents` (`src/team-helper.ts:162,171`); `authHome` → `CODEX_HOME` (`src/runs.ts:122-125`); the helper accepts only that value
  (`src/team-user.ts:147-148`). Live it holds `auth.json`, a 0-byte `auth.lock` (present for days), `installation_id` and `tmp/arg0-linux/` (hand-chowned to
  `mt-team-engineering`), `sessions/`, `session_index.jsonl`, `shell_snapshots/`, SQLite `state_5`, `logs_2` (20 MB), `thread_history_1`, `goals_1`,
  `memories_1`, `queue_1`, caches: **every team reads every team's transcripts and history.** A stray `work/engineering/.codex` (2026-11-17, mode 2755, files
  0644) is readable by the publisher group (team home 2750, group `manythreads-publisher`, `team-helper.ts:175-177`).
- **Pods:** `CODEX_HOME=/state/codex` (`claude-pods/src/render.ts:35-38,446`); all team pods of a runner share one `state` volume (`render.ts:8-9,456`), uid
  1000 (`:408`). The keeper copies a renewed token back to the Secret and skips while `auth.lock` exists (`deploy/images/agent-pod/keeper.mjs:6-7,46`).
- **Sharing one sign-in:** the helper re-adds group bits under `auth/claude` and `auth/codex` before, every 15 s during, and after a run
  (`team-helper.ts:377,413-414,423`; no-follow opens `:203-261`, list `:247`). The `SigninGate` serialising renewals (`src/signin.ts:147-194`) is built only when
  `options.codexHome` is given (`src/server.ts:146`), `main.ts:113` passes only `process.env.CODEX_HOME`, and the unit sets none (`bridge.sh:352-361`):
  **an enrolled server has no Codex gate and no memory of an account failure.** Sign-out runs the adapter's `logout` on the one folder (`src/acp/auth.ts:741-797`).
- **The P26 proof's hand fix:** proof 5 died in 0.6 s — Codex chmods files it did not make (`tmp/arg0-linux`, `installation_id`), EPERM for the team user
  (`MISTAKES.md:1449`); the operator chowned them to `mt-team-engineering` (`STATUS.md:74`), which works for one team only.
- **Memory, pods:** run container limit 4Gi (`deploy/helm/manythreads/values.yaml:362-366`, `claude-pods/src/config.ts:39-40`, `render.ts:452`); apps namespaces
  allow at most 4Gi per container (`values.yaml:449-452`) = **the Helm maximum**. Measured: the container cgroup has `memory.oom.group=1` (k3s v1.36.5) — one
  OOM kills **every** process in the container, the bridge included (`STATUS.md:90,101,117`).
- **Memory, server:** no `MemoryMax` (`bridge.sh:352-376`). Measured `OOMPolicy=stop`, `MemoryMax=infinity`; sudo runs the helper in the bridge's cgroup (PAM has
  no `pam_systemd`), so **any OOM kill of a bot command stops the whole bridge** (every team's runs; `Restart=always` brings it back, `bridge.sh:363-364`).
  `oom_score_adj`: bridge 0, the live site's Postgres 984, `k3s server` -999 — in a host shortage Postgres goes before a bot's 4 GB `tsc`.
- **How a run's end reaches the site:** `tool.completed {error}` (`src/acp/frames.ts:610-625`) → `tool_result` "the tool reported an error"
  (`runtime-hermes/src/activity.ts:86-100`); no frame carries a thread notice; the run job can post mid-run with `postNotice` (`runtime-hermes/src/holds.ts:64-70`).
- **`NODE_OPTIONS`:** not on the helper's allowlist (`team-user.ts:95`) or `ENV_COMMON` (`runs.ts:100-106`), but a profile's `env`/`passEnv` may name it (only
  two names reserved, `src/config.ts:146,250-256`).
- **Templates:** the Coder says "run the whole suite" (`templates/engineering/bots/coder/BOT.md:66`); no text says what a killed command looks like.

## 2. P31-01 design
| Path | Owner, mode | Holds |
|---|---|---|
| `<root>/auth/codex` (**main copy**) | bridge user, 0700 dir, 0600 files, no group | `auth.json` only |
| `<root>/work/<team>/.codex` (**team's Codex home**) | `mt-team-<team>`, 0700 | that team's `installation_id`, tmp, sessions, SQLite, caches, and during a run its copy of `auth.json` (0600) |
| `<root>/auth/.locks/` | root, 0700 | `codex-token.lock`, `codex-live/<team>/<tag>` markers |

Under the team home: it lives and dies with the team, fits every path rule (`team-user.ts:133-165`), and is Codex's own default (`$HOME/.codex`). Every file is
the team user's, so proof 5's EPERM cannot happen and no hand chown is needed.

**A run (kind `codex`), all in the helper, paths from its own table and the slug, never from the header:**
1. Header rule: `CODEX_HOME` absent or exactly `<root>/work/<team>/.codex` for `codex`, absent otherwise (this is "the helper accepts only the per-team
   folder"); the bridge sets it in `serverProfile` when `teamUsers` is on (`config.ts:345-348`; `profile.env` wins over `authHome`, `runs.ts:124-125`).
2. Prepare as the team user: `mkdir -p` with umask 0077, `chmod 0700` (fixes the stray 2755).
3. Copy in under the lock: root opens the main folder `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, `fstat` owner = the bridge user from the table (new `bridgeUser` key in
   `team-agents.json`) and not group/other-writable; `auth.json` via `/proc/self/fd/<dir>/auth.json` `O_NOFOLLOW`, regular, `nlink` 1, ≤ 64 KiB; keep
   `{sha256, account id, last_refresh, refresh_token}` in memory for the run; write to the team folder through `SH_PUT` **as the team user** (root never writes
   where a team can, `MISTAKES.md:1398`); a live marker with the helper's pid.
4. During the run (replacing the codex part of the 15 s fixer): read the team's copy **as the team user** (new constant `SH_READ`); if it differs, write back
   (below); if the main copy is gone or names another account, remove the team copy and never write back.
5. At the end: a last write-back, remove the marker, remove the team's `auth.json` (as the team user) if no other live marker of that team, then the existing kill
   and `removeAtEnd`. `fixAuthFolders` drops `codex` (`team-helper.ts:247`).

**Write-back** (the only time root writes the main copy), under `codex-token.lock` (`O_CREAT|O_EXCL|O_NOFOLLOW`, stale when the pid is dead or > 10 s), accepted
only when all hold — a pure `acceptRenewed(main, copiedIn, candidate)` in a new side-effect-free `src/codex-token.ts`, shared with `readCodexFileFacts`
(`signin.ts:109-131`): a ChatGPT login with all three tokens and no API key; the same account (`tokens.account_id` and the id token's `chatgpt_account_id`); a
later `last_refresh` and a different refresh token; the main copy still has the sha the run copied in (else keep the newer, log "two runs renewed the Codex
sign-in at once", no token in the line). Write: `O_NOFOLLOW|O_DIRECTORY` on the main folder, temp file `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600, `fchown` to the
bridge user, write, `fsync`, rename over `auth.json` through `/proc/self/fd/<dir>`. A refused candidate is never copied anywhere; one plain log line.

**Refresh races:** wire `SigninGate` for Codex on servers (`server.ts:146` also takes `config.server.agents.codex.authHome`); it serialises all teams' runs in
the 20-minute window before a renewal (`signin.ts:169-193`); the probe run's helper writes back before it exits and the gate waits for the exit (`runs.ts:337`).
Left: a renewal forced by a 401 outside the window → `refresh_token_reused` → the gate's failure memory says plainly that an admin must sign in again (R2).

**Sign-out removes every copy:** after a successful `logout` on a server with team users: stop every live Codex run ("The Codex sign-in was removed, so this
run stopped.", new `RunManager.stopAgent('codex', reason)`), then for each team (`teamsOnMachine`, `server-team.ts:76-87`) a new helper kind **`clean-codex`**
removes the team's `auth.json` as the team user (pattern `cleanTeamKube`, `server-team.ts:90-111`); the same at bridge start. Sessions and state stay.

**The sudo rule is unchanged word for word** (`bridge.sh:264-277`): `parseArgv` (`team-helper.ts:76-83`) accepts `run <slug> <kind>`, `KINDS`
(`team-user.ts:47`) gains `clean-codex` (no program, like `clean-kube`). No word from the bridge chooses a path or a limit.

**After this, a full-access Codex** reaches its own team's home and `.codex` (accepted, `conventions.md:70`) and cannot reach the main copy, the lock folder,
another team's home or `.codex`, or another uid's `/proc` environment. It could write a forged `auth.json` into its own copy that repeats the account id with
its own refresh token (R1) — closed in step 4b by checking token signatures. **Claude stays shared** (`auth/claude`): every team still reads every team's
Claude transcripts — P35-01 must keep that explicitly or apply this mechanism to Claude as a follow-up row. **Pods are unchanged** (all team pods of a runner
share `/state/codex`): follow-up row "P31-01p" (subPath per team plus a shared renewing token).

**Moving the existing server** (`bridge.sh --update`): main copy bridge-owned 0700, files 0600, no setgid; delete everything in it except `auth.json` (the
shared transcripts); remove the stray `.codex` once through the helper (`clean-codex --all` at first start); threads with an old Codex session start a new one
(the adapter answers "no rollout found", `acp/session.ts:84-95,335-353`).

## 3. P31-04 design
**Server:** (1) `OOMPolicy=continue` in the unit (`bridge.sh:352-376`) — smallest fix, ships first. (2) `oom_score_adj` 1000 for the run tree: `SH_EXEC`
(`team-helper.ts:101`) gains `echo 1000 > /proc/self/oom_score_adj 2>/dev/null;` before `exec` (raising needs no privilege; children inherit). (3) A scope per run:
`systemd-run --scope --quiet --collect --slice=mtruns.slice --unit=mt-run-<user>-<tag> -p MemoryMax=<runMemoryMax> -p MemorySwapMax=0 -p OOMPolicy=continue -- <setpriv …>`
from a pure tested `scopeArgv`; `--scope` keeps pid, process group and signals; `OOMPolicy=continue` leaves `memory.oom.group` 0 so the kernel kills one
process; `<tag>` from a new optional header field `runTag` (`^[a-z0-9]{8,32}$`) or random; no `MemoryHigh`; without `systemd-run` keep step 2 only.
(4) Limits from the root table only: `runMemoryMax` default **4 GiB** (the Helm maximum), installer `--run-memory` may only lower it; `mtruns.slice` `MemoryMax`
40 % of `MemTotal` (`--runs-memory`, lower only; 6 GiB on the devbox). (5) Detection: the bridge reads the scope's `memory.events` once a second; when `oom_kill`
rises, the next `tool.completed {error}` of an `execute` step that started before is the killed command.

**Pod:** `memory.oom.group=1` means `oom_score_adj` cannot save the bridge. A guard in the bridge reads its own cgroup's `memory.current`/`memory.max` every
500 ms; at `≥ max − max(512 MiB, 10 %)` (3.5 GiB of 4) it `SIGKILL`s the largest-RSS process below the run's adapter — never the bridge, `tini`, the adapter or
its direct agent process (measure the tree of one Claude and one Codex run first: does `codex-acp` start a separate `codex`?). The threshold derives from the
chart's limit, so it can never be above the Helm maximum. With limit "max" (a server without `systemd-run`) it uses `MemAvailable < 10 %` and only logs.
k3s `singleProcessOOMKill` is documented in `docs/deploy.md`, never required. A fast allocation can still beat the guard (R6).

**Telling the thread and the agent:** a new `src/memory-watch.ts` (server scope source, pod guard source) marks the step's `tool.completed` with
`reason: 'out_of_memory'` and emits a new frame `run.notice {kind: 'out_of_memory', text}`: "A command was stopped because it used more memory than this run may
use (4 GB): `<step title>`. The run goes on." Where the adapter supports steering (`acp/session.ts:322,399-402`), one line to the agent: "Your last command was
killed for using too much memory (exit 137). Run a focused check instead: one package's typecheck, one test file, `--maxWorkers=1`." Site:
`runtime-hermes/src/gateway.ts:568-603` maps `run.notice` to a `BotRuntimeEvent` `{type:'notice', kind, text}` (`packages/sdk/src/runtime.ts:185`), `reason`
passes through (`activity.ts:95`), the run job posts it with `postNotice` (check it does not count as "the run already posted", `run-job.ts:274-277,705`). The
gateway ignores unknown frames, so the bridge can ship first.

**Words:** "Where you run" (`packages/shared/src/runners/where-you-run.ts:134-170`) gains `memoryMiB` and: "Your commands and the agent share N GB of memory. A
command that needs more is stopped (exit code 137, 'Killed') and your run goes on. Run focused checks: the typecheck and tests of the package you changed, one
test file at a time, `vitest --maxWorkers=1`; never a whole-repository typecheck, lint or test run, and never a bigger `--max-old-space-size` or `NODE_OPTIONS`."
Templates: the Coder's "run the whole suite" → "run the tests of the package you changed"; the same exit-137 sentence for Tester, Code reviewer, Deployer and
`tools/devbox/demo-bots/*`; live bots by proposal (P31-03's sync path).

**No `NODE_OPTIONS`:** add `NODE_OPTIONS` and `NODE_PATH` to `RESERVED_ENV` (`config.ts:146`); keep them off `ENV_ALLOW` and `ENV_COMMON`, with tests.

## 4. Tests
Unit (vitest in `tools/agent-bridge`, no root): `team-user.test.ts` (CODEX_HOME rule, `runTag`, `clean-codex`, NODE_OPTIONS dropped); new `codex-token.test.ts`
(every refusal reason, a real renewal accepted); `team-helper.test.ts` (`clean-codex`, `SH_EXEC` oom line, `SH_READ`, `scopeArgv`, `fixAuthFolders` without codex);
`team-run.test.ts` (team CODEX_HOME in the header; sign-out starts `clean-codex` per team and stops live Codex runs); config/server-mode (NODE_OPTIONS refused;
the Codex gate in server mode); new `memory-watch.test.ts` (fake `memory.events` and fake `/proc`); site gateway and run-job tests for `run.notice`.
**Two-Unix-user test:** extend `install/container-test/run.sh` (real installer and helper in a throwaway Debian container, teams `acme` and `beta`; Docker, root
only inside; ~2 min on the devbox; can be a CI job on `ubuntu-latest`) with a stand-in `codex` adapter: own 0700 `.codex` per team; beta cannot read acme's
`.codex` or `/proc/<pid>/environ`; no team or publisher reads the main copy; chmod of `tmp/arg0-linux` and `installation_id` succeeds (proof 5, fails on old code);
a stand-in renewal reaches the main copy; another account or a link to `/etc/shadow` leaves the main copy byte for byte; concurrent renewals leave one valid
newest copy; `clean-codex` removes both; the sudo file unchanged (`visudo -cf` and a diff). **OOM scope test** (`install/container-test/oom.sh`, devbox only:
systemd in a `--privileged --cgroupns=private` container with its own cgroup2 mount, MISTAKES P27-00): `runMemoryMax=256M`, a stand-in growing a buffer: only it
dies, the adapter answers, `oom_kill 1`, the unit has `OOMPolicy=continue`. `free -h` first; nothing else at the same time.

## 5. Order (each its own commit, shipped and checked)
1. **P31-04a safety first:** `OOMPolicy=continue`, `oom_score_adj` 1000 in `SH_EXEC`, `NODE_OPTIONS` reserved. Check `systemctl show -p OOMPolicy` and a run's
   `/proc/<pid>/oom_score_adj`.
2. **P31-01a:** header rule, `CODEX_HOME` per team, `codex-token.ts`, copy-in, write-back with the lock, markers, `fixAuthFolders` without codex, the server
   Codex gate, the installer move, container test; `bridge.sh --update` on the devbox.
3. **P31-01b:** `clean-codex`, `stopAgent('codex')`, start-up clean; sign out and in again from the Runners page.
4. **P31-01c docs:** `conventions.md:70`, `docs/agent-bridge.md`, MISTAKES (OOMPolicy=stop, oom.group=1, no server gate), PLAN/STATUS. **4b** after measuring:
   token signature check before a write-back.
5. **P31-04b** bridge: `scopeArgv`, `mtruns.slice`, limits, `runTag`, `memory-watch` server source, `run.notice`, `reason`.
6. **P31-04c** site: the notice event, `postNotice`, `reason`.
7. **P31-04d** pod guard after measuring the process tree; new agent pod image.
8. **P31-04e** words: "Where you run", templates, demo bots, proposals for live bots.
9. Live proofs, then PLAN/STATUS rows with commits and thread ids.

## 6. Risks
R1 forged token from a full-access team (same account id, its own refresh token) — closed by 4b; until then the Runners guide says a server shared by teams that
distrust each other should not have full access. R2 a renewal outside the gate's window → account signed out, bounded by the gate's failure memory. R3 Codex
changes its folder between versions (only `auth.json` is copied; re-check at each pinned bump). R4 `systemd-run` under the hardened unit
(`ProtectSystem=strict`, `ProtectHome=true`, `bridge.sh:369-374`) must be measured before step 5 (fallback: `oom_score_adj` only). R5 the kernel kills the
largest process in a scope (a vitest worker): the command fails, the run goes on. R6 a fast allocation beats the pod guard (follow-up: read `OOMKilled` from the
pod status). R7 the keeper's lock test (`keeper.mjs:46`) with a permanent `auth.lock` may never copy a renewed token back in a pod — measure. R8 old Codex
sessions start anew. R9 Claude and pods keep shared folders (P35-01 must say so). R10 devbox memory during tests. R11 runs of one bridge share its cgroup's kill count.

## 7. Done
On the enrolled devbox server, no hand fix: two teams run Codex at once; each `.codex` is its own user's, 0700; each team is refused the other's `.codex` and the
main copy; the main copy is bridge-owned 0700 with only `auth.json`; a sign-out from the Runners page removes both copies and stops a running Codex run with its
sentence, and a sign-in lets both run again. A command that runs past the run's memory is stopped, the thread shows "A command was stopped because it used more
memory than this run may use …", the step reads "out of memory", the bot finishes with a focused check, and the bridge never restarted (server:
`systemctl status`; pod: restart count unchanged). Unit and container tests green; lint and typecheck green; conventions, agent-bridge docs, MISTAKES, PLAN,
STATUS updated.

## Corrections after the independent review (2026-11-20, binding; they override the text above where they differ)
1. **Gate wiring:** the server branch starts the bridge at `main.ts:86` with neither `claudeConfigDir` nor `codexHome` (`main.ts:113` is the pod/local branch),
   so servers have no Claude gate either. Wire both gates at `main.ts:86` (or `server.ts:146` reads `config.server`).
2. **Long runs keep an old token:** a run that started before another team renews keeps the old refresh token and its next refresh is `refresh_token_reused`
   (the account is signed out); `SigninGate.run` (`signin.ts:178-194`) does not count runs in flight. Measure whether Codex re-reads `auth.json` before it
   refreshes: if it does, step 4 also copies a newer main copy into each live team copy; if not, the probe waits for in-flight Codex runs to finish.
3. **No `clean-codex --all`:** `parseArgv` refuses extra words (`team-helper.ts:79`); loop per team like `cleanTeamKube` (`server-team.ts:90`). The one-time
   removal of the stray `.codex` uses a marker (that path becomes the team's real Codex home; a second wipe would lose its sessions). `programFor` (`:86`) and
   `main` return no program for `clean-codex`; the usage text (`:82`) names it.
4. **Root never writes the main copy:** the bridge user owns it, so copy-in and write-back run **as the bridge user** through `setpriv` (as `SH_PUT` writes as
   the team user). The lock is `flock(1)` (util-linux), not a pid file (no pid reuse, no "stale after 10 s"). Any remaining root open of a file another user
   controls uses `O_NONBLOCK` before `fstat` (a planted FIFO must not block root).
5. **`SH_READ` is bounded:** `timeout 2 head -c 65537 --` with a short spawn timeout (the helper's `spawnSync` waits up to 60 s, `team-helper.ts:107`, so a
   FIFO in `.codex` would freeze its watch every 15 s).
6. **`oom_score_adj` set by root:** root writes 1000 on the helper before the spawn (a privileged write also raises `oom_score_adj_min`, which the child
   inherits, so a full-access team cannot lower it back to 0 and make Postgres the victim); then the helper lowers its own.
7. **Scopes must not outlive the bridge:** a scope sits outside the unit's cgroup, so `KillMode=control-group` no longer reaches it. The helper stops its
   scope at the end; `BindsTo=`/`PartOf=manythreads-bridge.service` on the scope (measure); leftover `mt-run-*` scopes are stopped at bridge start. Scopes with
   `OOMPolicy=` only on systemd ≥ 253 (devbox 255; Debian 12 has 252, Ubuntu 22.04 249): the installer allows scopes only there, else `oom_score_adj` only.
8. **The pod guard reads anonymous memory, not `memory.current`** (page cache sits near the limit in a build container): `memory.stat` `anon` (or current
   minus `inactive_file`), or PSI.
9. **The main copy is still the bridge adapter's own `CODEX_HOME`** (live `state_5`, `goals_1`, `logs_2` updated today by the bridge user): give the bridge's
   sign-in adapter its own scratch home beside it, or the Done line reads "no team can read it" instead of "holds only auth.json". `bridge.sh:184-189` stops
   chowning/chmodding `auth/codex` for the group, or every `--update` turns sharing back on.

**R1, stated fully:** with one shared sign-in, a full-access team holds a working copy of the shared refresh and access tokens: it can leak them, use the
account anywhere, or sign every team out by refreshing — no check can stop that. 4b (JWT signatures of the id and access tokens against OpenAI's keys) only
narrows the forged-write-back case; the refresh token is opaque. The stronger option, to measure before 4b: the bridge does every renewal itself and never
accepts a team's write-back (if Codex runs correctly with a copy whose refresh the bridge owns). Otherwise the true fix is **one Codex sign-in per team** on a
shared server; until then, teams that distrust each other should not share a server's Codex sign-in. Same for Claude (`auth/claude`). **Also:** in the gate's
window all teams' Codex runs go one at a time (could last long on a shared server); CI does not run `container-test` today (a new job); deleting the shared
sessions loses thread context (they could be sorted per team by `cwd` instead).

## Owner decision (2026-11-20): accept the shared sign-in for now
Asked about R1 (with full access, a team on a shared server holds a working copy of the one Claude/Codex sign-in): **accept for now.** Only Engineering uses
the devbox server today. Build the per-team Codex folders as planned; the Runners page warns that teams sharing a server share its sign-in; per-team sign-ins
become a later Phase 35 row.

## P31-04 as built (2026-11-25; overrides section 3 where they differ)
Checked against the code first: P31-04a (`OOMPolicy=continue`, the helper's root-written `oom_score_adj` 1000 with its floor, `NODE_OPTIONS`/`NODE_PATH` reserved) was
already live (c1946d6b); the Coder's "run the whole suite" was already gone (P31-02/03). Built in this step:
- **Weight off the helper path:** a run the bridge starts itself (pod, host, a server without team users) gets `oom_score_adj` 1000 written on the agent right after
  `spawn` (`process.ts` `oomScore`, `memory-watch.ts` `raiseOomScore`); children inherit it; the bridge's own value is never touched; no-op off Linux.
- **Detection without polling or scopes:** `Frames` reads the bridge's own cgroup v2 `memory.events` `oom_kill` when a command step starts and again when it ends
  (the kernel counts a kill before the victim is gone, the adapter reports the end after). A rise plus exit 137/SIGKILL (Codex `_meta.terminal_exit` or
  `rawOutput.exit_code`; Claude's "Exit code 137" text, the number only), or a failed step with no exit said, marks `tool.completed {reason:'out_of_memory'}` and
  sends `run.notice {kind, step_id, title, limit_mib?}` (at most 3 a run). No cgroup v2 (macOS, Windows, v1): nothing marked. Two runs of one bridge can blame
  each other's kill only when the other step also ended killed or failed with no exit (R11).
- **Site:** `notice` is a `BotRuntimeEvent`; the gateway reads only the fixed kind, the step and title, a sane limit; the run job posts the platform's own sentence
  once a run through `postNotice` (no `runId` in meta, so the reply and failure notice are unchanged). The tool result reads "out of memory".
- **Words:** "Where you run" says the exit-137 sign and the focused checks in every place, the size where known (pods: the run container's limit); Coder, Tester,
  Code reviewer, Deployer, Web smoke tester and the demo Coder/Tester say the same. Live team copies need P31-03's sync.
- **Memory under the Helm maximum:** the pod controller cuts `claudePod.resources` memory to 4Gi (`MAX_RUN_MEMORY`) and the request to the limit.
- **Not built (still section 3):** a scope per run with `MemoryMax` (`systemd-run`), `mtruns.slice`, the pod guard (a container OOM still ends the pod:
  `memory.oom.group=1`), the steering line to the agent, the activity card's "out of memory" word (clients/web), the live proofs of section 7.

## P31-04 step 2 as built (2026-11-25; overrides "Not built" above)
- **A scope per run on a server:** the helper's table gains `runScope {systemdRun, memoryMaxBytes, bindsTo}`, written by the installer only with `systemd-run` and systemd ≥ 253.
  For a bot's run (claude, codex, hermes) the helper starts `systemd-run --scope --quiet --collect --slice=mtruns.slice --unit=mt-run-<team user>-<tag>.scope -p MemoryMax=<n>
  -p MemorySwapMax=0 -p OOMPolicy=continue -p BindsTo=<bridge unit> -p After=<bridge unit> -- <setpriv …>` (pure `scopeArgv`, `scopeFor`). It first starts an empty probe scope
  (`/bin/true`) with the same settings: a machine whose systemd refuses one of them runs as before, weighted by `oom_score_adj` only. At the end the helper stops the scope.
  `<tag>` is the header's new `runTag` (`^[a-z0-9]{8,32}$`, sent by `TeamRun`), so the bridge reads `/sys/fs/cgroup/mtruns.slice/<unit>/memory.events` and `memory.max`
  (`scopeMemoryWatch`, falling back to its own group). Installer: `--run-memory` (default 4G, lower only, at least 256M), `--runs-memory` (default 40 % of MemTotal, lower only),
  `/etc/systemd/system/mtruns.slice` with `MemoryMax`, removed at uninstall.
- **The pod guard** (`src/memory-guard.ts`): every 500 ms the bridge reads its own group's `memory.max` and the programs' memory (`memory.stat` `anon` + `shmem`, since an ACP
  pod's /dev/shm is memory-backed; else `current − inactive_file`); at `≥ max − min(max(512 MiB, 10 %), 25 %)` (3.5 GiB of 4) it SIGKILLs the largest-RSS descendant of a run's
  adapter of at least max(64 MiB, a quarter of what is over), never pid 1, the bridge, an adapter, an agent at any depth (status name or first words `claude`, `codex`, `codex.js`,
  `hermes`, the configured bins) or a program between the adapter and an agent (codex-acp → `node codex.js` → `codex`); under a 1.5 GiB limit it only logs; 2 s between kills.
  Its kills count as out-of-memory kills for the frames (`withGuardKills`), each for the run whose adapter the program was below. With
  limit "max" it only logs when MemAvailable < 10 %. Team runs on a server are not watched by it (another user's programs; their scope has its own limit).
- **The card:** a `tool_result` line keeps `reason: 'out_of_memory'`; the run card's step says "Out of memory" where it would say "Failed".
- **Still to measure live:** that `systemd-run` from the helper (started by sudo inside the bridge's sandboxed unit) creates the scope and that `BindsTo=` is accepted (the probe
  falls back if not); the process tree of a Claude and a Codex run in a pod (is a Codex command a direct child of `codex-acp`?); the container OOM test of section 7.

