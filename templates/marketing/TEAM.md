---
name: Marketing
template: marketing
channelGroups:
  - name: Planning
    channels: ["#campaigns", "#brand"]
  - name: Production
    channels: ["#content", "#social", "#analytics"]
roleTags: [role:brand-owner, role:campaign-owner]
defaults:
  board: Marketing board
  approvers: [role:brand-owner]
dispatch:
  mentions: content-drafter
  handover: { mayTag: [brand-reviewer], toPerson: [role:campaign-owner] }
---

# Marketing

Purpose: tell our story, run campaigns and learn from the results.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:brand-owner` approves anything published under the brand.
- `role:campaign-owner` owns a campaign's goal and hands work to bots.

## Working agreements

- Nothing is published without the Brand reviewer's pass and a person's approval.
- Performance questions go to #analytics so the digest and Brain share one thread.
