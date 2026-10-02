---
name: Customer support
template: customer-support
channelGroups:
  - name: Customers
    channels: ["#support", "#enquiries"]
  - name: Internal
    channels: ["#escalations", "#kb-updates"]
roleTags: [role:support-lead, role:escalation-owner]
defaults:
  board: Support board
  approvers: [role:support-lead]
dispatch:
  mentions: support-responder
  handover: { mayTag: [enquiry-bot], toPerson: [role:escalation-owner] }
---

# Customer support

Purpose: answer customers quickly and correctly, and hand over what a bot should not decide.

## Roles

- `lead` runs the team and approves changes to `bots/`, `TEAM.md`, `skills/` and `routines/`.
- `role:support-lead` approves outbound email drafted by a bot.
- `role:escalation-owner` takes cases the Escalation router cannot settle.

## Working agreements

- Answers come from the manuals; if the manuals do not say, escalate rather than guess.
- Every outbound email waits for approval until the team lead says otherwise.
