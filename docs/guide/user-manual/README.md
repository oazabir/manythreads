# manythreads user manual

manythreads is a self-hosted place where your team and its bots work together. Each entry shows the screen, how it works and why it helps.
Screenshots: the live workspace on 2026-11-25 (Engineering team, signed in as the owner); internal addresses are masked.

- [Getting started](#getting-started)
- [Talking with people and bots](#talking-with-people-and-bots)
- [Calls, meetings and the schedule](#calls-meetings-and-the-schedule)
- [Working with bots](#working-with-bots)
- [Files](#files)
- [Your account](#your-account)
- [Running the workspace (admins)](#running-the-workspace-admins)
- [On a phone](#on-a-phone)

## Getting started

### Signing in

![Signing in](img/sign-in.jpg)

**How it works.** Open your workspace's address and sign in with your email and password (or the sign-in method your admin turned on). Forgot your password? The link under the button emails you a reset link.

**Why it helps.** One account reaches every team you belong to; nothing to install.

### Finish setting up

![Finish setting up](img/onboarding.jpg)

**How it works.** A new workspace gets a checklist (your sign-in, a look, the organisation, address and HTTPS, models, sign-in methods, teams, servers, runners …). Each step opens in place, says what it needs and shows *done* when it is. The sidebar card "Finish setting up · 10 of 13" brings you back.

**Why it helps.** An admin can get from a fresh install to a working team with bots without reading the deploy docs.

### Teams and templates

![Teams and templates](img/teams.jpg)

**How it works.** Pick the teams you want from templates (Engineering, Customer support, Marketing, Product design, Research, or a blank team). A template brings its channels, its board and a set of ready bots. Rename a team, invite people, and add more teams later from the same page.

**Why it helps.** A team starts with channels and helpers suited to its work, not an empty room.

## Talking with people and bots

### Channels

![Channels](img/channel.jpg)

**How it works.** The left sidebar lists your team's channels (#general, #dev, #releases …), private ones with a lock, and incident channels in their own group. Messages show who wrote them, replies under each message, reactions, and link previews. Mention a person or a bot with `@` to bring them in; a bot answers in a thread under your message.

**Why it helps.** Everyone, people and bots, works in the same place, so the history of a decision stays together.

### Threads

![Threads](img/thread-pane.jpg)

**How it works.** Click *n replies* to open the thread on the right while the channel stays visible. The thread's tools at the top let you follow it, bookmark it, summarise it, open it full size or close it. Replies have their own box at the bottom.

**Why it helps.** Side conversations do not flood the channel, and you never lose your place.

### Writing a message

![Writing a message](img/composer-menu.jpg)

**How it works.** Type in the box at the bottom and press Enter. The *+* menu has *Attach a file* (or drop/paste one), *Take a screenshot*, *Record your screen*, *Ask a poll*, *Emoji* (or type `:` and two letters), *Send later* and *Show formatting*. The microphone records a voice message, which is written out as text.

**Why it helps.** Everything you might want to share is one click from the box; unsent text is kept as a draft.

### Message actions

![Message actions](img/message-menu.jpg)

**How it works.** Hover a message (or long-press on a phone) for reactions, reply and the *More* menu: copy link or text, forward, send to memory, pin to the channel, bookmark the message or its thread, mark for later, remind me, edit and delete your own.

**Why it helps.** Act on a message where you read it instead of copying it somewhere else.

### The Threads view

![The Threads view](img/threads.jpg)

**How it works.** *Threads* in the sidebar collects every thread you follow, with tabs Followed, Unread, Mine and Later. *Needs you first* puts threads waiting on you at the top; *People only* hides bot chatter; *Bookmarked* shows only your bookmarked threads. Filter by words or `@name`.

**Why it helps.** One list answers "what do I still owe someone?" across every channel.

### Direct messages

![Direct messages](img/dms.jpg)

**How it works.** *Messages* lists your one-to-one and small-group conversations. Start one with *New message*. A DM has the same composer, threads and calls as a channel.

**Why it helps.** Quick private questions without creating a channel.

### Bookmarks

![Bookmarks](img/bookmarks.jpg)

**How it works.** Bookmark a thread (the bookmark at the top right of a thread), a message (More → Bookmark) or a file. *Bookmarks* appears in the sidebar once you have one, with tabs Threads, Messages and Files. Clicking one opens it exactly where it is: a reply is scrolled to and highlighted. Only you see your bookmarks.

**Why it helps.** Keep the things you will need again (a decision, a how-to, a spec) one click away. *Later* remains your to-do list; bookmarks are your reference shelf.

### Catch me up (Summarise)

![Catch me up (Summarise)](img/summary.jpg)

**How it works.** Open the channel's name menu and choose *Summarise*, use the thread's Summarise tool, or press *Catch me up* when a channel opens with many unread messages. Pick *Since I last read*, *Last 24 hours* or *Last 7 days*. Brain writes decisions and what is waiting on you, with numbered links to each message. Copy it, save it to your files, or ask again.

**Why it helps.** Come back from a day off and know what happened in minutes. Only you see the summary, Brain reads only messages you may read, and nothing is posted.

### Search

![Search](img/search.jpg)

**How it works.** The search box at the top of the sidebar (Ctrl K) searches the team: messages, threads, files and people. Narrow with filters (who, where, when) and keep a search you repeat as a saved search.

**Why it helps.** Find the message you half remember without scrolling.

### Activity

![Activity](img/activity.jpg)

**How it works.** The bell opens Activity: mentions of you, replies in threads you follow and other news, grouped by day, with Unread and All. *Mark all as read* clears it.

**Why it helps.** One place to see what asked for your attention.

## Calls, meetings and the schedule

### Audio and video calls

![Audio and video calls](img/call-dialog.jpg)

**How it works.** The headphones and camera icons in a channel header start an audio or video call. The dialog sets the title, who to ring (or leave it open to anyone in the channel), a note-taker that writes notes for the team, and *Let people outside the workspace join with a link*. A live call shows as a card in the channel; anyone who may read it can join.

**Why it helps.** Talk it through right where the work is, and the notes land back in the channel's thread.

### Guest links and the waiting room

**How it works.** With guest links on, *Copy guest link* on the call card gives you a link for someone outside the workspace. They open it, type their name, check their microphone and camera and press *Ask to join*. People in the call see "Ana is waiting · Let in · Deny". A guest sees only the call, never the channel, its messages or files; their tile reads "Ana (guest)". Ending the call or *Turn off guest links* stops every link.

**Why it helps.** Bring in a customer or contractor for one call without creating an account for them.

### The meeting assistant

**How it works.** In a live call, *Ask* in the call bar opens a panel: ask "what did we decide about the release?" and Brain answers from what was said so far (only from people who agreed to be transcribed) and from the call's channel, with sources. Someone who joins late presses *Catch me up* for a short summary of what they missed, shown only to them.

**Why it helps.** Nobody has to stop the meeting to repeat what was said.

### Schedule

![Schedule](img/schedule.jpg)

**How it works.** *Schedule* shows a calendar of your teams' appointments by day, week or month; colour shows the team. Click an appointment to see its details, agenda and call link.

**Why it helps.** Everyone sees the same team calendar, next to the channels the meetings are about.

### Appointments and meeting series

![Appointments and meeting series](img/appointment-form.jpg)

**How it works.** *New appointment* sets the title, the team's schedule, the day and time, *Repeats* (every week, every 2 weeks, every month, with an optional last day), a video or audio call, an agenda, and invitees from any team. A repeating appointment becomes a meeting series: each meeting gets an agenda page the team edits together, open action items carry over to the next meeting, and *Stop the series* cancels the meetings still to come.

**Why it helps.** Regular meetings run themselves: the agenda and leftover action items are waiting each week.

## Working with bots

### Chat with Brain

![Chat with Brain](img/chat.jpg)

**How it works.** *Chat* is your private conversation with Brain, the workspace's assistant. It suggests questions to start with, keeps past chats on the left, and lets you pick a fast or a careful model at the top. Brain answers from your team's memory, knowledge and files you may read, with sources.

**Why it helps.** Ask a question in plain words instead of searching five places.

### A bot's answer

![A bot's answer](img/bot-chat.jpg)

**How it works.** Each answer has actions under it: copy, share to a channel, save as a page, bookmark, and a thumbs up or down.

**Why it helps.** Turn a good answer into something the team can find again.

### Bots

![Bots](img/bots.jpg)

**How it works.** *Bots* lists the team's bots: what each does, which model it runs on, whether it is active, and *Talk* to start a conversation. Add a bot, browse recipes, or see the agents that run them.

**Why it helps.** Each bot has one clear job (Coder, Code reviewer, Deployer, Note-taker …) and you can see them all at a glance.

### A bot's page

![A bot's page](img/bot-page.jpg)

**How it works.** A bot's page opens a chat with it, plus its workshop (what it is working on). It suggests questions that match its job.

**Why it helps.** Hand a bot a task the same way you would message a colleague.

### Bot settings

![Bot settings](img/bot-settings.jpg)

**How it works.** Tabs *Basics* (name, role, model, who can see it), *What it can do* (tools and skills), *Safety*, *Where it runs* and *History*. Changes to a team bot go through a proposal that a lead approves.

**Why it helps.** You decide exactly what each bot may touch.

### Bot usage

![Bot usage](img/bot-usage.jpg)

**How it works.** For each bot: runs, tool calls, answers, approvals asked and model spend, with charts per day. Spend is shown to workspace admins only.

**Why it helps.** See which bots earn their keep and what they cost.

### Approvals

![Approvals](img/approvals.jpg)

**How it works.** When a bot wants to do something that needs a person (run a command, publish, spend), it asks. *Approvals* lists what is waiting, with the bot's reason and the exact command. Press *Allow once* or *Deny*; the bot continues or stops. The badge in the sidebar counts what is waiting.

**Why it helps.** Bots move fast on routine work, and a person still decides the risky steps.

### Boards

![Boards](img/boards.jpg)

**How it works.** Boards show the team's work as cards in columns (Open, In progress, Verify, Waiting on a person, Done). Bots move cards as they work; drag cards yourself, open a card for its history and links.

**Why it helps.** See at a glance what people and bots are doing and what is stuck.

### Projects

![Projects](img/projects.jpg)

**How it works.** *Projects* connects the team's git repositories (GitHub, GitLab or your own). A project has a channel, a team folder, and the connector bots use to push branches and open pull requests, with the rules for who may publish.

**Why it helps.** Bots work on real code, with every change going through a pull request a person can review.

### Deliveries

![Deliveries](img/deliveries.jpg)

**How it works.** Every request to the bots in the last 7, 30 or 90 days: task, runs, time, cards done, pull requests, approvals, nudges and spend, each linking to its thread.

**Why it helps.** Know what the bots delivered for each request and what it cost.

### Jobs and routines

![Jobs and routines](img/jobs.jpg)

**How it works.** Jobs are bot work on a schedule: heartbeats, routines (for example a morning check-in or a weekly deploy health check) and cards that open themselves. Enable, pause or run one now. Your personal routines live under Account → Routines.

**Why it helps.** Repeating work happens on time without anyone remembering to ask.

### Recipes

![Recipes](img/recipes.jpg)

**How it works.** Ready-made automations: daily stand-up, weekly team digest, request intake, bug triage, release notes, meeting prep, follow-up chaser, incident timeline, decision log and more. Read what one does and what it needs, then ask for it; a lead approves before anything changes.

**Why it helps.** Add a proven workflow in two clicks instead of designing it.

### Proposals

![Proposals](img/proposals.jpg)

**How it works.** Changes to a bot, the team file, a skill or a routine are proposed first. A team lead or admin sees exactly which lines change and applies or rejects them.

**Why it helps.** Nothing about how bots behave changes without a person reading it.

### Org chart

![Org chart](img/org.jpg)

**How it works.** Who leads the team, who is on it, and which bots each bot may hand work to.

**Why it helps.** Understand the team, people and bots, in one picture.

### Knowledge

![Knowledge](img/knowledge.jpg)

**How it works.** The documents a team's bots can search: uploaded files, the team folder and web addresses read on a schedule. Each source shows when it was last read; personal and team tabs keep them apart.

**Why it helps.** Bots answer from your own documents, not from guesses.

### Memory

![Memory](img/memory.jpg)

**How it works.** What the team's bots remember: concepts, an inbox of notes to review, and what is shared with other teams. You can open a note to see where it came from. *Send to memory* on any message adds to it.

**Why it helps.** The team's know-how outlives any one conversation.

### Agents and connections

![Agents and connections](img/agents.jpg)

**How it works.** The agents that run this team's bots (for example the Hermes gateway and Claude/Codex runners) and their connections, with their state.

**Why it helps.** Admins can see where bots actually run and whether they are healthy.

### Drafts

![Drafts](img/drafts.jpg)

**How it works.** What you typed and did not send is kept here, per conversation.

**Why it helps.** Never lose a half-written message.

## Files

### Team files

![Team files](img/files.jpg)

**How it works.** *Files* holds the team's folder (pages, meetings, memory, channels, bots, jobs …) and attachments, with filters for images, documents, code, from bots and from people. Upload, make a new page or folder, preview, and see who changed what.

**Why it helps.** One shared folder where people and bots keep the team's documents.

### Your personal space

![Your personal space](img/personal-files.jpg)

**How it works.** Your own folder (action items, inbox, knowledge, meetings, memory, notes, routines) that only you, and the bots you allow, can read.

**Why it helps.** A private place for your notes and work in progress.

## Your account

### Profile

![Profile](img/account-profile.jpg)

**How it works.** Your name and picture as others see them.

**Why it helps.** People and bots know who they are talking to.

### Appearance

![Appearance](img/account-appearance.jpg)

**How it works.** Pick a look (Graphite, Linen, Harbor, Classic), light, dark or the system setting, and comfortable or compact message spacing.

**Why it helps.** Make the app easy on your eyes.

### Notifications

![Notifications](img/account-notifications.jpg)

**How it works.** Choose what can interrupt you (mentions, replies, direct messages, channels, keywords), push notifications in this browser, and an email of what you missed when you have been away.

**Why it helps.** Hear about what matters and nothing else.

### Action items

![Action items](img/account-action-items.jpg)

**How it works.** Your own action items, from meetings and from you. Add one with a due date; a routine can keep the list up to date every weekday morning.

**Why it helps.** Commitments from meetings do not get lost.

## Running the workspace (admins)

### General

![General](img/ws-general.jpg)

**How it works.** The workspace name, who may create an account, password sign-in, and whether voice messages are kept as text.

**Why it helps.** Basic rules for the whole workspace in one place.

### Members

![Members](img/ws-members.jpg)

**How it works.** Everyone in the workspace with their role, tags and last activity. Invite people and change roles.

**Why it helps.** Keep the right people in, and out.

### Team settings

![Team settings](img/team-settings.jpg)

**How it works.** A team's people and their roles, the team template's channels and board, and the team's bots.

**Why it helps.** Each team lead runs their own team.

### Models (LLM)

![Models (LLM)](img/ws-llm.jpg)

**How it works.** The model providers the workspace may call (for example Anthropic and a speech-to-text service), their keys, and limits. Every call goes through the workspace's gateway.

**Why it helps.** Choose your models and keep keys in one guarded place.

### Runners

![Runners](img/ws-runners.jpg)

**How it works.** Where bot runs happen: the workspace default, shared Claude Code and Codex pods, and your own servers. Each shows its state, sign-in and which teams may use it; *Test* checks it.

**Why it helps.** Run bots on hardware and accounts you control.

### Brain

![Brain](img/ws-brain.jpg)

**How it works.** Who may ask Brain, which model it uses, and what it may read in each place (a team channel, a private conversation, a routine).

**Why it helps.** Brain is useful without reading more than it should.

### Data protection

![Data protection](img/ws-guardrails.jpg)

**How it works.** What happens when a bot is about to send a password, key or personal data: block, warn or allow, per kind of secret.

**Why it helps.** Secrets and personal data do not leak through a bot.

### Audit

![Audit](img/ws-audit.jpg)

**How it works.** Who did what, when and to what, filterable by person, outcome and team, with export.

**Why it helps.** A record for security reviews and "who changed this?".

### Usage

![Usage](img/ws-usage.jpg)

**How it works.** Bot runs, tool calls, answers, approvals and model spend across the workspace, with the monthly budget.

**Why it helps.** Keep costs predictable.

### System health

![System health](img/ws-health.jpg)

**How it works.** Checks of the server: waiting jobs, pending approvals, outbox, disk, budget and database connections, each with its limit.

**Why it helps.** Spot trouble before people notice it.

### Import

![Import](img/ws-import.jpg)

**How it works.** Bring the history of Slack or Mattermost: channels, messages, threads and reactions, into a team. A dry run shows what will happen first.

**Why it helps.** Move over without losing years of conversations.

### Connected apps

![Connected apps](img/ws-connections.jpg)

**How it works.** Which outside apps people and teams have connected, how often they were used, and sign-in problems.

**Why it helps.** See and control what reaches outside the workspace.

## On a phone

### Channels on a phone

![Channels on a phone](img/phone-channel.jpg)

**How it works.** On a phone the app becomes one column with a bottom bar: Home, Messages, Activity, Search and You. The menu at the top left opens the sidebar.

**Why it helps.** Everything works from your pocket; no separate app to install.

### Threads on a phone

![Threads on a phone](img/phone-threads.jpg)

**How it works.** The Threads view keeps its tabs and filters, sized for a thumb.

**Why it helps.** Answer what needs you while away from your desk.

### Schedule on a phone

![Schedule on a phone](img/phone-schedule.jpg)

**How it works.** The schedule shows one day at a time, with New appointment at the top.

**Why it helps.** Check today's meetings at a glance.
