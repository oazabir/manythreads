- **The workspace Brain on the host gateway (mode A).** The Brain belongs to no team, so no team run writes its profile and a team run no longer adds a `brain` bot. As a workspace admin run `DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/provision-host-bots.mjs --workspace-brain [--brain-profile mt-brain] [--dry]`.
  It writes one profile (named by the default runner's profile rule with `{bot}` = `brain`, else `--brain-profile`) and mints the Brain's token (pairing, P20-LV). The Brain only runs once an admin has made a Hermes gateway runner the default (Admin > Bot runners) and that runner's profile rule names the profile the script wrote; with no default runner a run would start the `hermes` binary inside the server container, which has none, and fail at once.
# The devbox, the pipeline and the live site

Where code is built, tested and deployed, and the machine facts that break a pipeline run when ignored.

## Environment notes
- Windows dev loop (local edit + lint + typecheck, rsync to the devbox, build/test/deploy/verify there — no WSL):
  `WINDOWS_DEV.md`; scripts in `tools/devbox/` (`Check.ps1`, `Sync-Up.ps1`, `Remote.ps1`, `Ship.ps1`).
- Local docker daemon: start with `(dockerd >/tmp/dockerd.log 2>&1 &)` if `docker info` fails.
- Deploy target: k3s at manythreads.kahf.to. The GitHub Actions are the trigger, not the builder: the `ci` workflow
  copies the code to the devbox and runs `tools/devbox/ci.sh` there (build, test in the `manythreads-ci` namespace,
  then deploy to `manythreads`); `release` tags the phase; `deploy` re-deploys on demand.
  Phase exit: merge PR to main, with title "Phase N · <name>" — `release.yml` runs on that merge:
  it tags `phase-N` + `v0.N.0` (the sandbox cannot push tags: 403), and the `ci` workflow of the same push builds,
  tests and deploys it. `ops-*` workflows; `docs/deploy.md`.
  Read Actions results with GitHub MCP tools (`mcp__github__actions_list`, `get_job_logs`, tail ≤ 150). Every run's full log is also
  kept on the devbox in `/root/ci-logs/<time>-<sha>.log` (last 20); the run status and step timings are public on the GitHub API.
- **CI shares the devbox's dev Postgres (55432).** Run no vitest/playwright there while a pipeline runs:
  `pgrep -fx 'bash tools/devbox/ci.sh.*'` (a plain `pgrep -f tools/devbox/ci.sh` matches its own shell). Overlapping runs fail CI.
- **Disk is the devbox's tightest resource (77 GB).** At ~90% the kubelet evicts the live database and the team pods and deletes
  images; deploys drop Docker's copies of images k3s holds. After a deploy check `kubectl get pods -n manythreads-bots`, not only `/readyz`.
- Team bot definitions (`bots/<slug>/BOT.md`) are copies made from `templates/` when a team is created: a template fix does not reach an
  existing team until it is copied in by a repo commit (keep the team's own `placement` lines).
- The devbox has two checkouts: `/root/manythreads` (the Windows dev loop's, `Sync-Up.ps1`) and `/root/ci` (the
  pipeline's scratch copy, rewritten by every CI run). Never rsync over the first while another agent works in it.
- **Every bot of a team on this host's Hermes gateway (mode A).** Run `DEMO_EMAIL=... DEMO_PASSWORD=... node tools/devbox/provision-host-bots.mjs engineering customer-support marketing [--dry] [--force]`.
  The caller is a workspace admin, and each team needs a Hermes connection named `host`, or a runner named `host` that an admin made available to the team under Runners (override the name with `HERMES_CONNECTION`). On a fresh install make the runner: it needs the gateway's address and API key, and the team in its list.
  It adds the template bots the repo lacks, sets each bot's `placement` to `host` with profile `mt-<team>-<bot>`, and writes `$HERMES_HOME/profiles/mt-<team>-<bot>/`.
  A profile is a directory with `config.yaml` and `.env` (dir 0700, files 0600); the gateway key and model key are copied from `$HERMES_HOME/.env`, and shell bots get cwd `/srv/hostdev`.
  An existing bot gets its profile before its placement is committed. A new bot is added first, because a token can only be minted for a bot that exists.
  The profile's tools follow the bot's `capabilities.runtime` through `packages/plugins/runtime-hermes/src/toolsets.ts`: no `shell` means no terminal, no `files` means no file tools.
  A re-run keeps the other lines of `.env` and leaves a hand-edited `config.yaml` alone (`--force` replaces it and keeps a `.bak`).
  A kept token is checked at the MCP server with an `initialize` call, and only this probe checks it there. A token the server refuses (HTTP 401) is replaced by a new one.
  A new token whose files cannot be written is revoked again. The revoke turns off every live token of that bot, because the route has no finer grain.
  The script ends with a test of every profile through the connection. `--dry` changes nothing.
  Run `sync-engineering-bots.mjs` first with `TEMPLATE_PLACEMENT=1` for the chain bots' own text. The host gateway serves a new profile with no restart.
