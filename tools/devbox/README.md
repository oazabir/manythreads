# devbox scripts

The Windows development loop these scripts implement is documented in
[WINDOWS_DEV.md](../../WINDOWS_DEV.md) at the repo root (setup, daily workflow,
sync rules, troubleshooting).

| Script | Purpose |
|---|---|
| `Check.ps1` | Local gates: `pnpm lint` + `pnpm typecheck` on Windows. |
| `Sync-Up.ps1` | rsync working tree → `devbox:/root/manythreads/` (native MSYS2 rsync, no WSL). |
| `Sync-Down.ps1` | rsync the devbox checkout back (rarely needed). |
| `Remote.ps1 "<cmd>"` | Run one command on the devbox inside the repo. |
| `Ship.ps1` | Full pipeline: local gates → sync → remote install/lint/typecheck/tests → docker build + helm deploy to k3s → verify https://manythreads.kahf.to/. |
| `_common.ps1` | Shared rsync/ssh discovery + exclude list (dot-sourced). |
| `remote-gates.sh` | Runs on the devbox: `pnpm install`, lint, typecheck, `pnpm db:up`, `pnpm test`. |
| `deploy.sh` | Runs on the devbox: build server+web images, import into k3s, prune old tags, `helm upgrade --install`, smoke-test the site. |

Devbox: `root@65.109.71.84:44033` (SSH host `devbox`, see `~/.ssh/config`), checkout
`/root/manythreads`, k3s serves **https://manythreads.kahf.to** (namespace
`manythreads`). Model: edit locally, sync over SSH, everything slow runs on the
devbox — never deploy from Windows.
