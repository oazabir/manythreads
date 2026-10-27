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
