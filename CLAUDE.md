# manythreads — CLAUDE.md (AGENTS.md is a symlink to this file)

**Naming (owner rule): the product is `manythreads`. Never write the previous product name anywhere (the 6-letter Arabic word for "council") — code, packages
(`@manythreads/*`), env vars (`MANYTHREADS_*`), DB roles (`manythreads_*`), docs, UI copy, commits.**

manythreads is a self-hosted team collaboration platform where people and bots work together (channels, threads, bots, Brain).

## Read before a change
- `MISTAKES.md` — known mistakes; read it first, append what you learn.
- `docs/engineering/conventions.md` — the binding rules and guardrails (data, events, plugins, security, CSS, forbidden items, owner
  decisions, plain language). Every change follows them.
- `docs/engineering/build-and-test.md` — commands, gates and the rules for coding agents.

## Find what you need
- Plan and order of work: `PLAN.md` (phases run in its §7 Order column; binding decisions in §3). Progress: `STATUS.md`.
- Architecture: `docs/engineering/architecture.md` (stack, repo layout); contract `docs/spec/SPEC-FINAL.md`; operating model
  `docs/spec/IMPLEMENTATION-GUIDE.md`; each plugin's page under `docs/plugins/`.
- Look and copy: `docs/spec/mockups-all.html` (huge — never read it whole; grep the section id: onboarding app teams bots botgeneric
  setup workshop email surfaces connections cabinet brain).
- Build, pipeline, deploy and the live site: `docs/engineering/devbox.md`, `docs/deploy.md`, `docs/testing.md`, `WINDOWS_DEV.md`.

## Every change
- `pnpm lint` and `pnpm typecheck` stay green; run the tests of what you touched.
- Commit messages start with the task id (`P1-03: migration runner`).
- Never write the previous product name; never commit a secret.

## Do not run the devbox out of memory or disk (2026-11-13: a whole-repo `stylelint` ran 25 minutes and died with "heap out of memory")
The devbox has 15 GB and 8 cores and also runs k3s, Postgres and the live site: a runaway job there takes the site down, not only your run.
- **Never glob the repository root with a tool that walks folders** (`stylelint "**/*.css"`, `eslint .` with a new ignore gap, `grep -r`, `find .`, `rg -uu`): `node_modules` holds
  thousands of files behind pnpm's links and the ignore rules apply only after the walk. Give the tool a list of files from git
  (`git ls-files -z '*.css'`, as `tools/lint-css/cli.mjs` does) or name the folder (`clients/web/src`). Built output (`dist`, `dist-canary`) is never linted or searched.
- **One heavy job at a time.** Do not run lint, typecheck, vitest and a Docker build together, and do not start a second copy of a job that is still running. Run tests of the package
  you touched (`npx vitest run` inside it), not the whole repository, until the last gate. `pnpm typecheck` already limits itself to two at once; do not raise that.
- **Look before you start and while it runs:** `free -h` (stop under about 2 GB available), `df -h /` (a deploy peaks near 88% disk: prune with `docker builder prune -af` before it, and watch it). Start long commands
  in the background with a `timeout`, and kill one that runs more than ten minutes with a growing size. Kill by exact PID (`kill <pid>`); `pkill -f` and `pgrep -f` match your own shell (write `[s]tylelint`).
- **A "heap out of memory" is a bug in the command, not a limit to raise.** Do not set a bigger `--max-old-space-size` to get past it; find what the tool is reading.
