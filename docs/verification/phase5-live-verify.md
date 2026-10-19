# Phase 5 live verification - persona journeys

**Site:** https://manythreads.kahf.to  
**Run at:** 2026-10-19T13:57:10.488Z  
**Steps:** 44 passed of 44  
**Script:** `e2e/screens/task.persona-journeys.shots.ts` (run on the devbox by `tools/devbox/personas-shots.sh`)  
**Images:** `temp/screenshots/personas/<persona>/`  

Every persona signs in through the real form on the live site and walks the surfaces built for them, desktop (1440x900) and phone (390x844). The journeys are read-only: nothing is posted, created or approved, so no live side effect survives the run. The negatives are part of the journey - each persona meets a place they may not open, and the denial is what the step proves.

## Summary

| Persona | Journey | Steps | Result |
|---|---|---|---|
| lena | the guest: one channel, nothing else | 4 | pass |
| nadia | the engineer: channels, threads, the coder, memory and files; phone width | 9 | pass |
| omar | the workspace owner: models, teams, bots and the audit | 6 | pass |
| priya | the new joiner: reading, following and asking, with no write controls; phone width | 7 | pass |
| rafi | the on-call approver: approvals, incidents and the runbook | 5 | pass |
| sameera | the support agent: the support channels, the responder and the knowledge | 6 | pass |
| tariq | the marketing lead: content, campaigns, files and the drafter | 7 | pass |

## Screenshots by persona

### lena

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | releases | #releases: the only channel she was added to | [view](../../temp/screenshots/personas/lena/01-releases.png) |
| 2 | dev-denied | #dev is closed to her | [view](../../temp/screenshots/personas/lena/02-dev-denied.png) |
| 3 | bots-denied | the bots page is closed to her | [view](../../temp/screenshots/personas/lena/03-bots-denied.png) |
| 4 | files-denied | Files is closed to her | [view](../../temp/screenshots/personas/lena/04-files-denied.png) |

### nadia

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | channel-phone | the channel at 390 px | [view](../../temp/screenshots/personas/nadia/01-channel-phone.png) |
| 2 | memory-phone | the memory screen at 390 px | [view](../../temp/screenshots/personas/nadia/02-memory-phone.png) |
| 3 | channel | #dev: the channel she works in | [view](../../temp/screenshots/personas/nadia/01-channel.png) |
| 4 | threads | her Threads inbox | [view](../../temp/screenshots/personas/nadia/02-threads.png) |
| 5 | coder-chat | her conversation with Coder | [view](../../temp/screenshots/personas/nadia/03-coder-chat.png) |
| 6 | brain-chat | her conversation with Brain | [view](../../temp/screenshots/personas/nadia/04-brain-chat.png) |
| 7 | memory | the team's memory: concepts, trust tiers and provenance | [view](../../temp/screenshots/personas/nadia/05-memory.png) |
| 8 | files | Files: the team's repository, `memory/` among it | [view](../../temp/screenshots/personas/nadia/06-files.png) |
| 9 | leads-denied | a private channel she is not in is closed to her | [view](../../temp/screenshots/personas/nadia/07-leads-denied.png) |

### omar

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | llm | Workspace -> LLM: providers, aliases and budgets | [view](../../temp/screenshots/personas/omar/01-llm.png) |
| 2 | teams | the teams of the workspace | [view](../../temp/screenshots/personas/omar/02-teams.png) |
| 3 | bots | the Engineering bot roster | [view](../../temp/screenshots/personas/omar/03-bots.png) |
| 4 | bot-page | one bot's page (its Audit tab is the audit trail) | [view](../../temp/screenshots/personas/omar/04-bot-page.png) |
| 5 | approvals | the approvals inbox the owner also clears | [view](../../temp/screenshots/personas/omar/05-approvals.png) |
| 6 | members | workspace members and their roles | [view](../../temp/screenshots/personas/omar/06-members.png) |

### priya

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | channel-phone | the channel at 390 px | [view](../../temp/screenshots/personas/priya/01-channel-phone.png) |
| 2 | memory-phone | the memory screen at 390 px | [view](../../temp/screenshots/personas/priya/02-memory-phone.png) |
| 3 | home | her first screen | [view](../../temp/screenshots/personas/priya/01-home.png) |
| 4 | channel | #general: the channel she is a member of | [view](../../temp/screenshots/personas/priya/02-channel.png) |
| 5 | threads | the Threads inbox | [view](../../temp/screenshots/personas/priya/03-threads.png) |
| 6 | memory | the team's memory, which she may read | [view](../../temp/screenshots/personas/priya/04-memory.png) |
| 7 | approvals-read-only | the approvals inbox is readable, but nothing there is hers to decide | [view](../../temp/screenshots/personas/priya/05-approvals-read-only.png) |

### rafi

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | approvals | the approvals inbox he clears | [view](../../temp/screenshots/personas/rafi/01-approvals.png) |
| 2 | incidents | #incidents: the alerts he follows | [view](../../temp/screenshots/personas/rafi/02-incidents.png) |
| 3 | alerts | #alerts | [view](../../temp/screenshots/personas/rafi/03-alerts.png) |
| 4 | brain-chat | he asks Brain for the runbook | [view](../../temp/screenshots/personas/rafi/04-brain-chat.png) |
| 5 | support-denied | Support's channels are not his | [view](../../temp/screenshots/personas/rafi/05-support-denied.png) |

### sameera

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | support | #support: where her work happens | [view](../../temp/screenshots/personas/sameera/01-support.png) |
| 2 | enquiries | #enquiries | [view](../../temp/screenshots/personas/sameera/02-enquiries.png) |
| 3 | escalations | #escalations | [view](../../temp/screenshots/personas/sameera/03-escalations.png) |
| 4 | kb-updates | #kb-updates | [view](../../temp/screenshots/personas/sameera/04-kb-updates.png) |
| 5 | responder-chat | her conversation with the Support responder | [view](../../temp/screenshots/personas/sameera/05-responder-chat.png) |
| 6 | engineering-denied | Engineering is invisible to her | [view](../../temp/screenshots/personas/sameera/06-engineering-denied.png) |

### tariq

| # | Step | What it shows | Screenshot |
|---|---|---|---|
| 1 | content | #content: where the posts are drafted | [view](../../temp/screenshots/personas/tariq/01-content.png) |
| 2 | campaigns | #campaigns | [view](../../temp/screenshots/personas/tariq/02-campaigns.png) |
| 3 | analytics | #analytics | [view](../../temp/screenshots/personas/tariq/03-analytics.png) |
| 4 | brand | #brand | [view](../../temp/screenshots/personas/tariq/04-brand.png) |
| 5 | files | Marketing's files | [view](../../temp/screenshots/personas/tariq/05-files.png) |
| 6 | drafter-chat | his conversation with the Content drafter | [view](../../temp/screenshots/personas/tariq/06-drafter-chat.png) |
| 7 | support-denied | Support's mail is not his | [view](../../temp/screenshots/personas/tariq/07-support-denied.png) |

## Gallery

The full set is in one gallery: `temp/screenshots/index.html` (open it in Chrome).

## What each persona proved

- **Omar** (workspace owner and admin) - the Workspace -> LLM page, the teams, the Engineering bot roster, one bot's page, the approvals inbox and the workspace members. He is the one who sees every team.
- **Nadia** (engineer, release owner) - #dev, her Threads inbox, her conversations with Coder and with Brain, the team's memory screen, the team's Files, and a channel she is not in that is closed to her. The first two steps are the same screens at 390 px.
- **Rafi** (on-call approver) - the approvals inbox he clears, #incidents, #alerts, his Brain conversation for the runbook, and Support's channels that are not his.
- **Sameera** (support agent) - #support, #enquiries, #escalations, #kb-updates, her conversation with the Support responder, and Engineering, which is invisible to her.
- **Tariq** (marketing lead) - #content, #campaigns, #analytics, #brand, Marketing's files, his conversation with the Content drafter, and Support, which is not his.
- **Priya** (new joiner) - her first screen, #general, the Threads inbox, the team's memory, and the approvals inbox she may read but in which nothing is hers to decide (no Approve and no Deny control is offered to her). The first two steps are the same screens at 390 px.
- **Lena** (guest) - #releases, the only channel she was added to; #dev, the bots page and Files are all closed to her.

## Deployment under test

| | |
|---|---|
| Site | https://manythreads.kahf.to/ (HTTP 200, `/readyz` ready) |
| Helm revision | 40 |
| Migrations | 74 |
| Image | `517a9ba53c84-7cb7a16d` |
| Server pod | `manythreads-server-7cc8c5c589-k5vsw` (Running) |
| Web pod | `manythreads-web-6b86996fd4-d7swn` (Running) |

## Notes

- The demo deployment had no bots loaded for Customer support and Marketing: their repositories were seeded directly, so the bots plugin never saw the commit that loads a bot. `tools/devbox/push-template-bots.sh` commits the shipped template definitions as the workspace admin, which is what made the Support responder, the Content drafter and both teams' Brain real for this run.
- Every persona's password was set to a one-off value for the run and rotated to an unknown value afterwards; no secret is in any picture.