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
