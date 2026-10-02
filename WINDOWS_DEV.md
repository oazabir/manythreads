# Windows development — local edit, devbox build/deploy (no WSL)

The loop: **edit, lint and typecheck on Windows** → **rsync the working tree to the
`devbox` host** → **build, test, deploy and verify there**. Everything slow or
Linux-only (vitest against a real Postgres, Docker image builds, k3s, Helm) runs on
the devbox; Windows only edits files and forwards commands. No WSL is used or needed.

```
Windows                                     devbox  (root@65.109.71.84:44033)
C:\Users\omar\manythreads                   /root/manythreads
  edit · pnpm lint · pnpm typecheck
        │
        │  tools\devbox\Sync-Up.ps1     (native rsync 3.5 over SSH, MSYS2)
        ▼
                                            pnpm install · lint · typecheck · vitest
                                            docker build server+web → k3s ctr import
                                            helm upgrade --install · smoke test
        ▼                                             │
https://manythreads.kahf.to  ◄── k3s (Traefik ingress, namespace `manythreads`)
```

The scripts live in `tools\devbox\` — see [Scripts](#scripts) below.

## What runs where

| Step | Where | Command |
|---|---|---|
| Edit files | Windows | your editor |
| Lint + typecheck | Windows (fast, local) | `.\tools\devbox\Check.ps1` |
| Sync working tree | Windows → devbox | `.\tools\devbox\Sync-Up.ps1` |
| `pnpm install` | devbox | via `remote-gates.sh` |
| Unit/integration tests (vitest) | devbox (compose Postgres `:55432`) | via `remote-gates.sh` |
| Build images (`docker build`, includes `vite build`) | devbox | via `deploy.sh` |
| Deploy to k3s (`helm upgrade --install`) | devbox | via `deploy.sh` |
| Verify the live site | Windows (curl) + devbox (kubectl) | end of `Ship.ps1` |

The GitHub Actions deploy path (tags/`main` → `release.yml`/`ops-rollout`, see
[docs/deploy.md](docs/deploy.md)) is unchanged and still deploys **committed `main`**.
This loop is for iterating on your working tree; a `Ship.ps1` deploy is overwritten
the next time Actions deploys `main`.

## One-time setup (Windows)

Already done on this machine (2026-10-02); kept here to rebuild or copy elsewhere.

1. **Toolchain** — Node ≥ 22 (`.nvmrc`), pnpm 10 (`corepack`/`packageManager`),
   Git. Verify: `node -v; pnpm -v; git --version`.
2. **LF checkouts** (byte-identical sync — repo blobs are LF):
   ```
   git config core.autocrlf false
   ```
3. **Native rsync** (MSYS2 build, not WSL):
   ```
   winget install MSYS2.MSYS2
   & C:\msys64\usr\bin\pacman.exe -S --noconfirm rsync openssh
   ```
   `rsync.exe` and `ssh.exe` land in `C:\msys64\usr\bin` — deliberately **not** added
   to `PATH` (that directory would shadow Windows `sort`/`find`); the scripts locate
   them by path.
4. **SSH access to the devbox** — `%USERPROFILE%\.ssh\config` must contain:
   ```
   Host devbox
       HostName 65.109.71.84
       User root
       Port 44033
       # ControlMaster multiplexing disabled: Windows OpenSSH has no unix-socket
       # support and fails with "getsockname failed: Not a socket".
       ControlMaster no
       ServerAliveInterval 60
       ServerAliveCountMax 3
   ```
   with key auth (`%USERPROFILE%\.ssh\id_ed25519`). Check: `ssh devbox hostname`
   must print `ubuntu-vm`.
5. **Execution policy** for the `.ps1` scripts:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (already set here).

## One-time setup (devbox)

Already done; rebuild steps only.

1. Ubuntu 24.04 with: Node 22 (nodesource), `corepack prepare pnpm@10.28.0 --activate`,
   Docker (`get.docker.com`), k3s (`curl -sfL https://get.k3s.io | sh -`), `git`.
2. `git clone https://github.com/oazabir/manythreads.git /root/manythreads`
   then `pnpm install` there.
3. **Test Postgres image in the Docker daemon** (compose builds it otherwise, which
   recompiles pgvector for minutes — the image already exists in k3s):
   ```
   k3s ctr -n k8s.io images export - docker.io/manythreads/postgres:19 | docker load
   ```
4. Helm + the CloudNativePG operator are installed/kept by `deploy.sh`.
   Chart and runtime details: [docs/deploy.md](docs/deploy.md).

## Daily workflow

```powershell
# Fast inner loop — edit, then check locally (≈1 min, no network):
.\tools\devbox\Check.ps1

# Ship everything: local gates -> rsync -> remote install/lint/typecheck/tests
#                    -> docker build -> helm deploy -> verify the live site:
.\tools\devbox\Ship.ps1

# Variants:
.\tools\devbox\Ship.ps1 -SkipTests                # quick cycle (skip vitest)
.\tools\devbox\Ship.ps1 -SkipDeploy               # run the remote gates only
.\tools\devbox\Ship.ps1 -ExpectString 'win-dev'   # also assert the page serves text
```

Granular steps when you want them:

```powershell
.\tools\devbox\Sync-Up.ps1                         # push working tree to the devbox
.\tools\devbox\Remote.ps1 "pnpm test --maxWorkers=3"   # any command on the devbox
.\tools\devbox\Remote.ps1 "kubectl -n manythreads get pods"
.\tools\devbox\Sync-Down.ps1                       # pull remote-side changes back
```

## Scripts

| Script | What it does |
|---|---|
| `Check.ps1` | Local gates: `pnpm lint` (eslint + stylelint) + `pnpm typecheck` (tsc, all workspaces). No Docker, no SSH. |
| `Sync-Up.ps1` | rsync working tree → `devbox:/root/manythreads/` with `--delete` (renames/`rm` propagate). |
| `Sync-Down.ps1` | rsync back the other way (no `--delete`) — for files generated or edited on the devbox. |
| `Remote.ps1 "<cmd>"` | Run one command on the devbox inside `/root/manythreads`. |
| `Ship.ps1` | The full pipeline: `Check` → `Sync-Up` → `remote-gates.sh` → `deploy.sh` → verify. Switches: `-SkipLocal`, `-SkipTests`, `-SkipDeploy`, `-ExpectString`. |
| `_common.ps1` | Shared rsync/ssh discovery and the exclude list (dot-sourced, not run directly). |
| `remote-gates.sh` | Runs on the devbox: `pnpm install` → `pnpm lint` → `pnpm typecheck` → `pnpm db:up` → `pnpm test --maxWorkers=3`. `--no-tests` stops after typecheck. |
| `deploy.sh` | Runs on the devbox: `docker build` server+web → import into k3s containerd → prune old tags → `helm upgrade --install` → smoke-test the site. |

## How deploy + verify works

- **Image tag** = `git rev-parse --short=12 HEAD`, and, when the working tree differs
  from HEAD (the normal state in this loop), a `-<content-hash>` suffix computed from
  `git diff HEAD` + untracked files. Without that suffix, deploying uncommitted
  changes would rebuild the image under an unchanged tag and k3s would keep serving
  the previous one. A second deploy of identical content is a no-op (same tag).
- `deploy.sh` imports images into k3s containerd (`imagePullPolicy: IfNotPresent`,
  no registry), prunes server/web tags that are neither the new one nor in use by a
  pod, runs `helm upgrade --install manythreads --wait` and curls the site.
- **Verification** at the end of `Ship.ps1`: `/` → 200, `/healthz` + `/readyz` → ok
  from *this* machine (proves the public path works), the deployed image tag, pod
  status, and optionally `-ExpectString` — a string the served page must contain,
  which is how you prove a specific code change is live.
- **Rollback** (devbox deploys): `.\tools\devbox\Remote.ps1 "helm -n manythreads rollback manythreads"`
  (previous revision's images are still on the node). For the Actions path use the
  `ops-rollback` workflow ([docs/deploy.md](docs/deploy.md)).

## Sync rules

- **Contents only, not history.** rsync copies the working tree; `.git/` is excluded
  on both sides. Commit/push with git as usual (`git push` / on the devbox
  `git pull`) — the devbox checkout tracks the same origin.
- **Never syncs:** `.git/`, `node_modules/`, build output (`dist/`, `build/`,
  `.vite/`, `.turbo/`, `coverage/`, `playwright-report/`, `test-results/`),
  `*.log`, `*.tsbuildinfo`, `.env`, `e2e/data/`, `e2e/.auth/`, `data/repos/`,
  and `AGENTS.md` (a symlink on Linux that Windows materializes as a regular file;
  its target `CLAUDE.md` syncs normally). List: `tools\devbox\_common.ps1`.
- Both sides need LF line endings (`core.autocrlf false`) so diffs stay empty.
- `Sync-Up` uses `--delete`: files you rename or delete locally disappear on the
  devbox too (the script preserves the excludes, so remote `.git`, `node_modules`
  etc. are never touched).

## Windows-specific pitfalls (already fixed — don't undo)

- **`tsc` resolves modules case-insensitively on Windows.** With both
  `channels/markdown.ts` and `channels/Markdown.tsx` in one directory, `import … from
  './Markdown'` probed `Markdown.ts`, matched `markdown.ts` through the
  case-insensitive filesystem and loaded the wrong module (TS1149/TS2305 locally,
  green on Linux). Rule: **in one directory, no two files may have names equal only
  in case across `.ts`/`.tsx`** — that is why the components are
  `MessageMarkdown.tsx` / `SearchHighlight.tsx` and the parser files keep the
  lowercase names. Check with the scan in [MISTAKES.md](MISTAKES.md) history or just
  run `Check.ps1`.
- **rsync must spawn the MSYS2 `ssh.exe`, not `C:\Windows\System32\OpenSSH\ssh.exe`.**
  An MSYS2 process starts Win32 children with MSYS2 pipe handles; Windows ssh fails
  to read that stdin (`channel 0: read failed`) and rsync dies with "connection
  unexpectedly closed … 0 bytes". `_common.ps1` picks the sibling `ssh.exe`
  automatically and passes the Windows `~/.ssh` paths explicitly (MSYS2 ssh resolves
  `~` from its own passwd table, so it would not find them otherwise).
- No WSL dependency anywhere. (If an older checkout still has WSL-based sync scripts,
  they are superseded — this tree uses native `C:\msys64\usr\bin\rsync.exe`.)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `rsync.exe not found` | `winget install MSYS2.MSYS2` then `& C:\msys64\usr\bin\pacman.exe -S --noconfirm rsync openssh` |
| `MSYS2 ssh.exe not found` | `& C:\msys64\usr\bin\pacman.exe -S --noconfirm openssh` |
| `ssh devbox` asks for a password / Permission denied | Key auth broken: the public key must be in the devbox `~/.ssh/authorized_keys` (key: `%USERPROFILE%\.ssh\id_ed25519`). |
| rsync: `connection unexpectedly closed … 0 bytes` | `-e` is using the Win32 ssh — run `.\tools\devbox\Sync-Up.ps1` from this tree (it selects the MSYS2 ssh), or reinstall `openssh` from pacman. |
| Remote tests fail to connect to Postgres | Start the dev DB on the devbox: `.\tools\devbox\Remote.ps1 "pnpm db:up"` (compose, port 55432; independent of the live CNPG cluster). |
| Tests exhaust connections / are slow | Keep `--maxWorkers=3` (the dev Postgres has 100 connections and is shared with other agents). |
| `pnpm typecheck` TS1149/TS2305 only on Windows | A new case-colliding file pair was added — rename one file (see pitfalls above). |
| Deployed site did not change | Check the tag in the `deployed ->` line of `Ship.ps1`; the tree must differ from the previous deploy's content (the `-<hash>` suffix changes only when the tree changes). |
| helm `--wait` warned but web/pods are ready | Server crash-loop is tolerated by `deploy.sh` while `packages/server/src/main.ts` is a stub — read `kubectl -n manythreads get pods`. |
| Want to re-run just one remote step | `.\tools\devbox\Remote.ps1 "<anything>"` — e.g. `bash tools/devbox/remote-gates.sh --no-tests`. |
