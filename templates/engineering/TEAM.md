---
name: Engineering
template: engineering
channelGroups:
  - name: Team
    channels: ["#general", "#dev", "#standup"]
  - name: Operations
    channels: ["#releases", "#incidents", "#alerts"]
roleTags: [role:on-call, role:release-manager, role:reviewer]
defaults:
  board: Engineering board
  approvers: [role:on-call]
dispatch:
  mentions: engineer
  handover: { mayTag: [plan-reviewer, coder, code-reviewer, tester, deployer, web-smoke-tester], toPerson: [role:on-call] }
---

# Engineering

Purpose: build, ship and run our software.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:on-call` holds the pager. Incident approvals and handovers to a person go here.
- `role:release-manager` signs off production deploys.
- `role:reviewer` reviews code a bot proposes.

## Working agreements

- A bot owns one task at a time and works on its own branch.
- A goal asked in a project channel runs as a chain: Engineer writes the plan and Plan reviewer reads it (up to three rounds); then Engineer
  splits it into cards and keeps one checklist current in the thread. Coder writes the change, Code reviewer reads it (up to three rounds),
  Tester writes automated tests and runs the whole suite, and a failure goes back to Coder, through Code reviewer, to Tester again until
  the commit is tested. Deployer puts the tested commit into the team's preview namespace in k3s, and Web smoke tester checks the running
  site with Playwright and headless Chromium. The bots share what they learn through the team's memory (never passwords; the one exception is the disposable password of a preview test account, which goes only in the private note of Deployer's handover to Web smoke tester, never in a thread, and is destroyed with the preview; nobody asks for credentials in a thread).
- Production deploys and gated topics wait for a person.
- Incidents are coordinated in #incidents; alerts land in #alerts first.
