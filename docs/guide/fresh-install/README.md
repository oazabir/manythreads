# The fresh-install journey

A re-runnable script that walks a freshly installed site (the install profile, no demo data) the way its first admin does, and ends with four runners that each
answered a real message. It is a browser test driven by Playwright. It is not part of the normal suite: it needs a site that is already up.

What it does, in order:

1. Signs in with the password the installer printed, and is made to choose a new one.
2. Opens the setup wizard and does what each of its thirteen steps asks, for real: look, organization name, address, the model key (entered in the wizard, then the
   `smart`, `fast` and `code` aliases are tested), sign-in policy, every team template, this machine as a server, a Hermes pod that answers a real question, where bots
   run, a starter repository, Brain's cited answer, and the first delivery (the Engineer to a pull request).
3. Makes the Claude Code runner and the Codex runner and uploads the sign-in file of each through the upload form of the Runners page. Such a pod stays stopped until a bot is placed on it, so the wait for "ready" comes after the next step.
4. For each of the four runners (the host's Hermes agent, the team's Hermes pod, the Claude Code pod, the Codex pod) places a bot on it, waits until the runner is ready and until the new bot
   answers a throwaway question (a bot that was only just placed answers "I couldn't answer" for a while; the report says how long), and then checks that:
   - a message to the bot in a channel gets an answer that carries a code word the test chose (so an old answer cannot pass);
   - a direct message gets the same;
   - a fact told in a channel is found again when asked in a direct message (memory);
   - the Claude Code and Codex bots make a file in the starter repository and report the hash of it (a hash only a real shell run can produce).
5. Shoots the Runners page, then replays every page at 390 by 844, light and dark for the main ones, and checks that none scrolls sideways.

Every step is numbered, timed and recorded as pass, fail or "skipped: <reason>". A wait never lasts for ever: a step that cannot start says why and the run goes
on. Running it again after the wizard is partly done skips what is already true (a step is read from the page's own facts, as the wizard does).

## Run it

```
JOURNEY_URL=<the site's address> \
JOURNEY_ADMIN_EMAIL=<the first admin> \
JOURNEY_ADMIN_PASSWORD=<the password the installer printed> \
JOURNEY_NEW_PASSWORD=<the password to choose> \
JOURNEY_MODEL_KEY_ENV=<name of the variable that holds the model key> \
  pnpm -C e2e exec playwright test -c onboarding/journey.config.ts
```

Every address, sign-in, key and token comes from the environment. Nothing has a default that points at a real site. The new password is never written to disk, and the
report and every log line pass through a filter that replaces the secrets and the site's address.

| Variable | Meaning |
|---|---|
| `JOURNEY_URL` | The site's address (required). |
| `JOURNEY_ADMIN_EMAIL`, `JOURNEY_ADMIN_PASSWORD`, `JOURNEY_NEW_PASSWORD` | The first admin, the password from the installer and the one to choose (required). A second run, after the password was changed, signs in with the new one. |
| `JOURNEY_MODEL_KEY_ENV` or `JOURNEY_MODEL_KEY` | The model key, or the name of the variable that holds it. Without it the models step is skipped and so is everything that needs a model. |
| `JOURNEY_MODEL_PRESET`, `JOURNEY_MODEL_BASE_URL`, `JOURNEY_MODEL_NAME` | The provider choice of the models step (default `other-plan`; a choice that needs an address or a model name reads them here). |
| `JOURNEY_ORG_NAME`, `JOURNEY_TEAM`, `JOURNEY_SERVER_LABEL` | The organization name, the team the bots go to (default `engineering`) and the name of the server to enrol. |
| `JOURNEY_ENROLL_CMD_RUNNER` | A shell command that receives the enrol command the wizard shows in `JOURNEY_ENROLL_COMMAND` and runs it on the machine to enrol. Without it the run writes the command to a file readable only by its owner (the path is logged, the command is not) and waits up to `JOURNEY_ENROLL_WAIT_S` seconds (default 900) for the server to connect. |
| `JOURNEY_NO_SERVER` | A sentence that says why this machine must not be enrolled (for example, it already serves another site: the bridge keeps one connection per machine). The server step and the host runner's steps are then skipped with that sentence, with no waiting. |
| `JOURNEY_CLAUDE_SIGNIN_DIR`, `JOURNEY_CODEX_SIGNIN_DIR` | Folders that hold `.credentials.json` and `auth.json` (see [the sign-in files](../runner-signin-files.md)). The files are handed to the browser as files; their text never passes through the script. |
| `JOURNEY_STARTER_REPO`, `JOURNEY_STARTER_USER`, `JOURNEY_STARTER_TOKEN` | The starter repository's address and the bot account's login and token for pushing. Without them the code step and the delivery are skipped. |
| `JOURNEY_RUNNERS` | Which runners to exercise: any of `host,pod,claude,codex` (default all). |
| `JOURNEY_ONLY`, `JOURNEY_SKIP` | Step ids to run alone or to leave out (the ids are in the report). |
| `JOURNEY_PASS` | `desktop`, `mobile` or both (default both). |
| `JOURNEY_ANSWER_TIMEOUT_S`, `JOURNEY_POD_WAIT_S`, `JOURNEY_DELIVERY_WAIT_MIN` | How long to wait for a bot's answer (300), for a pod to be ready (900) and for the delivery (60 minutes). |
| `JOURNEY_DELIVERY` | `0` leaves out the first delivery. |
| `JOURNEY_APPROVE` | `1` presses "Approve" on the approvals the delivery raises (through the Approvals page). Off by default: the run then only says that it is waiting. |
| `JOURNEY_SHOTS_DIR` | Where the screenshots and `fresh-install-report.json` go (default a folder under the system's temporary folder). |
| `JOURNEY_GALLERY` | `desktop` or `all` also copies the numbered shots into this folder. A gallery is always masked. |
| `JOURNEY_MASK_WORDS` | Extra words to cover in every shot (a machine name, a project name). |
| `JOURNEY_MASK` | `0` turns masking off for a private debugging run (never together with `JOURNEY_GALLERY`). |

## What it leaves behind

- `NN-<name>-1440.png`: the desktop pass, one numbered shot per moment. `mNN-<name>-390-light.png` and `-dark.png`: the phone pass.
- `fresh-install-report.json`: for each step its id, title, seconds, status and (for a skip or failure) the reason; the seconds each bot took to answer; the number of shots.
- `fail-<step>.png`: the page as it was when a step failed (never copied to the gallery).

## Masking

Before each shot the script puts a solid box over every e-mail, web address, IP number, host name, enrol code and long hash on the page, and over the same in text fields. The
text stays in the page, so nothing breaks; only the picture is covered. The existing `data-vt-mask` convention is honoured as well. Read a few shots after a run to confirm
nothing readable is left (the script does not look at the pictures).

## The small local proof

`e2e/onboarding/fresh-install.local.spec.ts` runs the journey's helpers against an isolated stack with stand-ins (a fake model server): the first sign-in with a new password,
the wizard steps that need no cluster, the numbered masked shots and the report. It does not touch a real site. The steps that need a machine or a cluster (a server, the
pods, bots on runners) can only be proved by the journey itself.

## How the gallery was made

The gallery in this folder, when it exists, is the output of one run of the journey on a newly installed machine with `JOURNEY_GALLERY=all`. Rerun it the same way to refresh
it: the run overwrites files of the same name.

The gallery here has no shot of a Claude Code or Codex bot answering: on the run it was made from, both pods were ready but the server could not reach them, so those
steps failed (the report, `fresh-install-report.json`, has the reason). The host machine's steps are skipped in it for a reason of their own: that machine already served another site.
