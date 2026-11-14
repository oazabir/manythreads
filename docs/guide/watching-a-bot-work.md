# Watching a bot work

When you ask a bot for something in a thread, you can see what it is doing while it works, stop it if you need to, and see the whole request as one list of things to do.
This page explains the two cards you will meet: the **run card** (one bot, one piece of work) and the **to-do card** (the whole request).
You need no technical knowledge. A **bot** is a team member that is a program. A **run** is one stretch of work a bot does to answer you.

## The run card

When a bot starts work in a thread, a card appears at the bottom of the thread, where its answer will land. It stays small and does not make the thread scroll.

What you read on it, from top to bottom:

- **The top line:** the bot's picture and name, a word for how it is doing, and how long it has been going. The words are **Starting…**, **Working**, **Waiting for you**
  (the bot has asked you something), **Waiting for Omar** (it has asked someone else), and **Stopping…**.
- **What it is doing now:** one line in plain words, for example "Reading ThreadPanel.tsx", "Editing 2 files", "Running a command", "Searching the code",
  "Reading the web", "Asking Code reviewer" or "Thinking". When a helper is doing the work it reads "Helper: reading the tests". A **helper** is a smaller worker the bot
  started for one part of the job. The line changes at most once a second, so it is calm to watch.
- **The plan** (only when the bot has one): "Plan 3 of 5 · Write the test". Press it to see the whole plan with what is done. This is the bot's own plan for its piece of work.
- **The work counts:** for example "14 steps · 2 files changed (+48 −6) · 1 helper". A **step** is one small thing the bot did, such as reading a file or running a command.
  Press it to see the steps one by one.
- **The answer as it comes:** once the bot starts writing its answer, the last two lines show faintly under the card.

You will never see the bot's private reasoning, the output of a command, a file's content or a long file path. If you want more detail, open the steps.

### How much to show

Pointing at the card shows a small button with three choices. Your choice is kept in your browser.

- **Summary:** only the top line and the line of what it is doing now. For when you only want to know that work is moving.
- **Progress:** the default. The top line, what it is doing now, the plan line and the work counts.
- **Trace:** the same, with every step open, for people who like to see everything.

### Stopping a bot

Press **Stop** on the top line to end a run. It says **Stopping…** while the bot finishes the step it is on, then the card says, for example, "Stopped by Omar after 2 min".
Whatever the bot had already written stays as its answer.

You see **Stop** only if you may use it: the person who asked the bot, the person who started the thread, the team's leads and the workspace's admins.
In a private conversation with a bot, only you can stop it.

### When a bot asks you something

Sometimes a bot needs a yes or no before it goes on (for example, before a risky command). The card says **Waiting for you** and shows the question with **Yes** and **No** (for a command: the command itself, with **Allow once** and **Deny**).
The same question also shows in the Approvals list; answering in either place clears both. If the question is for someone else, the card says "Waiting for" and their name,
and you cannot answer it.

### When the run is over

The card folds into one quiet line under the bot's answer, for example "Worked 4 min · 14 steps · 2 files changed · 1 helper". Press it to open the steps again; a step that waited for your yes says so on its own line ("Ran pnpm · Allowed").
A run with no steps shows no line.

- **Stopped** runs say who stopped them and after how long.
- **Failed** runs say what went wrong in one sentence and who can fix it. When the bot's runner has to be signed in again, that is a workspace admin's job on the Runners page
  (Settings, Workspace, Runners, **Sign-in**).

### On a phone

The card is as wide as the screen, the work counts wrap, the step list opens in place, and **Stop** and the three-dot button stay in the top line.

## The to-do card

When a request has several steps, a bot that manages the work (the Engineer in an Engineering team is one) writes a list first and keeps it up to date. It appears as one card
in the thread. It changes in place; you are not notified for each change, and no second list is posted.

- **Each item** has a status you can read as a word and an icon: **To do**, **Working on it**, **Done** or **Blocked**. Items that are work cards on the team's board show the bot
  that holds the card ("Coder is on it"), and their words open the card on the board. They tick themselves as the card moves; nobody has to remember to update them.
- **The bar at the top of the thread:** while anything is open and the card itself has scrolled out of sight, the list is pinned as one line, for example
  "Release 2.4 · 3 of 5 · Coder is working on Add the button". Press it to open the list. A long list folds its finished items into one line ("12 done"). When everything is done it says **All done** and the bar goes away; the card stays in the thread.
- **A long list** folds its finished items into one line such as "12 done".
- **You cannot tick items.** The list is the bot's view of the request. To move work yourself, use the team's board.
- **In the channel,** the thread's first message shows a small chip: "Coder is working" or "To do 3 of 5". Press it to open the thread.

### The two lists, side by side

The to-do card is the **whole request**. A run card's plan line is one bot's plan for **one piece** of it. In an Engineering team each work card is done in its own thread, so
the request's thread shows the to-do card and the Engineer's short messages, and the thread of a card shows the run card of the bot working on it.

## If something looks wrong

- **The card says Working for a long time and shows no new steps.** Press **Stop** if you may, and ask again. If it keeps happening, tell a workspace admin.
- **There is no card, only an answer.** The bot's runner may not report its steps. The answer is still the bot's own.
- **A bot says it kept a checklist message instead of a to-do card.** That is the fallback, used only when the to-do list could not be made. It works the same way for reading.

For admins who set up the places bots run: [Agent bridge](../agent-bridge.md) and [Runners](../plugins/bot-runners.md).
