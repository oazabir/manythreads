# Phase 26 · Agents anywhere: Hermes, Claude Code and Codex in a pod or on an enrolled server

Owner request, 2026-11-15, in short: Codex in a pod must run with full permission (the `codex --yolo` behaviour) and must be shown pushing to GitHub; an admin who
configures a server that has Hermes, Claude Code or Codex gets one `curl` command that installs the agent bridge and connects the server to manythreads; then six live
proofs (three agents, each in a pod and on an enrolled server), each one a delivery the Engineer bot orchestrates from plan to a pull request on GitHub, with a test
deploy into k3s and a browser check on the way; and at the end the owner gets the links to the six threads.

**Stop criteria:** built and tested; the six threads exist and each one shows plan, code, review, test, deploy to the test namespace, browser check and a pull request
on GitHub made by the chain; in at least one pod thread and one server thread the pull request was opened by a **Codex** Committer run and its one commit has
exactly the tree of the commit Codex made and Tester tested (the publisher squashes the card into one commit authored as the requester, so "Codex's own commit" on
GitHub means its tree, not its hash); the owner has the six links.

Status: draft (2026-11-15), reviewed once (see "Review changes" at the end). Goes into PLAN.md after the owner answers §9.

Words used on this page:
- **Agent bridge** (`tools/agent-bridge`): the small program that starts one agent process per run and speaks the platform's run protocol (start, events, stop).
- **ACP** (Agent Client Protocol): the JSON-RPC protocol the bridge uses to drive `hermes acp`, `claude-agent-acp` and `codex-acp` (docs/plans/acp.md).
- **Runner**: a place a bot runs, a row of the `bot-runners` catalog that an admin sets up (docs/plugins/bot-runners.md).
- **Agent pod**: one Kubernetes pod per runner, made by the `claude-pods` plugin, with the bridge inside it.
- **Enrolled server**: a machine outside the cluster where the installer has put the bridge and which keeps a connection open to the site.
- **Profile**: one named entry in the bridge's config (`/p/<profile>/v1`): which agent, which working folder, which sign-in folder.
- **Chain**: the Engineering team's delivery bots (engineer, plan-reviewer, coder, code-reviewer, tester, committer, deployer, web-smoke-tester).
- **Publisher**: the separate process that pushes a card's tested work as one commit and opens the pull request, so the bot never holds the push token (claude-pods.md).
- **Test namespace**: `test-manythreads` in the devbox's k3s, where the Deployer installs a copy of manythreads at `https://test.manythreads.kahf.to`.

---

## 1. Where things stand (checked in the code, 2026-11-15)

| Piece | Today | What blocks the six proofs |
|---|---|---|
| Bridge, ACP driver | `tools/agent-bridge/src/drivers/acp.ts`, `acp/adapter.ts`: one adapter process per run, permission requests become approval cards, sign-in routes `/v1/auth/*` | Codex is started in the mode its grants give (`desiredMode`: `workspace-write` or `read-only`): no `.git` writes, no network, so every git write and network command became an approval (about 30 in P25-16), and a No ends the run with the generic "something went wrong on our side" (`runtime-hermes/src/failure-notice.ts`) |
| Agent pods | `claude-pods` plugin, kinds `claude_cli` / `codex_cli`, image `deploy/images/claude-pod` (node:22-slim, `claude` 2.1.318, `codex` 0.166.0, bridge, publisher, `mt-git`, keeper) | profiles use the CLI drivers (`render.ts` `buildBridgeConfig` sets no `driver`); no ACP adapters, no Hermes, no Chromium, no kubectl or helm, no `script` program (the Claude paste-code sign-in needs it); the pod is scaled to zero until a sign-in **file** is uploaded (the owner forbids copying sign-in files); the agent-auth proxy works only for gateway runners; no deploy credential; bots of one pod share no repository; **Claude and Codex pods are off on the live site** (`claudePod` is not in `values-live.yaml`) until the owner accepts the permission list in claude-pods.md |
| Managed Hermes pod | `hermes-pods`, one pod per team, Hermes gateway (not ACP), workbench with Chromium, kubectl, helm, the `test-manythreads` kube context for the deployer bot, `mt-publish.sh` through sudo | works today; it is the model for what an agent pod must offer |
| Host bridge (P25-16) | hand-built: systemd unit `manythreads-bridge` **running as root**, 24 hand-written profiles in `/etc/manythreads-bridge/config.json`, `/usr/local/bin/mt-publish-host` reading `/root/.git-credentials` | not repeatable; a bot with full access there could read every secret on the devbox, so it can never get full access |
| Outbound connection pattern | the `runners` plugin (`docs/plugins/runners.md`): a machine dials `wss://<site>/api/runners/connect` with a token, heartbeats every 20 s, one replica | proven shape to copy for the bridge (it runs Hermes CLI jobs for one team; it is not the bridge) |
| Test deploy | the Deployer follows `deploy/preview/README.md`: a kaniko Job inside `test-manythreads` builds the images and pushes them to the in-cluster registry, then `helm` installs | the bot only needs `kubectl`, `helm` and a kubeconfig with the `test-manythreads` context; no Docker, no registry access from where the bot runs |
| Chain texts | Committer: `sudo -u repo /usr/local/bin/mt-publish.sh`, `/workspace/repos/<project>.git`; Deployer: the kube context; Tester and Web smoke tester: "Playwright with Chromium is installed" | written for the managed Hermes pod; on the host they were met by hand-written profile notes |
| Leftovers of P25-16 | PLAN.md P25-16 row, MISTAKES.md P25-16 entries | No to a Codex step ends with the generic failure; to-do items left open; Web smoke tester could not read the private note (`tasks.private_note` answers only the bot the **latest** handover gave the card to); `e2e/admin/runners.spec.ts:432` expects 3 agent options, the form shows 5; Committer titles lack the task id |
| Devbox | 96 GB disk at 74% (26 GB free; the deploy guard stops above 70%), 15 GB memory of which 7.7 GB was available on 2026-11-15, shared with the live site, k3s, Postgres and the teams' Hermes pods | **no deploy can run today** until about 4 GB are freed (P26-00); room for one agent pod and one test install at a time, not more. Docker holds no workbench or claude-pod image (deploy.sh deletes Docker's copy after the k3s import), only k3s does |
| Hermes in a pod | the managed Hermes pod already ran the whole chain (P14-10) | nothing: it is a pod running Hermes. It is not ACP, which the owner did not ask for in words (§9 question 4) |

---

## 2. Decisions this plan takes (the owner may overrule any; open ones are in §9)

1. **One agent pod image for Claude Code and Codex**, `deploy/images/agent-pod`, `FROM` the **same pinned Playwright base digest as the workbench**
   (`mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7…`), not `FROM` the workbench image: Docker no longer holds the workbench (deploy.sh drops Docker's copy after
   the k3s import) and a rebuilt workbench would have new layer digests for everything above the base, so nothing would be shared. The Playwright base layers (about
   2 GB, Chromium, Node 22) are byte-identical to the ones k3s already holds for the workbench. On top: git, kubectl and helm by checksum (the workbench's own lines),
   the agents and the bridge. It replaces `claude-pod`.
2. **Runner kinds:** keep `claude_cli` and `codex_cli`, now driven through ACP (`driver: "acp"`); add `server_agent` (one agent on an enrolled server, ACP). Hermes in
   a pod is the **managed Hermes pod** the team already has (recommended answer to §9 question 4: nothing to build, it already ran the chain). A `hermes_acp_pod`
   kind (Hermes over ACP in the agent pod) is built only if the owner asks for ACP in the pod too (optional row P26-09h). The CLI drivers stay only for
   old hand-made gateway runners until P25-17.
3. **Full access for Codex:** on by default in an agent pod (the pod is the sandbox); off by default on an enrolled server and needs two keys there (the machine's
   installer flag and the admin's switch). On a server with full access on, the **whole server** (all its runners) serves one team, because every agent there runs as
   the one user `manythreads-bridge` and can read the bridge key, the other agents' sign-in folders and the deployer's kubeconfig (§5.5). Claude Code keeps its
   allow-list (no bypass mode); Hermes keeps its profile toolsets. Details in §4.
4. **GitHub:** the bots still never hold the push token. "Pushed into GitHub" is the publisher's branch and pull request; the operator merges. "Codex can push" is
   proven by a Codex-run Committer whose `mt-publish` puts the branch on GitHub and opens the pull request, and by the commit on GitHub being the one Codex made and
   Tester tested. The other way (a narrow push token in the pod) is §9, question 2.
5. **The enrolled server dials out.** The bridge opens one WebSocket to the site and the site's requests to the bridge travel inside it, so a server behind NAT or a
   firewall works and the bridge listens on no port. Details in §5.
6. **One way to sign in an agent:** the interactive sign-in through the Runners page (Codex device code, Claude paste code) into a sign-in folder of its own (in the
   pod's state volume, or `/var/lib/manythreads-bridge/auth/<agent>` on a server). No sign-in file is uploaded or copied for these runners, and the host's own
   `~/.claude` and `~/.codex` are never touched.
7. **Hermes models on an enrolled server go through the site's run proxy** (`POST /api/llm/runs/<runId>/v1/chat/completions`, gateway-llm `run-proxy.ts`; it uses the
   bot's own LiteLLM key, which each Engineering bot already has) with the run's own token (and in a `hermes_acp_pod`, if that is built), if the spike shows `hermes acp` takes a per-process model address and key (P26-01). Then the pod and the server hold no model key, and Hermes spend
   lands on the workspace ledger under the bot, where the $10 cap sees it (P25-16 found it outside). If it does not, each bot gets its own LiteLLM key as in the
   managed Hermes pod.
8. **The proofs run one at a time** on the devbox: one agent pod up, one test install, no live deploy, no CI run (CI shares the dev database) at the same time.

---

## 3. Pod mode over ACP

### 3.1 The image (`deploy/images/agent-pod`)

`FROM` the workbench's pinned Playwright base digest (decision 1; k3s already holds those layers). The build pulls that base into Docker once (about 2 GB, gone after the
import with the rest of Docker's copy). Added on top, every version pinned:

| Part | Version | Why |
|---|---|---|
| `@anthropic-ai/claude-code` | the version the host runs (2.1.323 measured) | the program `claude-agent-acp` drives (`CLAUDE_CODE_EXECUTABLE`) |
| `@openai/codex` | 0.166.0 | the program `codex-acp` drives (`CODEX_PATH`) |
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 | as measured in docs/spikes/acp-measured.md |
| `@agentclientprotocol/codex-acp` | 2.6.0 | same |
| git, kubectl, helm | the workbench's pinned versions and checksums | the Deployer (deploy/preview/README.md) |
| Hermes (only if `hermes_acp_pod` is built) | 0.21.5, copied from `manythreads/hermes:stable` at the same path (a Hermes install cannot move) together with the python it runs | `hermes acp`. P26-01 must show it starts on this base (glibc, its python) and with a **read-only root**: starting it with another `HERMES_HOME` rewrites the install's launcher (MISTAKES P25-16), which on a read-only root either fails the start or must be pointed at a writable copy |
| `bsdextrautils` | distro | the `script` program for Claude's paste-code sign-in (P25-09 runs it under `script -q -e -f -c`) |
| bridge, publisher, `mt-git`, `mt-publish` client, `repo-sync.sh` | from the repo | as in `claude-pod` |

The image runs as uid 1000 with a read-only root, like `claude-pod`, and `allowPrivilegeEscalation: false` on every container (the Playwright base has no sudo; if a
later layer brings one, this keeps it inert); `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point into `/state`, `/tmp` is an `emptyDir`. `tools/devbox/deploy.sh`
stages and builds it only when `claudePod.enabled` is on, and tags it by content. P26-08 records its size; the target is under 800 MB of new layers over the
Playwright base, and the disk is measured before and after the first import.

### 3.2 How each runner kind maps

| Kind | Bridge profile per bot (`<team>--<bot>`) | Sign-in | Model |
|---|---|---|---|
| `claude_cli` | `agent: claude-code`, `driver: acp`, `acp.command: /opt/acp/node_modules/.bin/claude-agent-acp`, `authHome: /state/claude`, `extraAllowedTools` = `mt-git` list + `mt-publish` | Claude paste code | the account's subscription |
| `codex_cli` | `agent: codex`, `driver: acp`, `acp.command: …/codex-acp`, `authHome: /state/codex`, `fullAccess` (§4) | Codex device code | the account's subscription |
| `hermes_acp_pod` (optional, §9 q4) | `agent: hermes-acp`, `HERMES_HOME=/state/hermes`, one Hermes profile per bot so each bot gets only its own toolsets (P26-01 checks that `hermes -p <profile> acp` honours them; the bridge's `acp.gives` per profile is then that bot's grants) | nothing to sign in | run proxy (decision 7) |

`buildBridgeConfig` (today it writes no `driver`, so the CLI driver runs) writes `driver: "acp"` and the `acp.command` for both kinds; `AGENTS` gains a `hermes`
entry only with the optional kind. Migration `bot-runners/0007` widens the `kind` CHECK with `server_agent` (and `hermes_acp_pod` only if built; the
`schema-enums` test compares the order with the Zod enum).

### 3.3 Sign-in into the pod's state volume

- The controller no longer waits for a sign-in file: a new pod runner gets its Deployment at once, with an empty `state` volume, and stays `waiting_for_sign_in`.
- The agent-auth routes (`/api/admin/bot-runners/:id/agent-auth…`) learn pod runners: the server finds the pod's bridge address and key through the `claude.pods`
  provider's `bridge()` (it exists) instead of the runner's row. Everything else (audit line first, abuse limits, fixed sentences) is the P25-09 code.
- The Runners page opens the same Sign-in dialog on a pod runner. Codex: "Open this page and type ABCD-1234", then it waits. Claude: open the page, sign in, paste the code.
  When the bridge reports `signed_in`, the runner moves to `ready` (a status read in the same poll; no extra job).
- The keeper and its RBAC (the Role that may patch the sign-in Secret) are not made for these runners: the state volume is the only home of the login. A lost volume
  (a machine move, a deleted claim) means signing in again, and the page says so before a move.
- The upload-a-file sign-in stays in the code for existing runners and is hidden from the dialog of new ones (owner rule: no sign-in file copied between homes).
- One owner step per pod runner: two sign-ins (Claude, Codex) for the pod proofs. Hermes needs none.
- **Neither sign-in has been completed end to end yet**: acp-measured.md saw the Codex device-code URL and code and Claude's paste prompt, and stopped before a real
  account was used. P26-01 completes one of each in a scratch folder inside the image (an owner step: the owner types the code). Codex's device-code sign-in also
  has to be allowed for the ChatGPT account (a setting in ChatGPT's security settings, if the account shows one); the dialog says so when the adapter refuses it.

### 3.4 What a pod needs to code, test, deploy and check

- **One repository per team inside the pod.** Today each bot of a Claude pod has its own clone and the clones share nothing, so Tester cannot see Coder's branch.
  `repo-sync.sh` also makes a bare repository of record at `/work/<team>/repos/<project>.git` (the Hermes pod's layout), each bot's clone gets it as `origin`
  for card branches, and its `update` hook refuses `main`, deletes and forced pushes. All bots of a pod share one uid, so the hook is a guard rail against mistakes, not a wall;
  that is why decision 3 limits a full-access pod to one team (§4).
- **Disk:** one pnpm store per pod on the work volume (`/work/.pnpm-store`, same file system, so installs are hard links). Only Coder and Tester install the monorepo.
  The work volume grows from 10Gi to 20Gi for agent pods (chart value). The proof checklist (§6.2) frees space before each pod proof.
- **Tests that need Postgres: not built in this phase.** The six fixes are chosen so that their tests need no database (§9 question 9); Tester's text already limits
  itself to the packages a change touches and says so when a test needs a database it does not have. A database container per pod is a later row if a real need shows.
- **Deploy into `test-manythreads`:** the `hermes-pods` plugin already writes, per team, a deployer Secret in the pods namespace with `deployer.kubeconfig` (one context
  per deploy target, `test-manythreads` included) and, because `hermesPods.hostApiServer` is set live, `deployer.host.kubeconfig` (the same login with
  `https://127.0.0.1:6443`). `claude-pods` does not rebuild it: hermes-pods registers a thin provider (`deploy.kubeconfig`: team in, the Secret's name out, plus the
  host variant's text for a server) and `claude-pods` mounts that Secret into the run container, with `KUBECONFIG` set only in the deployer bot's profile. **A mount is
  per container, not per profile:** every bot of the pod (a full-access Codex too) can read the file. That is accepted because the account rules only the test namespace
  and the runner serves one team; the permission list says it. The build is the kaniko Job inside `test-manythreads` (deploy/preview/README.md), so the pod needs no
  Docker and no registry access. The Kubernetes API (6443) is opened only for a pod that carries the label `manythreads.io/kube-api=true`, which the controller sets
  when the runner holds the deployer bot (a second NetworkPolicy object; the chart's single policy today opens 6443 to every Claude pod for the keeper, which these
  runners no longer have). The test site is reached on public 443 (it resolves to the devbox's public address and comes back through the NAT, as it does for the
  Hermes workbench today).
- **The Deployer's wait:** the kaniko build takes 10 to 25 minutes (`kubectl wait --timeout=40m`), so the Deployer bot's run budget must be at least 45 minutes on the
  proof runners, and a Codex Deployer must poll in the same turn (P25-16); P26-05 writes both into the shared "Where you run" text.
- **Browser check:** Chromium and Playwright 1.56.1 come with the workbench base; `/dev/shm` gets a 1Gi memory volume as in the workbench.
- **Push:** the publisher container as today, with `mt-publish` reading the card branch from the team's repository of record in the pod.
- **Resources:** run container 4Gi memory limit (a monorepo typecheck needs it), `maxConcurrentRuns` 1 for the proof runners. 4Gi (agent pod) + 8Gi (the test
  namespace's quota, kaniko included) is more than the 7.7 GB available: it fits only because the Tester's typecheck and the kaniko build do not overlap in a
  sequential chain. §6.2 watches `free -h` at each hand-off.

---

## 4. Full access (the `--yolo` behaviour)

`codex --yolo` is `--dangerously-bypass-approvals-and-sandbox`. Under `codex-acp` the same is a start mode: the adapter's modes are `read-only`, `workspace-write`,
`agent` ("Auto review") and `agent-full-access` (docs/spikes/acp-measured.md). P26-01 measures that `INITIAL_AGENT_MODE=agent-full-access` gives no sandbox and no
command questions (or else `CODEX_CONFIG` with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`), that `git commit`, `git push` to the pod's
repository of record and `curl` to GitHub work, and that calls of the platform's own tools still ask (they are answered "for this session" by `sessionOption`, since the
platform checks every call).

| Where | Default | Who turns it on | What the Runners page says |
|---|---|---|---|
| Codex in an agent pod | on | it is on for every `codex_cli` runner that serves one team; an admin can switch it off | "Full access: Codex runs commands without asking. It is held by its pod: the pod reaches the site and the internet on port 443, and no other address in the cluster." |
| Codex on an enrolled server | off | both: the machine's owner installs with `--allow-full-access` (written into the bridge's config; the site cannot widen a machine's sandbox), and an admin switches it on for that runner, with a confirm that names the machine | "Full access on <machine>: Codex runs any command as the user `manythreads-bridge` on that machine, without asking." |
| Claude Code (pod or server) | not offered | - | "Asks before commands its bots are not granted." The bot's `shell` grant already pre-approves Bash; no bypass mode is added |
| Hermes | not offered | - | its toolsets follow the bot's grants |

Rules:
- The setting is a column `full_access` on `app.bot_runners` (migration `bot-runners/0007`, a CHECK that allows it only for Codex runners), changed only by an admin, sent in
  the run request (`manythreads.fullAccess`) and honoured by the bridge only when its own config also allows it (pods: the controller writes it; servers: the installer flag).
- A full-access runner serves exactly one team (its team list is one team, checked on save): every bot of a pod or a server shares one Unix user, so a second team's bots could read the first team's work.
  On a server the rule covers **every runner of that server** (checked on save of any of them), since the bridge key in systemd's credential folder, the other
  agents' sign-in folders and the deployer's kubeconfig are all readable by that user.
- What a full-access agent in a pod can reach, written in the permission list: the run container's files (the other bots' clones, the bridge's key, the deployer's
  kubeconfig when the deployer is on the runner), the site and the internet on 443. Not reachable: the publisher container's push token (another container, another
  file system) and any other cluster address.
- P26-01 also measures the middle way for a server: `workspace-write` with `sandbox_workspace_write.network_access = true` (and whether `.git` stays read-only in
  it). If git commits and network then need no question, that is the server default instead of "every git write asks", and full access on a server stays the
  owner's two-key option.
- The event `bot_runner.runner.updated` lists `full_access` among the changed settings; audit records who switched it.
- A deny still exists for questions that remain (an MCP call the platform refuses comes back as the tool's answer, not a question).
- MISTAKES P25-16 says an agent must not widen the sandbox on its own and the auto-mode classifier refuses it. This phase builds the switch as a product setting the owner asked for;
  **turning it on live is an owner step** (§6.2), done on the Runners page by the owner, not by an operator script.

---

## 5. The enrolled server

### 5.1 What the admin does

Settings > Workspace > Runners > **Add a server** asks for a name (`devbox`, lower case, never changes) and a label, then shows one command with a copy button:

```
curl -fsSL https://<site>/install/bridge.sh | sudo bash -s -- --enrol mte_<one-time code>
```

and, under it, the careful way (download, read, check the hash the page shows, run) and the variant that asks for the code so it is never in shell history or in
`ps` (`… | sudo bash -s -- --enrol -`: the script reads the code from `/dev/tty`, never from standard input, which is the script itself under `curl | bash`).
The code is single use, valid 15 minutes, bound to that server row, and only its SHA-256 is kept. The whole script is one `main` function called on its last line,
so a download cut short runs nothing. The hash on the page is checked against the same site, so it guards against a broken download, not against a site that was
taken over; the page says that in one line. The page then waits and shows
"Waiting for devbox to connect…", and when the server connects: its host name, system, bridge version and the agents it found, each with a **Sign-in** button.

### 5.2 What the script does

1. **Checks:** Linux on x86_64 or arm64 with systemd, run as root, `curl`, `tar`, `sha256sum`, free disk above 3 GB, the site reachable on 443. Stops with a plain line otherwise.
2. **Node 22:** uses the host's when it is 22 or later; otherwise downloads the official Node 22 tarball into `/opt/manythreads-bridge/node`, checked against a hash pinned in the script.
3. **The bridge bundle:** `https://<site>/install/bridge-<version>.tgz` and its `.sha256`, served by the site itself (built into the server image at deploy time):
   the bridge as one bundled file, the publisher, and a `package.json` + `package-lock.json` that pin `claude-agent-acp` 0.107.0, `codex-acp` 2.6.0,
   `@anthropic-ai/claude-code` and `@openai/codex` at the pod image's versions. The script runs `npm ci --omit=dev --ignore-scripts` into `/opt/manythreads-bridge/agents`
   with that lock file, so every package is checked against the lock's integrity hash and the server image grows by a few hundred KB, not by the agents' 300 MB per
   architecture (P26-01 checks the four packages work with `--ignore-scripts`). The bridge never fetches an adapter (conventions: installed by the operator, pinned).
4. **A user of its own:** `manythreads-bridge` (no login shell, no sudo). Folders: `/opt/manythreads-bridge` (program, root-owned), `/etc/manythreads-bridge`
   (config and key, 0600), `/var/lib/manythreads-bridge/{state,auth/claude,auth/codex,hermes,work}` (owned by the user).
5. **Finds the agents:** `claude`, `codex` and `hermes` on the PATH of root and of `SUDO_USER`, with their versions, and **reports** them (this is how the admin
   sees "this server has Claude Code, Codex and Hermes"); `--no-hermes`, `--no-claude`, `--no-codex` leave one out. The bridge does **not** run the host's
   programs: they usually live under `/root/.local/bin` or a person's home, which the service user cannot read and `ProtectHome=true` hides, and they update
   themselves. It runs the pinned copies of step 3 (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`) with its own sign-in folders. Hermes: the script installs Hermes 0.21.5
   from its pinned git tag (commit checked) into `/var/lib/manythreads-bridge/hermes` with its own `HERMES_HOME`, because starting the host's Hermes with another
   home rewrites the host's launcher (MISTAKES P25-16).
6. **Browser:** Playwright 1.56.1's Chromium into `/opt/manythreads-bridge/ms-playwright` plus its system libraries (`playwright install --with-deps chromium`,
   which uses apt and needs root; on a system without apt the script stops with a plain line) — `--no-browser` skips it — and `PLAYWRIGHT_BROWSERS_PATH` in the
   profiles. About 600 MB with the libraries; the free-disk check of step 1 counts it.
7. **Config:** written by the script, no profile by hand (§5.4). `--allow-full-access` adds the machine's half of the Codex full-access rule.
8. **Enrol:** `POST /api/bridge/enrol {code, host facts, agents, bridge version}` answers the server id and a long-lived bridge key (`mtb_` + 256 random bits, stored
   on the site as a hash). The key goes to `/etc/manythreads-bridge/key` (0600, root, read by systemd as a credential), never to a log or the terminal.
9. **systemd unit** `manythreads-bridge.service`: `User=manythreads-bridge`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp`,
   `ReadWritePaths=/var/lib/manythreads-bridge`, `LoadCredential=key:/etc/manythreads-bridge/key`, `Restart=always`. Started, and the script waits until the site says
   the server is connected, then prints the Runners page address.
10. `--update` (no code: uses the key in place) and `--uninstall` (stops and removes the unit and the program, tells the site, keeps `work` unless `--purge`).

### 5.3 How the site reaches the bridge: an outbound tunnel

The bridge opens `wss://<site>/api/bridge/connect` with its key and keeps it open (heartbeat every 20 s, well inside Cloudflare's 100 s idle cut, which the live
address passes through; reconnect with a growing pause up to 30 s; the key is checked again at every heartbeat, as the `runners` plugin does, so a removed server is
cut within 20 s). A new socket for a server closes the old one. The site sends HTTP requests to the bridge **inside** that socket: each request gets a stream id; the
answer comes back in frames; a server-sent event stream stays a stream. On the site this is a provider `bridge.tunnel` with one `fetch(serverId, request)`, which
runtime-hermes (`gateway.ts` already takes `options.fetch`) and bot-runners (Test, agent-auth) use when a runner is a `server_agent`. The bridge hands each
request to its own request handler in memory; it listens on no port.

The tunnel carries **only the site's requests to the bridge**. What the bridge or the server's publisher needs from the site (the push credential, the deployer's
kubeconfig, MCP calls of the agents) is an ordinary HTTPS call to the site's address with the bridge key or the run's token, as any other client makes. That keeps
the push token out of the bridge's process (the agents' user) and keeps the tunnel to one direction.

Where the code lives: in the `bot-runners` plugin (it owns the runner rows, the agent-auth routes and the Runners page's API), not a new plugin. If the socket
handling of the `runners` plugin is wanted, it moves into `@manythreads/sdk` first; plugins never copy each other's code (conventions).

Why a tunnel and not a direct address: a server behind NAT, a laptop or a cloud box with only outbound 443 works with no firewall change, no certificate on the
server, and no open port that anyone with the key could use. The cost is a small multiplexer on both sides and the one-replica rule (a server's socket lives in one
site process; the live site runs one replica, as the `runners` plugin already assumes). The old direct way (a gateway runner with an address and key) stays for
anyone who wants it.

Limits and the cases a live run will hit:
- **Size:** a request body at most 1 MiB (the bridge's own `MAX_BODY_BYTES`); a response is sent as many frames of at most 64 KiB, so a long event stream or a
  large status answer is never one frame (as built: the site's socket limit for this route is 128 KiB, `wsMaxPayload` on the route, because a 64 KiB chunk in base64 is about 87 KB of text; the review found the site-wide 64 KiB limit cut the tunnel at the first big answer, and `tunnel-site.test.ts` now sends 1.5 MiB through the real site). A stream whose unread frames on the site pass 8 MiB is closed (a reader that stopped reading).
- **Streams:** at most 64 open per server (one run holds two: its event stream and, briefly, an approval answer or a stop).
- **Cancel:** when the site aborts a request (`AbortSignal`, e.g. the run job gives up on the event stream), the tunnel sends a `cancel` frame and the bridge
  closes that request as if the client went away, so the run's subscriber is dropped (`req.on('close')` in `server.ts`). Stopping a run stays its own
  `POST /v1/runs/<id>/stop`.
- **A dropped socket does not fail a run.** The run goes on on the machine and the bridge keeps its frames; the site's event reader asks again with
  `Last-Event-ID` (the bridge already resumes from it) once the socket is back. Only a socket gone for more than 60 s, or a bridge that restarted (the run is
  unknown), ends the run with "the server <name> disconnected".
- **Waits:** a request waits at most what the caller already waits (70 s for sign-in calls).
- **Logs:** a frame's body is never logged on either side (a run request holds the run's MCP token); the log line is the stream id, method, path, status and size.
- **Path safety:** the team and bot slugs in a profile name are checked against the slug pattern before they become a folder (`work/<team>/<bot>`).

### 5.4 How an enrolled server becomes runners, with no profiles written by hand

- Table `app.bot_servers` (workspace-owned, forced row-level security, admins only): name, label, host facts, bridge version, agents found, key hash, `last_seen_at`,
  status (`waiting`, `connected`, `offline`, `removed`).
- On enrolment (and when the agents found change) the site makes or updates **one runner per agent**, kind `server_agent`, named `<server>-<agent>` (`devbox-claude`,
  `devbox-codex`, `devbox-hermes`), with `server_id` and `agent`, open to no team until the admin chooses. Its profile rule is fixed, `{agent}--{team}--{bot}`, and not shown.
- The bridge in server mode answers **any** profile name of that form from a template per agent: working folder `work/<team>/<bot>`, the agent's own sign-in folder,
  `driver: acp`, the "Where you run" text (§5.6), and for Hermes one Hermes profile per bot made on first use with that bot's toolsets. A profile name that does not
  match the form is a 404, as today. So adding a bot or a team needs nothing on the machine.
- Sign-in: the same dialog and routes as a pod. The page says "This server's own sign-in folder for Claude Code; your account on that machine is not touched."
  The script never reuses the host's logins (owner rule).
- **Rotate key** on the page sends a new key over the open socket, the bridge writes it and reconnects with it, then the old hash is dropped. A second Rotate while one waits is a 409; one waiting more than 15 minutes (`pending_key_at`) is replaced. **Remove server** revokes
  the key, closes the socket, and is refused while bots are placed on its runners (the delete guard).

### 5.5 Security

- Enrolment code: single use, 15 minutes, `rateLimitBy: 'address'`, a lockout on wrong codes (`guardRedemption`), listed in `ABUSE_ROUTES` and
  `docs/deploy/rate-limits.md` (conventions D5). A used or expired code answers the same as an unknown one.
- The bridge key is stored hashed, compared in constant time, never in an event, audit row or log; enrolment, connect, rotate and remove are audited.
- TLS is the site's own (the tunnel is `wss` to the public address); the bridge refuses `ws://` unless `--insecure-for-tests`.
- The script and the bundle come from the site over https, with a hash the page shows; no secret is ever an argument of a long-running process.
- What a bot on an enrolled server can reach is everything the user `manythreads-bridge` can reach on that machine. The page says so when a team is added. That
  includes the bridge key (systemd hands it to the process in a folder the same user reads: with it, an agent could connect as the server and receive the runs of
  every team placed there), the Claude and Codex sign-in folders of the server, and every service on the machine's own addresses. Hence the one-team rule of §4 for a
  server with full access, and the note on the page for any server with more than one team.
- On the devbox itself: the service user reaches `127.0.0.1:6443` (needed by the deployer) and the other local ports (the registry's NodePort, the dev Postgres).
  None of them accepts a request without its own credential, which this user does not hold; P26-19 lists the local ports (`ss -ltn`) before proof 4 and writes
  the list into the record.
- No secret on a command line: the bridge key is read from the credential file, the enrolment code from the tty, the push token from the publisher's own call.

### 5.6 The same bot texts on a pod and on a server

*As built (P26-15):* the publisher is its own unit and user on a socket for the bridge's group (`manythreads-publisher`), asking the site for the push document per publish (`GET /api/runs/self/push-credential`); the deployer's login comes from `GET /api/runs/self/kubeconfig`; the repository list from `GET /api/bridge/repos`; the per-run profile is made in `tools/agent-bridge/src/server-run.ts` and the repository sync is supervised by `server-repos.ts`. Details: `docs/agent-bridge.md` (enrolled server). The container test of the installer is `tools/agent-bridge/install/container-test/run.sh`.

A bot's text must not care where it runs. Three changes:
- **One publish command, `mt-publish`, everywhere.** The workbench gets `/usr/local/bin/mt-publish` (it calls `sudo -u repo mt-publish.sh`), the agent pod has its
  publisher client, and an enrolled server gets a publisher of its own: a second unit, user `manythreads-publisher`, listening on a Unix socket only the bridge's
  user may open. For each publish it asks the site directly over HTTPS (not through the bridge) for the push credential of that project, with the run's token (the site answers only for a live run
  whose bot grants `tasks.pull_request`, for a project of the run's team), runs `mt-publish.sh` on the bot's folder, and forgets the token. The bot never sees it.
- **One repository of record per team** with the same relative place: `/workspace/repos` (Hermes pod), `/work/<team>/repos` (agent pod),
  `/var/lib/manythreads-bridge/work/<team>/repos` (server). The Committer's and Tester's texts say "the team's repository of record (its folder is in Where you run)".
- **"Where you run" is made by one function** (`packages/shared/src/runners/where-you-run.ts`, pure text): the folders, `mt-git` or plain git, `mt-publish`, the
  kube context when the bot is the deployer, the browser, and for Codex the three notes P25-16 needed (the platform's tools are found by tool search; poll a long
  command in the same turn; do not leave a process in the background). Pods and servers call it; nobody edits a profile's `instructions` by hand again.
- On an enrolled server the deployer bot's profile gets the `deployer.host.kubeconfig` text from the same `deploy.kubeconfig` provider, fetched by the bridge
  over HTTPS with its key when the profile is first used, written 0600 in that bot's folder. The test namespace's API must be reachable from that machine (true on the devbox; a remote server needs the
  cluster's API address open to it, which this phase does not add).

---

## 6. The six live proofs

### 6.1 Runners and order

| # | Runner | Agent | Where | What it must show beyond P25-16 |
|---|---|---|---|---|
| 1 | `pod-claude` (`claude_cli`) | Claude Code | agent pod | the chain in a pod over ACP; pod sign-in from the page; deploy and browser check from the pod |
| 2 | `pod-codex` (`codex_cli`, full access) | Codex | agent pod | no command questions; Codex's commit on GitHub through the publisher |
| 3 | `managed` (the team's Hermes pod; `pod-hermes` over ACP only if §9 q4 says so) | Hermes | managed Hermes pod | the full chain with the P26-02…05 fixes, a pull request by the chain; run first, as the baseline |
| 4 | `devbox-claude` (`server_agent`) | Claude Code | enrolled devbox | the curl install; generated profiles; the server's own sign-in folder |
| 5 | `devbox-codex` (`server_agent`, full access) | Codex | enrolled devbox | full access with the two keys; Codex's commit on GitHub through the server's publisher |
| 6 | `devbox-hermes` (`server_agent`) | Hermes | enrolled devbox | the bridge's own Hermes install; no launcher rewrite on the host |

Order: 3 (the managed pod needs no new build, so it checks P26-02…05 and the proof checklist on known plumbing), then 1, 2, then 4, 5, 6. Pods before servers,
because their plumbing (publisher, controller) is the older, tested part and the owner's request lists them first.
The enrolled server is the devbox itself (the only machine); the hand-built root bridge unit is stopped (not deleted) before proof 4 and its `acp-*` runners are switched off.
If the owner offers a second machine, proofs 4 to 6 run there instead and the test deploy needs that machine to reach the cluster's API (§5.6).

### 6.2 For each proof

Before:
- `df -h /` under 65% (free space first: `docker builder prune -af`, stale `node_modules` under `/tmp`, the previous proof's agent pod scaled to zero and its work claim
  deleted, registry tags of the previous test images removed by the operator); never `k3s crictl rmi --prune` and never `DEPLOY_ALLOW_HIGH_DISK=1` (MISTAKES).
- `free -h` above 4 GB available, checked again at each hand-off to Tester and to Deployer (stop the thread below 2 GB); no CI run going (CI shares the dev
  database); no deploy of the live site during the run. If memory is short, the owner may let the operator scale idle teams' Hermes pods to zero for the run
  (§9 question 10); the live site's own pods are never touched.
- The approval path works: one test approval card for the proof's runner is answered on the deployed site by a person pressing the button (CLAUDE.md "Every change").
- The test namespace clean: `helm uninstall` of the previous copy and its Jobs (deploy/preview/README.md §8).
- Only this proof's runner is enabled among the six; the chain moved to it with `tools/devbox/place-engineering-bots.mjs engineering <runner>` (all eight bots, before the
  thread starts: a pod rolls when its bots change and a run in flight ends). The team's live bot copies synced (`sync-engineering-bots.mjs engineering`, dry run read first).
- Owner steps when the runner is new: sign in (Claude or Codex) on the Runners page; for 2 and 5 switch full access on.
- `GET /api/workspace/llm/spend` noted.

During: one thread in `#dev` of Engineering, written as Omar (`tools/self-build/run.mjs start`), asking the Engineer for one small, real fix with a task id
(`P26-2x: …`). The Engineer plans with `tasks.todo`, hands off down the chain; a person answers only real approval cards and merges. Every nudge and every approval
answered is counted and written in the record. Aim: zero nudges; more than three is a finding to fix before the next proof, not something to absorb.

Done when, for that thread: plan reviewed; code reviewed; tests run by Tester on the runner; the copy installed in `test-manythreads` and `/healthz` answers at the test
address; Web smoke tester's Playwright run passed with the test account from the private note; the pull request open on GitHub with a title that starts with the task id
and the squashed commit whose tree is the tested commit (`git rev-parse <head_sha>^{tree}` equals the tested commit's tree; for proofs 2 and 5 the publish was
made by the Codex Committer's run, seen in the run's steps); the pull request merged by the operator; the to-do card all done; the run cards readable (light, dark, 390 px
screenshots kept under `temp/screenshots/p26/<n>/`). A live deploy only if the owner asks for it (§9, question 5).

After: the record in STATUS.md (thread id and link, PR number, commits, nudges, approvals, spend before and after, plan limits hit), the chain moved back to `managed`,
the runner switched off.

The link the owner gets for each thread is the one the app's Copy link gives: `https://<site>/t/engineering/c/dev?message=<root id>` with the thread opened.

---

## 7. Tasks

Same table shape as PLAN.md §8 (Phase 25). "Needs" names the tasks that must be done first. Every row: an independent review, its tests run inside its package
(`npx vitest run`), `pnpm lint` and `pnpm typecheck` green at the end, one heavy job at a time.

| ID | Task | Where | Needs | Tests | Done when |
|---|---|---|---|---|---|
| P26-00 | Make room before anything is deployed: disk under 65% (`docker builder prune -af`, stale `node_modules` under `/tmp`, old test-registry tags, old test Jobs; never `crictl rmi --prune`, never `DEPLOY_ALLOW_HIGH_DISK=1`), or the owner's bigger disk (§9 q6); `free -h` noted | the devbox | - | - | `df -h /` under 65% with the numbers in STATUS.md; without it no row below can deploy (the guard stops above 70%, the disk is at 74%) |
| P26-01 | Spike, measured in a container on the devbox (never on the host, never as root): Codex `agent-full-access` under `codex-acp` (no questions, git and network work, MCP calls still ask) and the server middle way (`workspace-write` + network, §4); Claude paste code and Codex device code **completed** with a scratch folder inside the image (the owner types the codes; this is the only way, since sign-in files are not copied); the four npm packages under `npm ci --ignore-scripts` (§5.2); Hermes on a server takes a per-process model address and key (the run proxy); only if `hermes_acp_pod` is wanted: Hermes on the Playwright base with a read-only root and `-p <profile>` toolsets; adapter start-up; image size | `docs/spikes/agents-anywhere-measured.md`, fixtures under `tools/agent-bridge/test/fixtures/acp/` | 00 | fixtures replay in the existing ACP tests | the page answers each question with a measured line; every later row cites it. Running Codex with full access may be refused by the operator's own permission classifier (MISTAKES P25-16): then the owner runs that one measurement and the page says so |
| P26-02 | A No ends the run in its own words: the bridge marks a run that ended after a refused permission `denied` (step title kept), runtime-hermes adds the notice "<person> said No to <step>, so <bot> stopped. Ask again with another way to do it." | `tools/agent-bridge/src/drivers/acp.ts`, `runtime-hermes/src/failure-notice.ts`, `gateway.ts` | - | bridge unit test with the fake ACP agent (deny then end), runtime-hermes notice test | a denied Codex step shows that sentence, not "something went wrong on our side" |
| P26-03 | Web smoke tester reads the private note: find why P25-16's tester was refused (handover order, the card's latest handover, the tool's name on ACP agents), fix it, and make Deployer hand the card straight to Web smoke tester with the note | tasks `capabilities.ts`, migration if the rule changes, `templates/engineering/bots/{deployer,web-smoke-tester}/BOT.md` | - | tasks test: deployer hands off with a note, smoke tester reads it, any other bot is refused | the chain's smoke tester signs in on the test site with no hand-over by a person |
| P26-04 | To-do items do not stay open: the Engineer links every item to its card (`taskId`), so items follow the cards; a follower pass when a run of the list's owner ends ticks items whose card is done; the Engineer's last step sets the rest to done or blocked | tasks `todo` follower, `templates/engineering/bots/engineer/BOT.md`, `TEAM.md` | - | tasks tests (card done, item ticks; run ends, catch-up) | a P26 proof thread ends with no open item |
| P26-05 | Runtime-neutral chain texts: `mt-publish` everywhere (workbench wrapper), "the team's repository of record", the Committer's title starts with the task id from the card or the request, `where-you-run.ts` shared text (with the Deployer's 45-minute budget and "poll in the same turn"); live team copies synced | `deploy/images/workbench`, `packages/shared/src/runners/where-you-run.ts`, `templates/engineering/bots/*`, `claude-pods/src/render.ts` | - | shared text test; workbench script test; the template lint | the same BOT.md runs in the Hermes pod, an agent pod and on a server |
| P26-06 | Full access: `full_access` column (migration `bot-runners/0007`, with the kind CHECK widened for `server_agent`, and `hermes_acp_pod` only if built), shared schemas, PATCH route, one-team rule (per runner in a pod, per server for `server_agent`), event field, bridge config key and run field, `desiredMode` maps it to the measured mode, Runners page wording | bot-runners, shared `api/bot-runners`, `tools/agent-bridge/src/acp/adapter.ts`, `config.ts`, web `screens/admin/runners` | 01 | migration and RLS tests, route tests (admin only, one team, Codex only), bridge test (both keys needed), web unit test of the wording | a Codex run on a full-access runner asks no command question in the fake agent's run |
| P26-07 | Codex keeps going: when a Codex run ends a turn without a final post or hand-off and budget is left, the bridge sends one "continue" prompt, at most three times per run; logged as a count | `tools/agent-bridge/src/drivers/acp.ts` | 01 | bridge test with a fake agent that stops early | proofs 2 and 5 need no hand nudge for a step that only ended early |
| P26-08 | The agent pod image (§3.1), `FROM` the Playwright base digest | `deploy/images/agent-pod/Dockerfile`, `tools/devbox/deploy.sh` staging | 01 | a build, then `claude-agent-acp`, `codex-acp`, `script`, `npx playwright --version`, `kubectl`, `helm` run in it with a read-only root as uid 1000 | built and imported; `k3s ctr` shows the base layers shared with the workbench; new layers and the disk before and after written in claude-pods.md |
| P26-09 | The controller over ACP for `claude_cli` and `codex_cli`: ACP profiles, pods without a sign-in file, no keeper for these runners, one repository of record per team, shared pnpm store, 20Gi work, `/dev/shm`, `allowPrivilegeEscalation: false`, the `manythreads.io/kube-api` label, resources | `packages/plugins/claude-pods/src/{render,reconcile}.ts`, chart `claude-pods.yaml`, `values.yaml` | 06, 08 | render tests per kind, the fake Kubernetes API reconcile tests, `repo-sync.test.ts` for the bare repository | a stage run (`claudePod.useFake`) brings up both kinds |
| P26-09h | Optional (§9 q4): the `hermes_acp_pod` kind (Hermes layer in the image, per-bot Hermes profiles, the run proxy as its model) | as P26-09 | 09 | render test | only if the owner chose ACP for the Hermes pod proof |
| P26-10 | Pod sign-in from the Runners page: agent-auth proxy for pod runners through `claude.pods` `bridge()`, signed in moves the runner to ready, upload hidden for new runners, confirm texts for a move ("you will sign in again") | bot-runners `agent-auth.ts`, sdk `claude-pods.ts`, web `AgentSignInDialog` | 09 | agent-auth route tests for a pod runner, web dialog test | the owner signs a pod in with a device code or a pasted code |
| P26-11 | Deploy from a pod: the thin `deploy.kubeconfig` provider in hermes-pods (the existing deployer Secret's name, and the host variant's text), the Secret mounted into the run container and `KUBECONFIG` in the deployer's profile, the second NetworkPolicy (6443 only for the labelled pod), the permission list in claude-pods.md updated for the owner (it says the kubeconfig and the bridge key are readable by every bot of the pod) | hermes-pods, claude-pods, chart, `docs/plugins/claude-pods.md` | 09 | provider test, render test (`KUBECONFIG` only in the deployer's profile, the label only with a deployer), chart test of the policies | the owner accepts the list and `claudePod.enabled: true` goes into `values-live.yaml` |
| P26-12 | The tunnel: `app.bot_servers` (migration, RLS), `GET /api/bridge/connect`, the `bridge.tunnel` provider with `fetch`, request and event streams in frames of 64 KiB, cancel frames, heartbeats with the key re-checked, a new socket replacing the old, the 60 s reconnect grace with `Last-Event-ID` resume, limits, bodies never logged; the bridge's tunnel client (no listening port in server mode) | `bot-runners` (migration, `src/tunnel/`), `tools/agent-bridge/src/tunnel.ts`, runtime-hermes uses the provider | 06 | in-process tests: a run and its events through the tunnel, a socket dropped for 5 s resumes the stream with no lost frame, one gone for 61 s fails the run with the plain line, an aborted fetch closes the bridge's request, a 3 MiB status answer arrives whole, 64-stream limit, a wrong key 1008, a removed server cut at the next beat, no token in any log line | a fake-agent run goes through the tunnel end to end in a test |
| P26-13 | Enrolment and the Runners page: mint a one-time code (admin), `POST /api/bridge/enrol`, runners made per agent found, Rotate key, Remove server, the page (Add a server, the command, waiting, the agents with Sign-in), abuse limits and audit | `bot-runners` routes, shared `api/bot-runners` (servers), `abuse-limits.ts`, `docs/deploy/rate-limits.md`, audit `MAPPERS`, web `screens/admin/runners` | 12 | route tests (single use, expiry, lockout, admin only), `abuse.test.ts` burst, events contract test, web tests | the page shows a server that a test bridge enrolled, with its three runners |
| P26-14 | The installer and the bundle: `GET /install/bridge.sh`, `/install/bridge-<version>.tgz` and `.sha256` from the server image (bridge, publisher, lock file; no agent binaries); the script (§5.2) as one `main`, the code read from `/dev/tty` with `--enrol -`, `npm ci --ignore-scripts` from the lock, Chromium with its libraries, Hermes from its pinned tag, `--update`, `--uninstall`, `--allow-full-access` | `tools/agent-bridge/install/bridge.sh`, bundle build step, server static route, `deploy/docker` | 13 | `shellcheck`; a container test: Debian and Ubuntu images (systemd in the container) run the script against a test stack and the server shows up connected; a cut-short download runs nothing; the code never appears in `ps` or the log; uninstall leaves nothing but `work` | the curl command from the page installs and connects on a clean container |
| P26-15 | Server mode of the bridge: profiles from per-agent templates (slugs checked), one sign-in folder per agent, the pinned `claude`/`codex` copies, Hermes under its own home with per-bot Hermes profiles and the run proxy as its model, the team's repository of record and clones (`repo-sync.sh`), the server's publisher (own user, credential fetched per publish over HTTPS), the deployer's host kubeconfig fetched over HTTPS, Playwright, "Where you run" | `tools/agent-bridge/src/{config,server-mode,publisher-host}.ts`, `deploy/images/claude-pod/publisher.mjs` reused, bot-runners credential route | 05, 12, 14 | bridge tests for the templates (no profile written, unknown form 404, `..` in a slug refused), publisher tests (refused without the grant, the token never in output), repo-sync tests | a bot placed on `devbox-claude` runs with no hand-written profile |
| P26-16a | Pod end-to-end: a pod runner's Sign-in against the Kubernetes stand-in; fix `e2e/admin/runners.spec.ts:432` (five options) | `e2e/admin/`, `e2e/runners/` | 10 | the specs | green locally, one Playwright run at a time |
| P26-16b | Server end-to-end: a `servers` stack mode with an in-process bridge enrolled over the tunnel and the fake ACP agent; Playwright: Add a server, the command, connected, Sign-in, a bot answers, Remove | `e2e/runners/`, `packages/test-utils/src/seed-servers.ts`, `e2e/fixtures/stack-server.ts` (changes the snapshot hash: day-1 and week-2 rebuild once) | 13, 15 | the specs | green locally, one Playwright run at a time |
| P26-17 | Docs: agent-bridge.md (install by curl, server mode, tunnel), claude-pods.md (agent pods, kinds, sign-in, full access, permissions), bot-runners.md, a guide page "Add a server", conventions.md (where full access is allowed), MISTAKES.md | docs | 06–16b | - | a reader can add a server and a pod runner from the pages alone |
| P26-18 | Live proofs 3, 1, 2 (managed Hermes pod first, then the agent pods), §6 | live site, `tools/self-build/run.mjs` | proof 3: 02–05; proofs 1, 2: also 07, 09–11, 16a | - | three threads meet §6.2; STATUS.md record |
| P26-19 | Live proofs 4 to 6 (enrolled devbox), §6; the hand-built root bridge stopped; the devbox's local ports listed | live site, the devbox | 14, 15, 16b, 18 | - | three threads meet §6.2; STATUS.md record |
| P26-20 | The report to the owner: the six links, the six pull requests, nudges and approvals per thread, spend; then P25-17 (retire the CLI drivers) can start | STATUS.md, PLAN.md row | 18, 19 | - | the owner has the six links |

Build order: 00 → 01 → 02, 03, 04, 05 (small, independent, one after another) → proof 3 on the managed Hermes pod (an early end-to-end check of 02–05 that needs
no new plumbing) → 06 → 07 → 08 → 09 → 10 → 11 → 16a → proofs 1, 2 → 12 → 13 → 14 → 15 → 16b → 17 → 19 → 20. Deploy after each row that changes what runs, check,
commit, push (`bash tools/devbox/deploy.sh`; disk first).

Sizes, so the order can be planned: small (a day or less): 00, 02, 03, 04, 05, 07, 16a, 17, 20; medium: 01, 06, 08, 10, 11, 13, 14; large: 09, 12, 15, 16b and each
proof row (three threads of 1 to 3 hours each, plus the clean-up between them). 12 and 15 are the two places to split if a row grows past one review.

---

## 8. Risks

- **Disk.** 74% today with the guard at 70%, so P26-00 comes first. An agent pod (about 800 MB of new image layers, plus 2 GB of Playwright base in Docker during
  the build; a work volume with two pnpm installs, 3 to 5 GB in use whatever the claim says, since local-path does not enforce a size), a test install (about 4Gi of
  volumes) and a kaniko build (up to 10Gi while it runs) can push a proof over the line. Mitigation: share the Playwright base layers, one agent pod at a time,
  delete each proof's work claim after it, clean the registry between proofs. The real fix is a bigger disk (§9, question 6).
- **Memory.** The live site, k3s, Postgres, the managed Hermes pods, one agent pod (4Gi), the test install (8Gi limit in its quota) and a kaniko build (4Gi, inside that quota)
  do not all fit in 15 GB at their limits. Mitigation: one proof at a time, the agent pod at 4Gi, watch `free -h`, stop the run below 2 GB available.
- **Full access in a shared pod.** All bots of a pod share a uid; a full-access Codex can change another bot's clone and the repository of record, and read the
  bridge key and the deployer's kubeconfig. Kept to one team per runner; the kubeconfig rules only the test namespace; the GitHub main branch is protected by GitHub
  itself and the publisher pushes only `card-*` branches.
- **Full access on a server.** Same user for every agent: the bridge key, the sign-in folders and the kubeconfig are readable by a full-access Codex, so a server with
  full access serves one team in all its runners (§4, §5.5).
- **Sign-in in a pod has never been completed.** Only the first half of each flow was measured; P26-01 completes both before any controller work depends on them.
- **Codex's full-access mode name** is the adapter's and may change with a version; it is measured (P26-01) and the version stays pinned.
- **Hermes over ACP in a pod** cannot be held to less per run; per-bot Hermes profiles are the only way to give bots different toolsets. If the spike shows `-p` is not
  honoured by `hermes acp`, a Hermes pod runner serves only bots whose grants match the one profile, and the run is refused in plain words otherwise (as today).
- **The tunnel is new code on the site's request path** and lives in one replica. It is tested in process; two replicas would need the hand-off the `runners` plugin
  also lacks. A deploy of the live site restarts that replica: every server reconnects within 30 s and runs resume their event streams (§5.3), so a deploy during a
  server proof is still forbidden (§6.2) but no longer fatal.
- **Subscriptions.** Two homes for one Claude account (pod and server) are two separate sign-ins, not a copied file, so they do not sign each other out; whether the plan's
  terms allow team use is the owner's to judge (agent-bridge.md, "Subscription terms"). Plan limits pause the runner (`plan_limit`) and the page says until when.
- **Budget.** Hermes through the run proxy now counts against the workspace cap ($10, 8.66 USD spent): the Hermes proofs may stop on it. Claude and Codex count against
  their plans only; `bot_runner_usage` records runs and seconds per day.
- **The chain itself.** P25-16 needed about 30 answered approvals and many nudges; P26-02, 03, 04, 06 and 07 are aimed at that, and §6.2 stops a proof that needs more than
  three nudges until the cause is fixed.
- **A remote server and the test deploy.** A machine outside the devbox cannot reach the cluster's API, so its Deployer could not deploy; out of scope unless the owner
  provides such a machine and opens the API to it.

---

## 9. Decisions for the owner

1. **Accept the pods' permission list** (claude-pods.md "Every permission the runners add", updated by P26-11), so Claude and Codex pods may run on the live site. Without it
   proofs 1 to 3 cannot run live. Recommended: accept.
2. **"Codex can push to GitHub":** (a, recommended) through the publisher, so no bot ever holds a push token and a pull request is the only way into GitHub; or (b) a
   fine-grained token for the one repository, limited to `card-*` branches by a GitHub rule, mounted in the Codex pod so `git push` itself works. (b) is closer to
   the words "Codex pushes" but puts a token in a pod where a full-access agent can read it.
3. **Full access defaults:** on in a Codex pod that serves one team, off on a server unless both the installer flag and the admin switch say yes, never for Claude Code.
   Recommended as written.
4. **Hermes in a pod:** (a, recommended) the managed Hermes pod the team already has (the Hermes gateway, not ACP; nothing to build, it already ran the chain, and it
   is "Hermes in a pod" in the owner's words), or (b) a new `hermes_acp_pod` runner (ACP, the same image and run card as Claude and Codex; rows P26-09h and part of
   P26-01, plus a Hermes layer in the image and the read-only-root launcher question).
5. **Live deploy** of each proof's merged pull request to manythreads.kahf.to: only on the owner's word (each one costs a deploy and disk), or after all six in one deploy
   (recommended).
6. **A bigger disk** for the devbox (for example +50 GB), or a second machine for the server proofs. Recommended: the disk; the server proofs can use the devbox itself.
7. **Budget for the Hermes server proof:** raise the workspace cap for the duration (to $25), since Hermes spend through the run proxy is counted there (the managed
   Hermes pod's spend stays outside the cap, as P25-16 found).
8. **Four sign-ins by the owner** on the Runners page (Claude and Codex in their pods, Claude and Codex on the enrolled devbox; Hermes needs none), plus one of each
   in the P26-01 spike. Use the same accounts as P25-16 or accounts made for the bots (recommended: accounts made for the bots, so a plan limit stops no person's own
   work). If the Codex account offers a "device code sign-in" switch in ChatGPT's security settings, the owner turns it on first.
9. **The six small fixes** the Engineer delivers: the owner names them, or the operator picks six small open items (one UI text, one test, one doc link per agent) and lists
   them in the thread before each proof. Each must be testable without a database (§3.4).
10. **Memory during a proof:** may the operator scale the Hermes pods of teams that are idle (not Engineering) to zero for the hours of a proof, and back after?
   Recommended: yes, only if `free -h` falls under 4 GB.

## 9a. The owner's answers (2026-11-15)

- q1 pods' permission list: **accepted**, turn the Claude and Codex pods on live.
- q6 disk: **no bigger disk**; squeeze: clean between proofs, one proof at a time (P26-00 before each deploy).
- q7 budget: **raise the workspace LLM cap to $25**.
- q8 sign-ins: **the owner's own Claude and ChatGPT accounts**. To keep the owner's steps to four, the P26-01 spike measures inside the signed-in agent pods (after P26-10), not in a separate container with its own sign-ins.
- The rest follow the recommendations: q2 (a) the publisher; q3 as written; q4 (a) the managed Hermes pod; q5 one live deploy after all six; q9 the operator picks six small fixes; q10 yes, under 4 GB free only.

## 9b. Shared runners: many teams on one server and one runner (owner, 2026-11-15)

The owner's rule: **several teams reuse the same server and the same runner**, for example Engineering and Marketing both run on one Claude Code sign-in (one
subscription). This replaces every "one team per runner / per server" rule above (§4 decision on full access, §5.5, §8 risks, q3): a runner's team list may hold
any number of teams, with full access on or off. Teams are kept apart by the machine, not by forbidding the sharing:

- **The runner is the sign-in.** One runner = one agent (Claude Code, Codex or Hermes) with one sign-in, shared by every team placed on it. That sharing is the
  point and is accepted: every team's runs use the same subscription and its limits (the Runners page says so next to the team list).
- **Pods: one pod per (runner, team).** The controller makes `claude-<runner>-<team>` (and `codex-…`) for each team of the runner. Every team pod mounts the
  runner's one `state` volume (the sign-in; all of them on the runner's node, so the local volume can be shared) and its own `work` volume, its own bridge key, its own
  profiles (only that team's bots), its own deploy login (that team's deployer) and its own NetworkPolicy. A bot of one team never shares a pod, a uid's files or a
  token with another team's bot. Full access applies per team pod. Sign-in happens once per runner (through any of its pods: they share the state volume); the
  Runners page shows the runner ready when the sign-in is good. Token renewal by two pods at once is what one pod with two sessions already does (the CLIs lock
  their own file; Codex's `auth.lock` is on the shared volume).
- **Servers: one Unix user per team.** The bridge runs each team's runs as `mt-team-<team slug>` (created on the first run of that team by a small root helper the
  installer adds, with a sudoers rule that allows exactly: create `mt-team-*` users, and start the fixed run launcher as one of them). Each team user has its own
  home (0700) with that team's work folders, repository of record, per-run kubeconfig and Hermes homes; run tokens live only in that user's processes. The agents'
  sign-in folders are group `mt-agents` (0770: the CLIs renew tokens in place), every team user is in that group; nothing else of the bridge (its key, its state,
  the publisher's socket folder) is readable by a team user. Full access on a server applies per team user: a team's Codex can read its own team's files and the shared
  sign-in, never another team's.
- **The one rule left:** the deploy login and a full-access agent are per team (pod or user), never shared.

Tasks: **P26-21** pods per (runner, team) sharing the sign-in volume (claude-pods reconcile/render, sign-in through any team pod, runner status from the shared
sign-in, migration only if a column is needed, tests incl. two teams on one runner); **P26-22** servers with one Unix user per team (bridge.sh helper and sudoers rule,
the bridge's launcher per team, group-shared sign-in folders, container test with two teams proving team A cannot read team B's files or tokens); **P26-23** the
Runners page and docs (team list on any runner, the shared-subscription note, conventions.md and claude-pods.md and agent-bridge.md updated, MISTAKES.md); proofs
P26-18/19 place Engineering and Marketing on the same runner and show a Marketing bot answering on it.

---

## Review changes (2026-11-15, independent review against the code)

- **Stop criterion fixed.** The publisher squashes a card into one commit authored as the requester (`publisher.mjs`, claude-pods.md), so "Codex's own commit
  reaches GitHub" could never be met. Now: the pull request was opened by a Codex Committer run and its commit's tree equals the commit Codex made and Tester tested.
- **Disk blocks the first deploy.** At 74% the deploy guard (70%) refuses every deploy the build order asked for. Added P26-00 (get under 65% or a bigger disk) first.
- **Image base claim was wrong.** Docker holds no workbench image (deploy.sh drops Docker's copy after the k3s import), so `FROM` the workbench would rebuild it with
  new layer digests and share nothing. The image now starts from the workbench's pinned Playwright base digest, which k3s already holds byte for byte.
- **Hermes in a pod simplified.** The managed Hermes pod already ran the chain; it is now the recommended proof 3 (and is run first as a baseline). `hermes_acp_pod`
  became optional (P26-09h), which also takes the read-only-root launcher rewrite (MISTAKES P25-16) off the critical path.
- **Postgres sidecar dropped.** The six fixes are chosen to need no database; this saves a container, memory and a chart value.
- **Deployer kubeconfig.** hermes-pods already writes `deployer.kubeconfig` and `deployer.host.kubeconfig` per team; the new provider is now a thin pointer to it. The
  plan said the Secret is mounted "only into the deployer's profile": a mount is per container, so every bot of the pod can read it; that is now stated and accepted
  (test namespace only, one team). 6443 is opened per pod by a label and a second policy, not by the shared one.
- **Deployer budget.** The kaniko build waits up to 40 minutes; the Deployer's run budget (45 min) and "poll in the same turn" are now in the shared text.
- **Sign-in in a pod was never completed** (acp-measured.md stopped before a real account). P26-01 now completes both with the owner; the Codex device-code switch in
  ChatGPT is named as an owner step. Sign-in count corrected from six to four (plus the spike).
- **Installer.** `--enrol -` read the code from standard input, which under `curl | bash` is the script itself: now `/dev/tty`. Script wrapped in one `main` (a cut
  download runs nothing). The page's hash comes from the same site, so it is stated as a transfer check only. The host's `claude`/`codex` usually live under
  `/root` or a home, unreadable to the service user and hidden by `ProtectHome`: the bridge now runs pinned copies installed with `npm ci --ignore-scripts` from a lock
  file in the bundle (integrity-checked, and the server image does not grow by the agents' size). Chromium's system libraries (apt) and Hermes's pinned tag added.
- **Tunnel.** Carries only site-to-bridge requests; the publisher fetches the push token over its own HTTPS call, so the token never passes through the agents'
  user. Added: 64 KiB response frames (the 1 MiB was a request limit), cancel frames on abort, per-stream buffer cap, key re-checked every heartbeat, a new socket
  replacing the old, Cloudflare's 100 s idle cut, bodies never logged, slug checks, and a 60 s reconnect grace that resumes the event stream with `Last-Event-ID`
  instead of failing every run on a blip. The code goes into `bot-runners`, not a new plugin; shared socket code moves to the SDK, never copied.
- **Full-access scope on a server.** systemd's credential folder, the agents' sign-in folders and the kubeconfig are readable by the one service user, so a
  full-access Codex could take the bridge key and receive other teams' runs: the one-team rule now covers the whole server. P26-01 also measures a middle way
  (`workspace-write` with network) as the server default. The local ports of the devbox are listed before proof 4.
- **Ordering.** P26-18 needed P26-16, which needed the server rows, contradicting the "pods first" order: P26-16 is split into 16a (pods) and 16b (servers). Sizes added.
- **Memory.** 7.7 GB is available today; agent pod 4Gi plus the test quota 8Gi only fits because the chain is sequential. `free -h` is checked at each hand-off;
  §9 question 10 asks whether idle teams' Hermes pods may be scaled down during a proof. A person pressing an approval button on the deployed site is now a step of
  each proof (CLAUDE.md).
