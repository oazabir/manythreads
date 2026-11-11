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
  handover: { mayTag: [plan-reviewer, coder, code-reviewer, tester, committer, deployer, web-smoke-tester], toPerson: [role:on-call] }
---

# Engineering

Purpose: build, ship and run our software.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:on-call` holds the pager. Incident approvals and handovers to a person go here.
- `role:release-manager` signs off production deploys.
- `role:reviewer` reviews code a bot proposes.

## Getting started (the lead)

1. **Add a project** on the Projects page: the repository's address, its main branch and the channel the work is discussed in.
2. **Connect GitHub** on the same page, in that project's Pull requests box: your GitHub username and a token that can write to the repository
   (contents and pull requests). GitHub is asked about the token before it is kept, and it is kept in the team's pod where no bot can read it. Tick
   "Use for every project of this team that lives under" the owner to enter it once for all of them; this covers only the projects that exist when you
   save (a project added later needs the box ticked again), and a project that already has a token of its own is left as it is. Until this is done, Committer cannot send a tested
   branch to GitHub; it says so in the thread and the work goes on to Deployer.
3. **Watch the expiry.** The page shows when the token expires and warns two weeks before. If GitHub stops accepting it, the page reads "Token needs
   replacing" and the bots stop trying until a lead saves a new one.
4. **Ask for a goal** in the project's channel and Engineer starts the chain below. Never paste a token in a thread: the guard blocks it.

## Working agreements

- A bot owns one task at a time and works on its own branch.
- A goal asked in a project channel runs as a chain: Engineer writes the plan and Plan reviewer reads it (up to three rounds); then Engineer
  splits it into cards and keeps one checklist current in the thread. Coder writes the change, Code reviewer reads it (up to three rounds),
  Tester writes automated tests and runs the whole suite, and a failure goes back to Coder, through Code reviewer, to Tester again until
  the commit is tested. Engineer then hands the card to Committer, the only bot that holds the right to push to GitHub: it publishes the tested commit as a pull request for a person to merge (a project with no GitHub credential skips this). Deployer puts the tested commit into the team's preview namespace in k3s, and Web smoke tester checks the running
  site with Playwright and headless Chromium. The bots share what they learn through the team's memory (never passwords; the one exception is the disposable password of a preview test account, which goes only in the private note of Deployer's handover to Web smoke tester, never in a thread, and is destroyed with the preview; nobody asks for credentials in a thread).
- Production deploys and gated topics wait for a person.
- Incidents are coordinated in #incidents; alerts land in #alerts first.
