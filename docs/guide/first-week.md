# Your team's first week

This guide is for a team lead who has just got a running manythreads (see [Install manythreads for your team](../deploy/self-host.md)).
It covers only what is built and live. Each part says where to click, what you should see, and what is not built yet.
Plain words are used on purpose. A **bot** is a team member that is a program. **Brain** is the built-in assistant bot.

## Day 1. Finish the setup

1. Sign in as the workspace owner. The left sidebar shows a card, "Finish setting up", with a count such as "3 of 9" and a line "Next: ...".
   Only workspace admins see it. Press the link after "Next:" to open the setup wizard.
2. Work down the steps: sign-in methods (add Google or Microsoft sign-in, or confirm that passwords are what you want), models (your provider key
   under Settings, Workspace, LLM, then the `smart` and `fast` aliases), teams, bots and your first goal. Domain and HTTPS, code and servers are optional rows.
   Each has a "We do not need this" button.
3. A step is ticked only when the fact is true. For example, the models step is done only after a real test call to your provider works.
   If a test fails, the page names the cause in plain words.
4. When all is done the card reads "Setup is done". Press "Put it away" to remove it. The card can only be put away after a launch.

The first goal is ticked when your question is sent to Brain. Brain answers only when a bot runtime and a model work
([self-host.md](../deploy/self-host.md), steps 8 and 9).

Not built yet: the optional steps for code, domain and servers are rows with a link. They are not full guided flows.

## Day 1. Create your team from a template

1. Open the gear icon at the foot of the sidebar, then "Teams". This is the page "Which teams do you want?". (Admins can also use Settings, then "＋ New team".)
2. Pick a template card: Engineering, Customer support, Marketing, Product design, Research, or "Blank team".
   A blank team has one channel and no bots, so not even Brain. The setup wizard needs Brain on a team, so start with a template.
3. Rename the team if you like. In the "Invite" box you can type emails, separated by commas, to invite people as members. Press "Create 1 team".

You should see the team in the sidebar. Without mail, the page shows each invitation link. Send it yourself. The Engineering template gives you the channels #general, #dev, #releases, #incidents,
#alerts and #standup, an "Engineering board" (columns Open, In progress, Verify, Waiting on a person, Done) and a set of bots: Brain,
Engineer, Plan reviewer, Coder, Code reviewer, Tester, Committer, Deployer, Web smoke tester, Standup relay and Alert triage.
The other templates have Brain and, where defined, one or two more bots. Details: [templates.md](../templates.md).

Good to know:

- A team made earlier does not receive later fixes to a template. The team has its own copy.
- A team lead or a workspace admin adds a channel with "+ New channel" under the channel list in the sidebar: a name, an optional topic, and whether everyone on the team or only the people they add can see it. A plain member does not see that button. Channels also come from the template. (Settings, the team, "Channels" is a read-only list.)

## Day 1. Add people

Open the gear icon, then "Teams", then the team's name. This is its roster. Admins press "Add person" to put someone who is already in the workspace on the team.
Leads and admins press "Invite", type an email, pick "Member" or "Team lead" and press "Send invitation". The page shows the invitation link
and the mail carries it too. Invitations wait under "Pending invitations". The invited person opens the link, which shows
"Join <workspace>", and presses "Accept invitation". A new person then gets a second mail with a link to set a password. That needs a working SMTP relay
([self-host.md](../deploy/self-host.md)). Without one, an admin sets the password: `admin set-password` in self-host.md, step 7.

## Day 2. Channels, threads and direct messages

- **Channels** are listed in the sidebar under their group. Open one and write in the composer. The toolbar formats text and has an emoji picker.
- **Threads.** Hover a message and choose "Reply in thread". The sidebar item "Threads" lists the threads you follow, with unread counts.
- **Direct messages.** Press "+ New" next to "Direct messages". The dialog "New message" says "Find a person". Pick one, then "Message" or "Start conversation".
- **Slash commands.** Type `/` at the start of a message and pick from the menu with the arrow keys and Enter. `/ask coder <question>` mentions a bot so it answers in the channel, `/task <title>` makes a card on the team's board and links to it, `/me`, `/shrug` and `/help` do what they say (`/help` lists them). Anything else that starts with a slash is posted as you typed it, and `//ask` posts a literal `/ask`. A guest who is allowed to write in a channel is shown `/ask` and `/task` disabled, with the reason. There is no `/remind` yet, and bots cannot add commands of their own.
- **Quick switcher.** Press Ctrl+K (Cmd+K on a Mac). The dialog "Jump to…" finds channels, people, bots, files, pages, boards and cards. Press `?` to see the other keys.

A member's Threads home shows a "Welcome" card with three first moves: join #general, follow a thread, ask Brain.

Not built yet: custom emoji, a confirmation before an `@here` or `@channel`, drafts saved on the server (a draft stays in the browser it was typed in), Ctrl+Z after a toolbar edit,
the email digest, and a tidy channel title on a 390 px phone. "Save for later" and reminders are planned and not built.
Do not disturb has its own screen (details: [presence.md](../plugins/presence.md)). Open the gear at the foot of the sidebar: "Pause notifications…" pauses for 30 minutes, 1 hour, until tomorrow morning, until you
turn it off, or until a time you pick; "Set status…" sets an emoji and words that clear after a time you choose. The bell shows a small moon while you are paused, and its popover says "Paused until …" with
"Resume now". Notifications that arrive while you are paused wait and are delivered together when it ends. "Do not disturb settings" (Account → Status and Do not disturb) adds a weekly schedule of
quiet hours per weekday, your time zone and your working hours. Not built yet: out-of-office, and status or active/away dots beside names.

## Day 2. Bots and BOT.md

A bot's definition is one file, `BOT.md`, in the team's repository. Open the sidebar item "Bots" and pick a bot. The bot page has these tabs:
Identity, Behaviour, Triggers, Capabilities, Knowledge, Memory, Model, Guard, Approvals, Handover, Placement & limits, Contract, Evals and Audit.

- Only a team lead or a workspace admin edits a bot. Only a workspace admin adds or removes a bot. Others can read every tab.
- When you save, you press "Save as proposal". A lead or admin can press "Propose and apply" to do both at once. A proposal is a change that waits for someone to apply it.
  The list is under Bots, "Proposals". Buttons: "Apply", "Decline", "Withdraw". Details: [proposals.md](../plugins/proposals.md), [bots.md](../plugins/bots.md).
- A bot answers only when it has a runtime and a model. See [self-host.md](../deploy/self-host.md), steps 8 and 9.

Not built yet: a notification when a proposal is made (look at the list), the bot page's "Test" action, Rehearse in the Workshop, and the bot templates do not grant `proposals.propose` by default.

## Day 3. Give a bot a Knowledge base

1. Open a bot, then the Knowledge tab. Type a name (lowercase letters, digits, dashes) in "Knowledge base slug" and press "Add base".
2. The base says it does not exist yet. Press "Create it", then "Upload a file". Markdown, text, CSV and PDF files work, up to 10 MB each (an administrator can change the limit).
   Only a team lead or admin does this. The state line reads "Empty: add a document to start" until the first file is in.
3. Each file gets a status: "Searchable" or "Could not be read". The line then reads "Ready: every document can be searched".
4. Type a question in "Try a question" and press "Search". You get passages with their source.
5. Save the bot with "Save as proposal" (or "Propose and apply") so the base is in its BOT.md. A bot with no list can search every base of its team.
6. To make the bot answer only from a base, turn on "Answer only from this base" and save.
   This stops the bot's answer tool when the search found nothing. It does not stop a plain-text reply. See [knowledge.md](../plugins/knowledge.md).

If a source file changes, an old citation says "source changed". Press "Read again" to refresh a document, or "Remove" to delete it.

Not built yet: search by meaning (it matches words only) and Google Drive sources.

## Day 3. Evals: check that a bot still behaves

An eval is a short list of questions with what a good answer must contain. Open a bot, then Evals.

- "Run evals" checks the bot's rules without calling a model. "Run with the model" sends the bot's instructions to its model alias.
- You see "Eval N of M passed · minimum X". Evals also run when a proposal that changes `BOT.md` or its eval file is applied, and nightly.
- Only a lead or admin runs them.

Not built yet: a notification to the lead when an eval fails, and a check on pull requests (GitHub App). "Run with the model" was not tested against a healthy model.
Details: [bots.md](../plugins/bots.md), section "Evals".

## Day 4. Connect your code

A project tells a team's bots which Git repository a channel is about. Open the setup wizard step "Code" and press "Open Projects"
(or go to `/t/<team>/projects`). A team lead or admin presses "Add project" and fills in Name, "Repository address" (an `https://` address) and Branch.
To let bots send finished work to GitHub as pull requests, enter a GitHub username and token in the project's "Pull requests" box. Details, and what the team's agent pod needs: [projects.md](../plugins/projects.md).

Not built yet: the GitHub App connection.

## Day 4. Approvals

When a bot wants to do something that needs a person (a guarded tool, for example), the request lands in the sidebar item "Approvals".
Tabs: "Waiting" and "Decided". Press "Approve" or "Deny". The sidebar item shows a count of what waits. Details: [approvals.md](../plugins/approvals.md).

## Day 4. Send CI results to a channel

Open a channel and press "Webhooks" in the header (team leads and admins see it). Press "Make webhook", copy the address (it is shown once) and use it in your CI.
Press "Send test message" to check. Full steps and a GitHub Actions example: [ci-to-channel.md](../deploy/ci-to-channel.md).
Adapters exist for plain JSON, Slack-shaped, GitHub, GitLab, Alertmanager and Sentry messages.

Not built yet: a Slack-style `chat.postMessage` API, outgoing webhooks, and a confirm step before "New address".

## Day 5. Audit and data protection (workspace admin)

- **Audit.** Settings, Workspace, Audit. Filter the events and press "Clear filters" to reset. The Export button gives a signed file; check it with the commands in [audit.md](../plugins/audit.md).
  The log holds who did what and when, not message text.
  Not built yet: access for team leads (admins only), and chat message events are not in the log.
- **Data protection.** Settings, Workspace, Data protection. Choose what happens when a bot is about to send something sensitive. Add up to 20 patterns of your own
  and test them in "Try it". The preset itself (standard, strict-egress, air-gapped, customer-facing) is under Settings, Workspace, LLM, Guard.
  The last section lists the hosts each team's bots may reach. That host list is stored, but no real bot traffic is checked against it yet.
  Details: [guardrails-dlp.md](../plugins/guardrails-dlp.md), [guardrails-egress.md](../plugins/guardrails-egress.md).

## What is not ready yet

These are planned in `PLAN.md` and are not built. Do not rely on them.

- Voice rooms, voice messages and video calls.
- Mobile apps.
- Importing a Slack workspace.
- A GitHub App, and an evals check on pull requests.
- The bot page's "Test" action and Rehearse in the Workshop.
- "Save for later" and reminders, and `/remind` and the other slash commands beyond the five that exist (`/ask`, `/task`, `/me`, `/shrug`, `/help`).
- Email as a bot channel, an inbox, and sharing.
- Automations written in plain words, and connectors beyond the ones listed above.
- Search by meaning in Knowledge bases.
- A self-host Docker Compose file. The only supported install is Helm on k3s.

The live list with the exact "left" notes per feature is `STATUS.md`.
