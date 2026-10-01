---
name: Research
template: research
channelGroups:
  - name: Reading
    channels: ["#papers", "#reading-group"]
  - name: Work
    channels: ["#experiments", "#notes"]
roleTags: [role:principal-investigator, role:reading-group-host]
defaults:
  board: Research board
  approvers: [role:principal-investigator]
dispatch:
  mentions: summariser
  handover: { mayTag: [citation-checker], toPerson: [role:principal-investigator] }
---

# Research

Purpose: learn things carefully and keep the record where the team can find it.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:principal-investigator` signs off conclusions before they leave the team.
- `role:reading-group-host` picks the weekly paper.

## Working agreements

- Every experiment has a plan, parameters and a result recorded on the board.
- A claim in a draft cites a source the Citation checker has verified.
