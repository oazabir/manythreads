# Runners on the live site: the owner's checklist (P19-12, P19-13)

Everything the platform can prove about runners without a real login is proved by tests and by the throwaway stage (below). This page is the part that needs **you**: a real Claude login made for the runner, a real Codex login, turning on Secrets encryption, and switching the Claude and Codex runners on. Nothing here is done by a coding session unless you say so in that session. Tick the boxes in order; each step says how to undo it.

Words used: a **runner** is a place bots run (Runners page, admin only). A **sign-in file** is the login of a Claude or Codex account; it is as sensitive as a password. **The stage** is a throwaway second copy of the site (`tools/devbox/stage.sh`) that never holds a real login.

## 0. What is already proved without you

| Claim | Where it is proved |
| --- | --- |
| A lead, a member and a guest cannot learn an address, key, node or sign-in detail from any runner, bot or team route, event, error or bot page | `e2e/runners/visibility.spec.ts` (every route of the runners and bots API, as each person, searched for the seed's canary values) |
| A canary placed in a sign-in file shows up in no log line, event, audit row, message or answer | `e2e/runners/canary.spec.ts` |
| A lead who is not an admin can place a bot on each kind of runner and get a reply | `e2e/runners/placement.spec.ts` (stand-ins) |
| Data protection blocks or hides each sign-in token shape in an outbound message, and the bridge hides them in a final answer | `packages/plugins/guardrails-dlp/test/signin-shapes.test.ts`, `tools/agent-bridge/test/process.test.ts` |
| A pod cannot reach the cluster API with data, `169.254.169.254` or an unlisted private host; nothing an operator can read holds a sign-in byte; each service account may do exactly what `docs/plugins/security.md` lists | `tools/devbox/stage-runners-probe.sh check` on the stage |
| Remove sign-in (and a node move) leaves no credentials Secret and no state volume behind | `packages/plugins/claude-pods/test/signin-removal.test.ts` and `stage-runners-probe.sh remove` |
| The scripts below refuse to do anything risky without you | `tools/devbox/test/runner-scripts.test.ts` |

What these cannot prove, and why you are needed: the real sign-in shapes (the DLP shapes are written from the file formats, not from a measured real token), the real texts the tools print when a login is refused or a limit is reached, the real list of hosts a pod must reach, and that the encrypted datastore comes back after a restart.

## 1. Run the stage proof (no real login, safe to repeat)

On the devbox, with no CI run going and nobody else using the stage:

```
tools/devbox/stage-runners-probe.sh image                 # builds the stand-in pod image into k3s (needs 10 GB free)
STAGE_PROFILE=runners tools/devbox/stage.sh up            # the throwaway copy: namespaces manythreads-stage and manythreads-stage-bots
tools/devbox/stage-runners-probe.sh seed                  # six runners, six bots, two made-up Claude logins
kubectl -n manythreads-stage-bots get pods                # wait until the claude-* pods are Running (a minute or two)
tools/devbox/stage-runners-probe.sh check                 # every line must say PASS
tools/devbox/stage-runners-probe.sh remove                # Remove sign-in on one runner, then no Secret and no state volume may be left
tools/devbox/stage.sh down                                # the stage and its two namespaces are removed
```

- [ ] `check` ends with "all checks passed". A FAIL line names the door that is open or the byte that leaked; fix that before going on.
- [ ] `remove` prints PASS for "no credentials Secret" and "no state claim".

The stage touches only `manythreads-stage` and `manythreads-stage-bots`. The live namespaces `manythreads` and `manythreads-bots` are never named by these commands.

## 2. Turn on Secrets encryption (your hands, a quiet hour)

Until this is done, every Kubernetes Secret (including a runner's sign-in file) sits in the k3s datastore as plain base64. Turning it on **restarts the k3s server**: for about a minute the cluster API does not answer and the live site may blink. Take a fresh backup first (`tools/backup/`).

- [ ] `tools/devbox/secrets-encrypt.sh status` (read only). Today it says "Disabled".
- [ ] `tools/devbox/secrets-encrypt.sh enable --dry-run --yes-i-am-the-owner` shows what will run and changes nothing.
- [ ] `tools/devbox/secrets-encrypt.sh enable --yes-i-am-the-owner` enables, restarts k3s, waits for the API, re-encrypts every Secret and checks the datastore (it prints "DONE" only when the stored Secrets begin with the encrypted marker).
- [ ] Open the live site; check the page loads, a bot answers, and `kubectl get pods -A` shows nothing stuck.
- [ ] Back up `/var/lib/rancher/k3s/server/cred/encryption-config.json` **with** the datastore backup: a datastore without its key cannot be read.
- Later: `tools/devbox/secrets-encrypt.sh rotate --yes-i-am-the-owner` makes a new key and re-encrypts (no restart on a single server).
- **Undo:** `k3s secrets-encrypt disable`, `systemctl restart k3s`, `k3s secrets-encrypt reencrypt`. Keep the key file.

## 3. A second Claude login for the runner (P19-01, owner blocker 1)

Use a login made **for this**, not the one you work in: two copies of one login sign each other out, and the platform refuses a login another runner already holds.

- [ ] Make a second Claude account login on a machine of yours (`claude` then `/login`).
- [ ] Turn the Claude runners on (step 5) on the stage first, or on live if you accept it.
- [ ] Runners > Add > Claude Code. Choose the teams. Upload the new `.credentials.json` on the runner's page and tick the two boxes (it may hold other services' sign-ins; it is stored as it is).
- [ ] "Check sign-in" says it works. The page shows the plan and "Connected as ..." only when the pod could confirm it.
- [ ] Place one bot on the runner (BOT.md `placement.runs_on: <runner name>`), mention it in a thread, and read the answer.
- [ ] Look at the real refusal and limit texts the tool prints (`kubectl -n manythreads-bots logs deploy/claude-<runner> -c bridge`) and copy their exact words into the issue for P19-01, so `FAILURE_PATTERNS` can stop using stand-in texts. Do not paste the file.
- [ ] Measure the shapes: do the access and refresh tokens begin `sk-ant-oat01-` and `sk-ant-ort01-`? If not, tell the session that owns `packages/plugins/guardrails-dlp/src/dlp.ts` and `tools/agent-bridge/src/process.ts`: the shapes are guesses until measured (the sign-in file's own field names are hidden whatever the value looks like, so a wrong guess is not a leak of those fields, but a token printed on its own in an answer would not be caught).
- **Undo:** Remove sign-in on the runner's page (deletes the credentials Secret and the pod's state volume), then delete the runner.
- 2026-11-11: measured against the host's own `claude` 2.1.319 (owner decision: no second login); real refusal texts, event shapes and token shapes are in `docs/spikes/host-claude-codex-measured.md`, and `FAILURE_PATTERNS` use them. The checklist items above that need a pod and a second login stay open.

## 4. The Codex test (P19-13, owner blocker 2)

Needs your go-ahead in the session that runs it, because the file is a real ChatGPT login.

- [ ] Copy your Codex `auth.json` into a **throwaway** pod (not the live one), run one `codex exec`, then one product run.
- [ ] Copy the pod's newest `auth.json` back and check `codex login status` still says logged in (a reused refresh token logs the account out).
- [ ] Note whether the tool makes a lock file next to `auth.json` while it renews (the keeper waits for `auth.lock` if it exists; the name is a guess).
- [ ] Note the model names for the alias map and the exact text for "refresh token reused" and "limit reached".
- [ ] Measure the shapes: ChatGPT tokens are JSON web tokens (`eyJ...`) and the refresh token begins `rt_`; confirm, or tell the DLP owner.
- **Undo:** delete the throwaway pod; Remove sign-in on the runner if one was made.
- 2026-11-11: measured against the host's own `codex` 0.166.0 (owner decision); `auth.lock` exists, the refresh token begins `rt.1.` not `rt_` (DLP and bridge now match it), model names and the not-logged-in text are in `docs/spikes/host-claude-codex-measured.md`. A pod copy of `auth.json` was not made.

## 5. Switching the Claude and Codex runners on in the live site (owner blocker 4)

Today the Runners page on the live site shows the Claude Code and Codex cards shut with "Not turned on in this install." Turning them on adds a pod per runner to the pods namespace and the rights listed in `docs/plugins/security.md`, "Rights of the runner pods".

- [ ] Read that section and accept the rights (owner blocker 5).
- [ ] Do steps 1 to 3 first, so the first thing that holds a real login is a Secret that is encrypted at rest.
- [ ] In `deploy/helm/manythreads/values-live.yaml` set `claudePod.enabled: true` and leave `claudePod.useFake: false`. Free disk is checked by `deploy.sh` (it stops under 10 GB).
- [ ] `tools/devbox/deploy.sh` (builds the pod image, upgrades the release).
- [ ] The Runners page now lets you add a Claude Code runner. Run `e2e/screens/task.verify-bundle-e.shots.ts` against live (read only) to see it: `MANYTHREADS_LIVE_URL=https://manythreads.kahf.to pnpm -C e2e exec playwright test -c screens/task.config.ts verify-bundle-e --retries=0 --workers=1`.
- **Undo:** `claudePod.enabled: false`, deploy. Pods stop; volumes and Secrets stay until you delete the runners.

## 6. Other owner-blocked items from this bundle (listed so none is lost)

- [ ] A bucket and keys for database WAL archiving, and the Barman Cloud plugin (`postgres.objectStore`, off by default). Until then the nightly `pg_dump` is the backup, and the System health page says "Replica lag: no standby" on a single-machine install.
- [ ] A monitoring stack on the live cluster (`deploy/helm/monitoring/`, files only).
- [ ] Per-team namespaces for Hermes pods and Activepieces are not built.

## If something looks wrong

- A sign-in byte in a log, event or answer: stop the runner (switch it off on the Runners page), run `stage-runners-probe.sh check` on the stage to see which door, and keep the log line out of any ticket. Replace the login (sign out of the account at claude.ai or ChatGPT) because it is exposed.
- The pod cannot renew its login (the keeper line fails): the runner works until the access token runs out, then asks for a new file. The fix is a network rule, see `docs/plugins/security.md`.
