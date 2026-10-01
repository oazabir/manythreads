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
  mentions: orchestrator
  handover: { mayTag: [reviewer, tester], toPerson: [role:on-call] }
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
- Production deploys and gated topics wait for a person.
- Incidents are coordinated in #incidents; alerts land in #alerts first.
