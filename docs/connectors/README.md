# Connectors

One page for each outside service manythreads can connect to. Each page says the same things in the same order, so you can compare two of them quickly:

1. What it does for a person, a bot or a channel.
2. How to set it up at the provider (what an admin does there).
3. The scopes or services it asks for, and why.
4. The tools a bot gets.
5. The triggers (what starts a bot run).
6. What is copied or kept in step (sync).
7. Limits that are good to know.
8. **Proved against the stand-in only**: what has never run against the real service.

The design is in [docs/plugins/connections.md](../plugins/connections.md) (sign-in, tools, admin, offboarding), with the chat apps in [bridges](../plugins/bridges.md), planned rooms in [meetings](../plugins/meetings.md), documents in [knowledge](../plugins/knowledge.md) and incoming calls from work apps in [webhooks](../plugins/webhooks.md). The list the screens show is one file, `packages/shared/src/connectors/catalog.ts`.

## The 18 connectors

| Connector | Shelf | Signs in with | Page |
|---|---|---|---|
| Google (Drive, Gmail, Calendar) | Files, Mail, Calendar | each person, OAuth | [google.md](google.md) |
| Microsoft 365 (OneDrive, Outlook, Calendar, SharePoint) | Files, Mail, Calendar | each person, OAuth | [microsoft.md](microsoft.md) |
| Notion | Files | each person, OAuth | [notion.md](notion.md) |
| Jira | Tickets | each person, OAuth | [jira.md](jira.md) |
| Linear | Tickets | each person, OAuth | [linear.md](linear.md) |
| GitHub Issues | Code | each person, OAuth | [githubissues.md](githubissues.md) |
| Asana | Tickets | each person, OAuth | [asana.md](asana.md) |
| Zendesk | Tickets | each person, OAuth | [zendesk.md](zendesk.md) |
| Intercom | Tickets | each person, OAuth | [intercom.md](intercom.md) |
| HubSpot | CRM | each person, OAuth | [hubspot.md](hubspot.md) |
| Salesforce | CRM | each person, OAuth | [salesforce.md](salesforce.md) |
| Confluence | Files | each person, OAuth | [confluence.md](confluence.md) |
| Dropbox | Files | each person, OAuth | [dropbox.md](dropbox.md) |
| Box | Files | each person, OAuth | [box.md](box.md) |
| Telegram | Chat | the admin, a bot token | [telegram.md](telegram.md) |
| WhatsApp | Chat | the admin, a Business account | [whatsapp.md](whatsapp.md) |
| Slack | Chat | the admin, a Slack app | [slack.md](slack.md) |
| Microsoft Teams | Chat | the admin, an Azure bot | [teams.md](teams.md) |

Planned but not built: Freshdesk (it signs in with a personal API key, not a consent page), and the finance and design shelves.

## Rules that hold for all of them

- **A sign-in belongs to one person.** Row-level security shows it to nobody else, not a lead and not an admin. A bot uses it only for a run that this person asked, in a conversation or a mention. A schedule or a webhook never borrows it.
- **Reads by default, writes after approval.** Every tool that changes something outside waits for a person to approve, whatever the BOT.md says. No tool deletes anything.
- **Outside text is data.** What a provider returns was written by other people. Tool descriptions say so, answers are cut to a size cap, HTML becomes text, and every id is checked before it goes into an address.
- **Secrets are sealed.** Tokens and signing secrets go through the secret service. No route reads one back, and no log or error holds one.
- **Documents reach a team base only if everyone on the team can already open them.** The rest are counted and never stored.
- **Admins see counts, never content.** Health shows calls, failures, states and days. It never shows an account address, a token or what a call said.
- **When a person leaves, their sign-ins stop at once** and the providers are asked to forget them (see offboarding in the connections page).

## How each one was tested

Everything here ran against stand-ins from `tools/fake-saas` (one process, real HTTP, a control port, made-up secrets, refuses to start in production). No real account of any provider has been used. Each page ends with the list of things only a real account can show. When you connect a real one for the first time, that list is your checklist.

Rate limits: the platform does not keep a per-provider budget. What exists is the answer cap and the timeouts on the one outbound door, a 429 from a chat service is retried after its `Retry-After` (up to 3 tries), Linear's rate-limit answer is turned into "slow down", and a bot is capped at 30 webhook runs an hour. A per-provider budget is a later decision.
