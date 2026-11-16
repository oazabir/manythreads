# Phase 27 · The onboarding journey: from an empty machine to a team that delivers

The owner's request (2026-11-15), in short: once Phase 26 is finished, anyone should be able to paste one `curl` command on a Linux machine and get a running
manythreads on k3s, with the admin's sign-in printed at the end. The admin then opens the address, signs in, and a first-run wizard takes them through: the
organization, the predefined teams, the model keys in LiteLLM, this machine added as a server, runners both on that server and as new pods, a check that Brain
answers, and a check that the Engineer bot can run a whole small delivery.

**Stop criteria:** built and tested; the automated journey test (§6.2) passes from an empty container to a finished wizard with stand-ins; one live run on a
fresh machine (§6.3) shows, with screenshots and timings: the install's printout, the admin's first sign-in, every wizard step done from real facts, a cited
Brain answer, and an Engineer-led delivery that ends with a pull request on GitHub and the change running at its test address; the owner has the links.

Status: draft (2026-11-15). Not reviewed yet. Goes into PLAN.md (§7 row "27", §8 ledger) after the owner answers §10. Starts when Phase 26 is done (its rows
P26-18 to P26-23 included), because the wizard's servers and runners steps are Phase 26's screens.

Words used on this page:
- **k3s**: a small Kubernetes (the system that runs containers across one or more machines). One machine is enough.
- **Helm chart**: the bundle of Kubernetes files that installs manythreads (`deploy/helm/manythreads`); **values** are the choices fed into it.
- **Image**: a packaged program a container runs. A **registry** is a server that hands images out. A **digest** is the fingerprint of one exact image, so a
  pinned image can never change under you.
- **GHCR**: GitHub's registry (`ghcr.io`).
- **LiteLLM**: the model gateway that sits between the bots and the model providers (Anthropic, OpenAI, …). The site writes its settings; see `docs/plugins/gateway-llm.md`.
- **Alias**: a role name a bot asks for instead of a model name: `smart` (careful answers), `fast` (quick jobs), `code`, and a few more. The admin binds each to a real model.
- **Runner**: a place where bots run, set up by an admin (`docs/plugins/bot-runners.md`): a managed Hermes pod per team, a Claude Code or Codex pod, an agent on an
  enrolled server, or the LLM gateway runner (a model with the bot's tools and no shell).
- **Enrolled server**: a machine where `bridge.sh` installed the agent bridge, which keeps a connection open to the site (Phase 26, `docs/guide/add-a-server.md`).
- **Fact / mark**: the onboarding rule already in the code: a step is done only from a fact read from its owner (a team exists, a test call answered);
  a mark is a decision a person made ("we do not need this"), stored by the `onboarding` plugin.
- **Stand-in**: a small fake of an outside service used by tests (the fake LLM, the fake ACP agent, the fake Claude pod).
- **ACME / Let's Encrypt**: the free service that gives a site a trusted HTTPS certificate after it proves it owns the name.
- **sslip.io**: a public DNS service where a name like `203-0-113-10.sslip.io` points at the address `203.0.113.10`, so a machine with no domain still has a name.

---

## 1. Where things stand (checked in the code, 2026-11-15)

| Piece | Today | What the journey still lacks |
|---|---|---|
| Install path | `docs/deploy/k3s.md` (command by command; its blocks are run by `tools/deploy-test/k3s-fresh.sh` in a `rancher/k3s` container, about 10 minutes, 3 GB disk) and `docs/deploy/self-host.md` (ten steps, never run end to end on a clean machine) | no install script; the admin clones the repository and **builds three images with Docker on the machine** (there is no registry the public can pull from); TLS, LiteLLM, Hindsight and the pods are separate manual steps |
| Images | built on the devbox by `tools/devbox/deploy.sh` and imported into k3s; `postgres.image` defaults to the devbox's private `registry.local:5000`; LiteLLM is `ghcr.io/berriai/litellm:main-stable` (a moving tag); the CNPG operator chart is not pinned | nothing pinned and pullable for a stranger |
| First admin | the server logs a one-time `/bootstrap/<token>` link while no workspace exists; `admin init` (compose only, `packages/server/src/cli/init.ts`) makes the admin, prints a made-up password once, and also makes a first team and a Hermes runner; `admin set-password` resets a password from standard input | no k3s path that prints the admin's email and password; no way to see the first password again; `init` always makes a team, which the wizard should pick instead |
| Wizard | `/onboarding` (`clients/web/src/screens/onboarding`, plugin `packages/plugins/onboarding`): nine steps ticked from facts, a sidebar card, a first question to Brain. Steps 3, 4, 7 only link to other pages | no organization step; models step has no provider presets; no servers, runners or placement steps (the Runners page does that work, outside the wizard); no first delivery. (`/t/:team/setup`, `clients/web/src/screens/setup`, is the **Add a bot** helper, not this wizard: the names must not be mixed up) |
| Models | gateway-llm: providers `openai anthropic azure bedrock google ollama openai_compatible`, closed alias set `smart fast code local embed vision image transcribe`, a Test button per alias, budgets | no "pick a provider, paste a key, we bind the aliases for you" path |
| Teams | five templates (`templates/engineering`, `marketing`, `customer-support`, `product-design`, `research`), `POST /api/teams/from-template`, the wizard can create one team | one at a time; nothing is "predefined" |
| Servers and runners | Phase 26: Runners page with Add a server (`curl …/install/bridge.sh \| sudo bash -s -- --enrol …`), waiting, agents found, Sign-in in a dialog (`ServersSection.tsx`, `AgentSignInDialog.tsx`), agent pods per runner, shared runners per §9b of `agents-anywhere.md` (being built) | none of it is in the wizard; `bridge.sh` has no way to trust a self-signed site (it refuses `ws://` and has no certificate pin) |
| Brain | one workspace Brain (`templates/_workspace/bots/brain`), runs on the workspace default runner. On the live site that is the host Hermes gateway; `docs/plugins/bots.md` says per-team Hermes pod profiles for the workspace Brain are **not built** | on a fresh k3s install Brain has no runner it can use until an admin makes one; the LLM gateway runner (`model-runtime.ts`) is the likely home but is not proven for Brain |
| Engineer chain | `templates/engineering` (engineer, plan-reviewer, coder, code-reviewer, tester, committer, deployer, web-smoke-tester), proven live on the devbox (P14-10, P25-16) | the Deployer's text names the devbox's own `test-manythreads` namespace and `test.manythreads.kahf.to`; a customer has neither. The chart's `hermesPods.repoOriginAllow` is empty by default (no GitHub repository can be copied); `appTeams` lists only three team slugs |
| Tests | `e2e/onboarding/onboarding-wizard.spec.ts` (nine steps on a stack with the fake LLM), `k3s-fresh.sh`, the `bridge.sh` container test, `e2e/runners/servers.spec.ts` (bridge over the tunnel with the fake ACP agent), the pod sign-in spec against the Kubernetes stand-in | no test that starts from `curl … \| bash` |
| Devbox | 96 GB disk at 71% (the deploy guard stops above 70%), 15 GB memory with 8.3 GB available, `/dev/kvm` present (nested virtual machines are possible), k3s and the live site already on it | it cannot be the "fresh machine": the installer would meet the live k3s |

---

## 2. Decisions this plan takes (the owner may overrule any; open ones are in §10)

1. **Images come from a registry, not from a build on the customer's machine.** Each release, the devbox (which already builds everything) pushes the images
   to GHCR by digest and writes a small release file, `release.json`: the version, every image with its digest, the chart version and the SHA-256 of
   `install.sh`. The installer pulls only what that file names. Building from source stays as `--build-from-source` (today's k3s.md path) for air-gapped
   sites and for us. Why: a build needs Docker, git, 20 to 40 minutes, about 25 GB of disk and internet access to Hugging Face for the speech models; a pull
   needs none of that and is the same bytes we tested. (§10 q1, q2.)
2. **One script, one `main`.** `install.sh` is written like `bridge.sh`: the whole script is one function called on its last line, so a cut download runs nothing;
   it reads any question from `/dev/tty` (under `curl | bash` standard input is the script itself); it never puts a secret on a command line.
3. **The installer makes the admin; the wizard makes everything else.** The script creates the workspace (named "My organization" until the wizard renames it)
   and the first admin with a made-up password, prints both once, and stops. No team, no runner and no model are made by the script, so the wizard is the
   only place those choices are made, and re-running the script never makes a second team.
4. **The first password can be shown again until it is changed.** It is kept in a Kubernetes Secret in the release namespace, readable only with the
   machine's root kubeconfig. `sudo manythreads admin-password` prints it while it still works and says "already changed; use reset-admin-password" once the
   admin chose their own. The first sign-in asks the admin to choose a new password (the `must_change` column already exists; P27-03 checks the sign-in
   honours it). (§10 q9.)
5. **HTTPS by default, even with no domain.** Order of choice: `--domain` given → Let's Encrypt for it (or Cloudflare with `--tls cloudflare`, as `deploy.sh`
   does today); no domain and a public address → the sslip.io name of that address with Let's Encrypt; no public address or port 80 closed → a self-signed
   certificate on the address, with its fingerprint printed so `bridge.sh` and browsers can be told to trust it. Plain HTTP only with `--tls none` (a trial).
   (§10 q3.)
6. **The wizard stays at `/onboarding`** and grows from nine steps to twelve (§5). Every step is still ticked by a fact, never by a click, and the old
   rules of `docs/plugins/onboarding.md` keep holding.
7. **Brain runs on the LLM gateway runner on a fresh install.** The wizard makes one runner of kind `llm_gateway` named `models`, makes it the workspace
   default, and Brain answers through it: Brain needs memory, search and its native tools, not a shell. A spike (P27-00) proves it; if it fails, the wizard
   places Brain on the Engineering team's managed Hermes pod and P27 builds the missing workspace-bot profile. (§10 q6.)
8. **The first delivery is real, but small and on the customer's own GitHub.** The Engineer is given a prewritten goal against a starter repository the admin
   makes from a public template (§5.11); the Deployer puts the change in the team's apps namespace (`/apps/engineering/<app>/` on the site's own address, which
   needs no wildcard certificate); the Web smoke tester checks it in a browser; the publisher opens the pull request. No bot holds the push token, as today.
   (§10 q8.)
9. **The install journey test runs in containers on the devbox**, never in a second namespace of the live cluster (§6.2 says why), and the live run uses a
   throwaway machine the owner provides (§6.3).

---

## 3. The install (`install.sh`)

### 3.1 The command

```
curl -fsSL https://<install host>/install.sh | sudo bash
curl -fsSL https://<install host>/install.sh | sudo bash -s -- --domain team.example.com --admin-email me@example.com
```

`<install host>` is a placeholder until the owner answers §10 q2. The same script is served by every site at `/install.sh` (like `/install/bridge.sh`) and is
attached to each GitHub release with its SHA-256; the careful way (download, read, compare the hash in the release notes, run) is shown beside the one-liner.
The script pins itself to one release: `--version v0.27.0`, default the newest release named in `release.json`.

### 3.2 What it does, in order

1. **Checks** (each failure is one plain line and an exit before anything changes):
   - Linux on x86-64 (arm64 later, §10 q12), Ubuntu 22.04/24.04 or Debian 12, systemd, run as root, `curl`, `tar`, `sha256sum`.
   - Memory: under 8 GB stops ("manythreads needs at least 8 GB of memory; this machine has 4"). 8 to 16 GB warns that agent pods are left off and
     only one team pod runs at a time. 16 GB or more: everything on.
   - Disk: under 40 GB free stops; under 80 GB free warns (the images are about 10 GB with the agent pod and the workbench, a team pod's work volume grows).
   - CPU: under 4 warns.
   - Ports 80, 443 and 6443 are free (or held by this machine's own k3s), the clock is in sync, the machine reaches `ghcr.io` and `get.k3s.io` on 443.
   - An existing k3s or `--kubeconfig <file>`: the script uses that cluster, checks it has Traefik (or `--ingress-class`), and asks once (from `/dev/tty`,
     or `--yes`) before adding the cluster-wide pieces (the CNPG database operator, cert-manager).
2. **k3s**, when absent: the pinned version through `get.k3s.io` with `INSTALL_K3S_VERSION`, the Traefik service set to keep visitors' addresses
   (`externalTrafficPolicy: Local`, needed by the sign-in lockout; see `docs/deploy/rate-limits.md`). The script records that it installed k3s, so only then
   does `--uninstall --remove-k3s` remove it.
3. **Helm** (pinned binary, checked by SHA-256), the **CNPG operator** (pinned chart version) and, for Let's Encrypt, **cert-manager** (v1.21.3, as today).
4. **Values** in `/etc/manythreads/values.yaml` (root, 0600), from the profile `values-install.yaml` (P27-02) plus the answers: domain or address, TLS
   mode, the pinned image digests, `seed.demo: false`, `litellm`, `hindsight`, `hermesPods` and (with 16 GB or more) `claudePod` on, `appTeams` set to every
   template's slug, `repoOriginAllow: ["https://github.com/"]` (§10 q14). Every later upgrade reuses this file.
5. **Install** the chart from its OCI address at the pinned version, without `--wait` (the backups claim stays Pending until the first nightly job:
   MISTAKES "Install-fresh"); the script waits for the database, server and web rollouts itself and then for `/readyz`.
6. **The admin**: `admin first-admin --email <address> --workspace "My organization"` inside the server pod (P27-03). The email is `--admin-email`, or asked
   from `/dev/tty` with `admin@<host>` as the default. The password is made up (24 characters), stored in the Secret `manythreads-first-admin`, marked "must
   change", and printed once.
7. **The printout**, in a box, and nothing secret anywhere else (not in the log file):
   ```
   manythreads 0.27.0 is running.
     Open:      https://203-0-113-10.sslip.io
     Sign in:   me@example.com
     Password:  <24 characters>   (shown once; `sudo manythreads admin-password` shows it again until you change it)
     Next:      sign in and follow "Finish setting up".
     Keep safe: `sudo manythreads backup-key` prints the key that unlocks stored secrets; save it in your password manager.
   ```
   With a self-signed certificate it adds the certificate's SHA-256 and one line on what the browser warning means.
8. **The host command** `/usr/local/bin/manythreads` (P27-05) and the state file `/etc/manythreads/install.env` (version, TLS mode, whether k3s was ours).

### 3.3 Running it again, upgrading, removing it

- **Again with nothing new**: it finds the state file and the release, says "already installed (0.27.0)", prints the address (not the password) and runs
  `manythreads doctor`. It never makes a second admin or a new encryption key.
- **`--upgrade [--version vX]`** (also `manythreads upgrade`): reads the new `release.json`, refuses a lower version (migrations only go forward; `docs/deploy/self-host.md`
  "Upgrades"), takes a backup first when backups are on (`kubectl create job --from=cronjob/manythreads-backup`), runs `helm upgrade` with the same values
  file and the new digests, waits for `/readyz`, and prints what changed.
- **`--uninstall`**: asks for the typed word `delete` (or `--yes`), offers to print the encryption key first, removes the release, the namespaces
  `manythreads`, `manythreads-bots` and `apps-*` (volumes go with them: said in the question), keeps the CNPG operator and cert-manager unless
  `--remove-addons`, and removes k3s only with `--remove-k3s` and only if the script installed it.
- **When it fails**: every step writes to `/var/log/manythreads-install.log` (no secret in it); the failing step prints one line on what failed, what to try
  and the log path; `manythreads doctor` checks pods, disk, memory, the certificate, DNS and `/readyz` and says the first thing that is wrong in plain words.
  A re-run continues from the step that failed (each step checks whether its result is already there). `manythreads support-bundle` gathers logs and pod
  states into one file with secrets removed.

### 3.4 The host command `manythreads`

`status`, `url`, `admin-password`, `reset-admin-password [<email>]` (makes up a new one and prints it once, through `admin set-password`), `backup-key`,
`doctor`, `logs [server|web|litellm|…]`, `upgrade`, `uninstall`, `support-bundle`, `version`. It is a thin shell script over `kubectl` and `helm` with the
root kubeconfig, so it works only as root on the machine.

### 3.5 Where the images come from

| Image | Today | After P27-01 |
|---|---|---|
| server, web | built per deploy, imported into k3s | `ghcr.io/<owner>/manythreads-server@sha256:…`, `…-web@…`, pushed by the devbox at release |
| postgres-cnpg | built, pushed to the devbox's private registry | `…-postgres-cnpg@…` |
| hermes-pod, workbench, agent-pod (claude-pod), asr | built by `deploy.sh` when their block is on | pushed the same way; the agent pod (5.2 GB) is pulled only when `claudePod` is on |
| LiteLLM, Hindsight, mailpit, LiveKit, registry | pulled by tag (`main-stable` moves) | pinned by digest in `values.yaml`; the images test of `docs/deploy/air-gapped.md` fails on an unpinned line |
| fake images (claude-pod-fake, demo-fakes, fake LLM) | built | never published; tests build them |

The devbox's release script pushes with a GHCR token the owner provides (§10 q1); the GitHub runner still only carries code (`docs/deploy.md`, "The rule").

### 3.6 TLS choices

| Situation | What the script does |
|---|---|
| `--domain` and port 80 reachable | Let's Encrypt for that name (HTTP challenge), staging first, then the real certificate |
| `--tls cloudflare --origin-cert … --origin-key …` | as `deploy.sh` does today (Full strict, Traefik trusts Cloudflare's ranges) |
| no domain, a public address, port 80 reachable | the sslip.io name of the address, then Let's Encrypt as above |
| no public address, or port 80 closed | a self-signed certificate for the address and any `--domain`, kept in a Secret, made Traefik's default; fingerprint printed; the Add a server command then carries `--ca-sha256 <fingerprint>` (P27-06) |
| `--tls none` | plain HTTP with `publicUrl: http://…` (cookies then work; trial only, said in the printout) |

---

## 4. Who does what, start to finish

| # | Who | Where | What happens | Done when (the fact) |
|---|---|---|---|---|
| 1 | admin | the machine's shell | pastes the command | the box of §3.2 step 7 is printed |
| 2 | admin | browser | opens the address, signs in with the printed email and password, chooses a new password | a session exists; the first password no longer works |
| 3 | admin | wizard (§5) | twelve steps, any order, skip and come back | §5 table |
| 4 | admin | the machine's shell, from the wizard's Servers step | pastes the `bridge.sh` command shown in the wizard | the server shows Connected in the wizard |
| 5 | admin | wizard, Sign-in | types the Claude code and the Codex device code | the runners show Ready |
| 6 | admin | wizard, Verify | asks Brain a question | a cited answer in the thread |
| 7 | admin | wizard, First delivery | presses Start; answers approval cards when asked | the card is Done with a pull request link and a passing browser check |

---

## 5. The first-run wizard

### 5.1 Shape

- One page, `/onboarding`, with a step list on the left (a list at the top at 390 px) and one open step. It opens at the first step that is not done; a step
  link (`/onboarding?step=runners`) opens that step; reloading or coming back next week lands in the same place, because the state is the facts plus the marks.
- **Skip for now** on every optional step (a mark); **Come back** from the list; a skipped step stays in the sidebar card.
- Each step says, in one or two sentences a non-engineer can follow, what it is for and what happens if it is skipped, then shows the controls. Every term of
  art gets its plain words on screen ("A runner is where a bot does its work: …"). No internal key, path or setting name on screen (look rule P21-20).
- Built with `PageHeader`, the tokens, ProIcons, one filled button per view, dark-mode contrast, and no sideways scroll at 390 px (the long `curl` command
  wraps in a mono block with a Copy button).
- The `onboarding` plugin's step CHECK grows (migration `onboarding/0002`, `OnboardingMarkStep` in shared, `ENUM_COLUMNS` in the kernel's enum test, in
  one diff), and the sidebar card counts the same steps.

### 5.2 The steps

| # | Step | Required | What the admin does | Done when (fact) | Built from |
|---|---|---|---|---|---|
| 0 | Your sign-in | yes | chooses a new password (if not already) | the password is not the first one | identity-password |
| 1 | Organization | yes | name, short name for addresses (slug), time zone | the workspace name is no longer "My organization" | workspace settings route |
| 2 | Models | yes | picks a provider, pastes a key; the wizard binds `smart`, `fast`, `code` to the recommended models; Test; a monthly spend cap | `smart` and `fast` answered a test after their last change | gateway-llm routes, `AliasTestButton` |
| 3 | Sign-in methods | no | single sign-on, or "passwords only" | today's step 1 rule | unchanged |
| 4 | Teams | yes, at least one | ticks templates (predefined ones pre-ticked, §10 q4), may rename | each ticked team exists | `POST /api/teams/from-template` |
| 5 | Servers | no | "Add this machine": the wizard shows the `bridge.sh` command for a server named after the host, waits, lists the agents found | the server is Connected | `ServersSection` parts (P26-13) |
| 6 | Runners | yes | chooses where bots run (§5.3); signs Claude Code and Codex in from the step; picks which teams each runner serves | the `models` runner exists and is the default; every runner the admin made is Ready | bot-runners routes, `AgentSignInDialog` |
| 7 | Place bots | yes | sees each team's bots with a recommended runner, changes any, presses Apply | every bot of the teams passes the run-start placement check | `checkPlacement`, proposals "Propose and apply" |
| 8 | Code | no (yes for First delivery) | for Engineering: makes the starter repository on GitHub from the template (a link), pastes its address, the bot account's name and token | the project exists and its token check passed | projects routes (P23) |
| 9 | Verify Brain | yes | asks Brain one of three questions (or their own) | a Brain run in that thread ended with an answer | `GET /api/threads/:rootId/runs` (P25-06), the run card |
| 10 | First delivery | no | presses Start on the prewritten goal; answers approval cards | the goal's card is Done, with a pull request link and the Web smoke tester's pass | tasks, run card, to-do card |
| 11 | Done | — | invites people (copy link when mail is off), puts the checklist away | today's dismiss rule | onboarding |

Today's steps "Domain and HTTPS" (the install now does it; the wizard shows the address and certificate state as a line in step 1) and "Bots" (now step 7)
are folded in. The old "Your first goal" becomes step 9.

### 5.3 Runners step, in plain words

Shown as cards, each with what it costs and what it needs:

| Card | Kind made | Needs | Recommended for |
|---|---|---|---|
| **Answers only** (made for you) | `llm_gateway`, name `models`, all teams, workspace default | a working model (step 2) | Brain and bots that only read and write messages |
| **A managed Hermes pod for each team** | `hermes_pod`, one per team | model keys (step 2); about 2 GB of memory per team | every team's bots, with no subscription |
| **Claude Code in a pod** / **Codex in a pod** | `claude_cli` / `codex_cli`; one pod per team on it (§9b) | a Claude or ChatGPT subscription; the admin types a code once | the Engineering chain |
| **Claude Code / Codex / Hermes on this machine** | `server_agent`, from step 5 | a connected server; for Claude and Codex a sign-in | teams that want the agent on their own machine |

The team list on each card accepts any number of teams, with the shared-subscription note of `agents-anywhere.md` §9b ("every team on this runner uses
the same subscription and its limits"). Full access for Codex follows `conventions.md` (on in a pod, two keys on a server, never on the devbox host). With
under 16 GB of memory the pod cards say why they are off.

### 5.4 Place bots step

A table per team: bot, what it does (from the template), the runner the wizard recommends, a picker. The default rule (§10 q7): Brain and the "messages only"
bots on `models`; the Engineering chain on a Codex or Claude pod when one is Ready, else on the team's Hermes pod; other teams' bots on their Hermes pod.
Apply sets each team's default runner and, where a bot differs, writes its `placement.runs_on` through one proposal per team applied by the admin (the
only way `bots/` changes; conventions). Then the step re-reads the placement check of every bot; a bot whose runner is not Ready shows why.

### 5.5 Verify Brain and First delivery

- **Verify Brain** opens the admin's conversation with Brain in the first team, posts the question, and shows the run card live in the step. If no answer
  comes, it names the cause from the run's refusal (no runner, the model test failed, memory is off) and links to the step that fixes it.
- **First delivery** posts the goal to the Engineer in Engineering's `#dev` as the admin: "Add a page at /hello to the starter app that shows the team's
  name, test it, deploy it to the preview and open a pull request." The step shows the to-do card and the run cards as they change, the approval cards the
  chain raises with their Yes/No buttons (CLAUDE.md: anything that waits for a person must be answerable, and the step proves it), the time so far and the
  spend so far. When the chain stops for longer than its budget allows, the step says which bot holds the card and offers "Ask the Engineer what is stuck".
  Done when the card is Done, the pull request link is on it, and the Web smoke tester recorded a pass.

### 5.6 The starter repository

A public template repository the owner creates (§10 q8) with: a tiny web app (one page, one test), its `Dockerfile`, and `deploy/preview/README.md` that
tells the Deployer how to build it inside the cluster and run it in the team's apps namespace at `/apps/engineering/starter/`. The chain texts are changed to
read the deploy target and address from that README and from "Where you run", never from the devbox's names (P27-17).

---

## 6. Verification

### 6.1 Level 1: unit and component tests (every change)

- `install.sh`: `shellcheck`; a `--print-plan` mode that prints every step it would take and changes nothing; tests of the check functions with stubbed
  commands (memory, disk, ports, existing cluster, the TLS choice table of §3.6, the re-run detection).
- The admin CLI commands (P27-03), the wizard's pure step logic (`steps.ts` gains the new facts; `clients/web/test/onboarding.test.ts`), the chart profile
  `values-install.yaml` rendered and checked by `deploy/helm/test`.

### 6.2 Level 2: the automated journey (before each release, and on demand)

**Where it runs.** On the devbox, in containers, one copy at a time:

| Option | Verdict |
|---|---|
| A second namespace of the live cluster | **No.** The installer's own work is cluster-wide: it installs or finds k3s, sets Traefik, installs the CNPG operator and cert-manager. A test of it in the live cluster would change the live site's cluster, and it could not test "k3s absent" at all. |
| k3d (k3s in Docker, with a wrapper tool) | Not needed: `k3s-fresh.sh` already runs `rancher/k3s` in a privileged container without k3d. It tests "an existing cluster" well, but not the k3s install. |
| **A privileged Ubuntu 24.04 container with systemd** ("the fresh machine") | **Chosen**, if the spike (P27-00) shows `get.k3s.io` installs and runs k3s inside it (cgroup v2, `/dev/kmsg`, overlay storage). It runs the real `curl … \| bash`, including the k3s install. |
| A nested virtual machine (`/dev/kvm` is there) | Fallback if the container cannot run k3s. Needs 6 GB held for the VM, so it runs only with more than 9 GB available and nothing else heavy running. |

**What it does** (`tools/deploy-test/install-fresh.sh`, new, shaped like `k3s-fresh.sh`):
1. Refuses to start when the disk is over 75% full, less than 6 GB of memory is available, a CI run or a stage is up, or another copy runs (`flock`).
2. Starts a throwaway registry container holding the candidate images (built by the CI step, never pushed to GHCR) and a small file server that serves
   `install.sh` and a test `release.json` pointing at that registry. The test profile uses the small stand-in images: the fake LLM as an `openai_compatible`
   provider, fake Hindsight, `claude-pod-fake`, the fake ACP agent; no workbench and no real agent pod (they are 2 and 5 GB).
3. Starts "the fresh machine" and runs `curl -fsSL http://<file server>/install.sh | bash -s -- --tls self-signed --admin-email omar@example.com --yes`.
4. Checks the printout (address, email, a password that signs in), `manythreads admin-password`, a re-run that changes nothing, `manythreads doctor`.
5. Runs the Playwright journey (P27-20's spec in its "remote" mode) from the devbox against the machine's address: sign-in with the printed password,
   new password, every wizard step with the stand-ins (the Servers step runs `bridge.sh` inside the same machine with `--ca-sha256`, which finds the fake
   ACP agent), Verify Brain against the fake LLM's script, First delivery with the fake ACP agent's per-bot scripts (P27-19) and a fake git host for the
   publisher, at 1440 px and 390 px.
6. `--upgrade` to a second test tag, `/readyz` again, then `--uninstall --remove-k3s`.
7. Removes every container, network, volume and image it made, whatever the outcome. Expected cost: about 25 minutes, 6 GB of disk at peak, 5 GB of memory.

It is a manual workflow (`install-fresh.yml`) and a step before each release, not part of every CI run (CI shares the dev database and takes long enough).

### 6.3 Level 3: one live run with the owner

On a **fresh machine the owner provides** (the devbox cannot be it: it already runs k3s and the live site). What the owner does, and when:

| When | The owner |
|---|---|
| before P27-01 can publish | gives the devbox a GHCR token that can write packages, and says whether the packages are public (§10 q1) |
| before P27-23 | provides a throwaway machine: Ubuntu 24.04, 8 vCPU, 16 GB, 100 GB, a public address, ports 80 and 443 open (§10 q11); optionally a DNS name for it |
| before P27-23 | provides one model provider key with a small spend limit (Anthropic or OpenAI), and makes the starter repository from the template plus a bot account token (§10 q8) |
| during the run (about 90 minutes) | types the Claude paste code and the Codex device code in the wizard; presses the approval buttons the chain raises; says Yes to the pull request being opened |
| after | says whether to keep the machine or delete it |

The operator drives everything else (the curl command, the wizard, screenshots through `tools/self-build/run.mjs` patterns), records timings per step
and the spend, and writes the result to STATUS.md and the report (P27-24).

---

## 7. Tasks

Same table shape as PLAN.md §8 and `agents-anywhere.md` §7. Every row: an independent review, its tests run inside its package (`npx vitest run`), `pnpm lint`
and `pnpm typecheck` green at the end, one heavy job at a time, `free -h` and `df -h /` checked before any build (the disk is at 71% and the deploy guard
stops at 70%: clean first).

| ID | Task | Where | Needs | Tests | Done when |
|---|---|---|---|---|---|
| P27-00 | Spike, measured on the devbox in containers: k3s installed by `get.k3s.io` inside a privileged systemd Ubuntu container (else the nested VM); the pull size and time of each image; memory and disk of the minimal and the full profile; Brain answering with memory through an `llm_gateway` runner; a sample app deployed by the Deployer to an apps namespace from a `deploy/preview/README.md` | `docs/spikes/install-measured.md` | Phase 26 done | - | the page with numbers; §2 decisions 7 and 9 confirmed or changed |
| P27-01 | Release images: the devbox's release step pushes every product image to GHCR by digest, writes `release.json`, packages the chart as an OCI artifact; LiteLLM, Hindsight and every outside image pinned by digest, the CNPG chart by version; the images test of `air-gapped.md` checks the pins | `tools/devbox/release-images.sh`, `release.yml`, `values.yaml`, `docs/deploy/air-gapped.md`, `tools/deploy-test/test/images.test.ts` | 00, owner q1 | images test; one push of a test tag to a test package | a stranger's machine pulls the release's images anonymously (or with the token of q1) |
| P27-02 | Chart profile `values-install.yaml`: no demo seed, no mailpit, no registry, images from `release.json`, LiteLLM and Hindsight on, pods on by memory, `appTeams` = every template slug, `repoOriginAllow` per q14, self-signed TLS mode in the `tls` block | `deploy/helm/manythreads` | 01 | `deploy/helm/test` render tests for each TLS mode and both memory sizes | renders clean; `helm template` lists the expected objects |
| P27-03 | Admin CLI: `admin first-admin --email --workspace` (no team, no runner; made-up password; must-change; the Secret written by the script, not the server), `admin password-status <email>` (is the first password still in use: reads the hash, never prints it), `admin reset-password <email> --generate`; check the sign-in asks for a new password when `must_change` is set, and build it if not | `packages/server/src/cli/`, identity-password, web sign-in | - | CLI tests (`packages/server/test`), identity test, e2e of the forced change | the commands work in the server pod; no password in any log or event |
| P27-04 | `install.sh`: §3.2 to §3.3 (checks, k3s, helm, add-ons, values, install, admin, printout, state file, re-run, `--upgrade`, `--uninstall`, `--print-plan`, the log), served at `/install.sh` by the server (like `/install/bridge.sh`) and attached to each release with its SHA-256 | `deploy/install/install.sh`, server route, `release.yml` | 01, 02, 03 | shellcheck, the function tests of §6.1 | `--print-plan` on the devbox prints the plan and touches nothing |
| P27-05 | The host command `manythreads` (§3.4), installed by the script | `deploy/install/manythreads` | 04 | shellcheck, stubbed-command tests | each subcommand works in the journey container |
| P27-06 | TLS for an installed site: the sslip.io name and Let's Encrypt (staging, then production), the self-signed mode in the chart, and `bridge.sh --ca-sha256` (the bridge and the script trust only that certificate); the Add a server command carries it when the site is self-signed | chart `tls.yaml`, `install.sh`, `tools/agent-bridge/install/bridge.sh`, bridge tunnel client, `ServersSection` | 02, 04 | bridge container test with a self-signed stub site; chart tests | a bridge enrols against a self-signed site and refuses a different certificate |
| P27-07 | Wizard shell: the stepper of §5.1, resume and step links, skip and come back, the sidebar card; migration `onboarding/0002` widening the step CHECK, shared types, `ENUM_COLUMNS` | `clients/web/src/screens/onboarding`, `packages/plugins/onboarding`, shared | - | `onboarding.test.ts`, plugin RLS and route tests, enum test | the old nine-step spec still passes on the new shell |
| P27-08 | Organization step: name, slug, time zone; the address and certificate line | onboarding screens; workspace settings route (add slug change if missing) | 07 | unit and route tests | a fresh install shows "My organization" as not done |
| P27-09 | Models step: provider presets with the recommended model per alias in one shared table (owner fills it, q5), paste a key, bind, Test, monthly cap; one line on why a Claude or ChatGPT subscription goes to step 6, not here | onboarding screens, `packages/shared` (presets), gateway-llm routes as they are | 07 | unit tests of the presets; wizard spec with the fake LLM (good key, bad key) | `smart` and `fast` pass their tests from the step |
| P27-10 | Teams step: template cards, predefined ones pre-ticked (q4), make all ticked teams in one go, idempotent when the page is opened again | onboarding screens | 07 | unit and spec | two templates ticked make two teams, a second press makes none |
| P27-11 | Servers step: "Add this machine" inline, the command (with `--ca-sha256` when needed), Waiting, Connected, the agents found; the parts of `ServersSection` moved to a shared component, not copied | `screens/admin/runners`, onboarding screens | 07, 06 | component tests; servers spec in wizard form | the step turns done when the bridge connects |
| P27-12 | Runners step: the cards of §5.3; `models` runner made and set default; pods per team; server agents; Sign-in inline; team lists; the memory note | onboarding screens, `AgentSignInDialog` reused | 07, 11, Phase 26 P26-21/23 | spec against the Kubernetes stand-in and the fake ACP agent | each runner the admin made shows Ready |
| P27-13 | Place bots step: the recommended placement (q7), Apply as team defaults plus one proposal per team, the placement check re-read | onboarding screens; bots/proposals routes as they are | 12 | unit tests of the rule; spec | every bot passes `checkPlacement` |
| P27-14 | Code step: the starter template link, the P23 project form inline, the token check | onboarding screens, projects routes | 07 | spec with the fake git host | the project exists with a checked token |
| P27-15 | Verify Brain step (§5.5) with the run card and the causes in plain words; Brain on the `models` runner (or the fallback of decision 7) | onboarding screens, bots/bot-runners if the spike needs it | 12, 13, 00 | spec with the fake LLM's scripted answer; failure cases | a cited answer appears in the step |
| P27-16 | First delivery step (§5.5): the goal, the live cards, the approval buttons, time and spend, the stuck case | onboarding screens, runtime-hermes and tasks routes as they are | 13, 14, 17, 19 | spec with the fake agents | the card is Done with a pull request link and a pass |
| P27-17 | Install-neutral chain texts: the Deployer and Web smoke tester read the target and address from the project's `deploy/preview/README.md` and "Where you run", never `test-manythreads` or the devbox's host; the live Engineering team's copies synced by repo commit (template fixes do not reach existing teams) | `templates/engineering/bots/*`, `where-you-run.ts`, the live team's `bots/` | 00 | templates text test; evals of the deployer set | the devbox chain still delivers (one P26-style run) and the starter repo's README is followed |
| P27-18 | The starter repository's content (§5.6) kept in this repository and published to the public template by the owner | `templates/_starter/` | 17 | its own test runs in CI; a dry run of its README in the journey test | the Deployer brings it up at `/apps/engineering/starter/` |
| P27-19 | Stand-ins for the whole journey: per-bot scripts for the fake ACP agent that make the chain's real MCP calls (tasks, messages, to-do, `mt-publish` to a fake git host), the fake LLM script for Brain, the fake Claude pod's sign-in | `tools/fake-acp-agent`, `tools/fake-llm`, `deploy/images/claude-pod-fake`, a small fake git host | 16's design | the stand-ins' own tests | the First delivery spec passes on the stack with no outside service |
| P27-20 | Playwright journey on the stack: every step, resume after reload, skip and come back, a member sees nothing, 1440 px and 390 px, light and dark screenshots; a "remote" mode that runs the same spec against an address | `e2e/onboarding/journey.spec.ts`, `e2e/fixtures` | 07 to 19 | the spec | green headless on the devbox |
| P27-21 | The install journey test of §6.2 and its workflow | `tools/deploy-test/install-fresh.sh`, `.github/workflows/install-fresh.yml` | 04 to 06, 20 | the test itself | one green run with its timings in STATUS.md |
| P27-22 | Docs: `docs/deploy/install.md` (the one-command page; `self-host.md` and `k3s.md` point to it and keep the manual path), `docs/guide/first-day.md` (the wizard for a non-engineer), the failure table, `docs/plugins/onboarding.md` updated, `MISTAKES.md` | docs | all above | - | a reader who never saw the repository can follow them |
| P27-23 | The live run of §6.3 on the owner's machine | the owner's machine, the live wizard | 21, 22, owner inputs | - | the stop criteria's screenshots, timings and links exist |
| P27-24 | The report to the owner: links, timings per step, spend, what failed and what was fixed; PLAN.md and STATUS.md updated | STATUS.md, PLAN.md | 23 | - | the owner has it |

Size: XL. Order in PLAN.md §7: 27, after Phase 26. P27-00 to 06 (the install) and P27-07 to 16 (the wizard) can go in parallel after the spike; 17 to 19 feed 16.

---

## 8. Risks

- **Disk and memory on the devbox.** 71% disk today (the guard stops deploys above 70%) and 8.3 GB of memory available. The journey test (6 GB of disk, 5 GB
  of memory at peak) runs only with nothing else heavy running, uses the small stand-in images, and cleans up whatever happens. Publishing images adds no disk
  on the devbox beyond what deploys already use, but the build cache must be pruned before each release build.
- **k3s inside a container may not work** (cgroups, `/dev/kmsg`, nested overlay). The spike decides; the nested VM is the fallback, and it needs memory the
  devbox rarely has free.
- **Image size on a customer's machine.** The full set is about 10 GB to pull (the agent pod alone 5.2 GB). Pulls are anonymous from GHCR only if the packages
  are public; GHCR's anonymous limits are generous but not stated. The script shows progress per image and resumes after a cut.
- **sslip.io and Let's Encrypt.** sslip.io names share one parent domain, so Let's Encrypt's per-domain rate limit could refuse a certificate on a busy week;
  port 80 may be blocked by the cloud provider. The script falls back to self-signed and says why.
- **A self-signed site** shows a browser warning on first open and needs the fingerprint for every enrolled server. Said on the printout and in the wizard.
- **The first password in the terminal's scrollback.** It must be changed at the first sign-in (decision 4), and the Secret is deleted by `reset-admin-password`.
- **An existing cluster** may have another ingress, another Postgres operator or Pod Security rules the chart does not expect. The script refuses what it
  cannot check and names it; this path is tested only with the plain `rancher/k3s` container.
- **Brain on the LLM gateway runner is unproven** (decision 7). Fallback named in P27-00.
- **The chain is slow and long on a small machine** (the Deployer's in-cluster build waits up to 40 minutes). The First delivery step shows progress and
  time so the admin does not think it is broken; the starter app is chosen to build in a few minutes.
- **Template copies go stale.** The wizard creates teams from the templates of the release, so new installs get the fixed texts; the devbox's own teams still
  need the copy by repo commit (P27-17).
- **Anything that waits for a person.** Every approval the chain raises must be answerable from the First delivery step and from Approvals; the spec presses
  each button, and the live run checks it on the deployed site (CLAUDE.md, the three failures in MISTAKES.md).
- **Postgres 19 is a beta build.** A customer who installs it cannot change the database image later without a dump and restore (`self-host.md`). The
  printout and the install page say so until the stable release.
- **Subscriptions shared by bots.** Claude and ChatGPT sign-ins used by bots for several teams follow the owner's Phase 19 decision on shared subscriptions;
  the Runners step states it next to the team list.

---

## 9. What is not in this phase

Mail setup in the wizard (invitations show a copy link when mail is off), single sign-on setup beyond today's step, backups to object storage, more than
one machine, arm64, an air-gapped run of the script (the `--build-from-source` path stays the air-gapped route), automatic updates.

---

## 10a. The owner's answers (2026-11-16)

- Images (q1): **public GHCR**, pushed by the devbox, pinned by digest, with `release.json` and `install.sh` as public release assets; the source repo may stay private.
- TLS (q3): **offer all three** in the installer and the wizard: an sslip.io name with Let's Encrypt, Let's Encrypt for the admin's own domain, and a custom domain mapped later (the wizard's HTTPS step changes it without a reinstall); self-signed only as the fallback when nothing else is reachable.
- Predefined teams (q4): **every template shown and ticked**; the admin unticks what they do not want.
- Live run (q11): **the owner provides a throwaway VM** (Ubuntu, 16 GB, 8 vCPU, 100 GB, public address, SSH for the operator). The automated journey still runs in containers on the devbox.
- The rest follow the recommendations; q13 (live-run sign-ins): the owner's own accounts, as in Phase 26.
- Order: Phase 27 starts after Phase 26 and after the theme system (P28, below), so the wizard lets the admin try the themes.

## 10. Decisions for the owner

1. **Image distribution.** (a, recommended) GHCR packages, built and pushed by the devbox at each release, public so anyone can pull; the owner gives the
   devbox a token that can write packages. (b) GHCR but private: each install needs a pull token the owner hands out. (c) No registry: the script clones the
   repository and builds on the machine (slow, needs Docker and about 25 GB).
2. **Where the script lives.** (a, recommended) every site serves `/install.sh` and each GitHub release carries it; the documented one-liner points at a
   short name the owner owns (for example `get.manythreads.<owner's domain>`, which redirects to the newest release). This needs the release assets to be
   public: is the repository going public, or should the script and `release.json` live in a small public repository of their own?
3. **TLS default with no domain.** (a, recommended) the sslip.io name with Let's Encrypt, self-signed when that cannot work; (b) always self-signed unless a
   domain is given; (c) plain HTTP unless a domain is given.
4. **Which templates are predefined** (pre-ticked in the Teams step). Recommended: Engineering pre-ticked; Marketing and Customer support shown and unticked;
   Product design and Research under "More". Or name your own set.
5. **Default providers and the model for each alias.** Recommended order: Anthropic, OpenAI, Google, OpenRouter (as an OpenAI-compatible endpoint), Ollama
   (local). The owner names the model bound to `smart`, `fast` and `code` for each provider (kept in one shared table, updated per release), and the default
   monthly spend cap (recommended $25, the cap used for the Phase 26 proofs).
6. **Brain's runner on a fresh install.** (a, recommended) the LLM gateway runner `models` (no shell, the cheapest); (b) the Engineering team's managed Hermes pod
   (needs the workspace-bot profile built).
7. **Where the Engineering chain runs by default.** (a, recommended) a Codex or Claude Code pod when the admin signed one in, else the team's managed Hermes pod;
   (b) always the managed Hermes pod (no subscription needed, model keys only).
8. **The first delivery's repository.** (a, recommended) the owner publishes a public template repository from `templates/_starter/`; the admin makes their copy
   and a bot account token; the change is deployed to the team's apps namespace. (b) Skip GitHub: the chain works in the team's own repository on the site and
   no pull request is opened (needs a publisher mode that does not exist yet).
9. **Seeing the first password again.** (a, recommended) kept in a Secret until changed, shown by `sudo manythreads admin-password`; (b) never kept: only a reset.
10. **The admin's email.** Asked during the install with `admin@<host>` as the default (recommended), or required as `--admin-email`.
11. **Machine sizes.** Recommended: refuse under 8 GB of memory or 40 GB of free disk; 16 GB, 8 cores and 100 GB for the full journey (pods on). And for the live run:
    will the owner provide a throwaway cloud machine of that size with a public address (recommended), or should the operator try the nested VM on the devbox
    (it does not fit next to the live site)?
12. **arm64.** Later (recommended), or now (doubles the image builds; the devbox would build them under emulation).
13. **Sign-ins for the live run.** The owner's own Claude and ChatGPT accounts (as in Phase 26), or accounts made for the bots.
14. **Which git hosts a fresh install may copy from** (`repoOriginAllow`). Recommended: `https://github.com/` and `https://gitlab.com/`; an admin's own GitLab is
    added with `manythreads upgrade --allow-git-host <url>`.
