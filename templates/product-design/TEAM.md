---
name: Product design
template: product-design
channelGroups:
  - name: Making
    channels: ["#design", "#specs"]
  - name: Learning
    channels: ["#feedback", "#critique"]
roleTags: [role:design-lead, role:product-owner]
defaults:
  board: Design board
  approvers: [role:design-lead]
dispatch:
  mentions: spec-writer
  handover: { mayTag: [design-critique], toPerson: [role:product-owner] }
---

# Product design

Purpose: decide what to build and make it clear enough to build well.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:design-lead` approves designs before hand-off.
- `role:product-owner` accepts specs and sets priority.

## Working agreements

- A spec states the problem, the choice made and what was rejected.
- Feedback keeps its source link so a theme can be traced back to the person who said it.
