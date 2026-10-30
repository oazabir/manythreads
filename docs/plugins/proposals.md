# proposals

A change to `bots/`, `TEAM.md`, `skills/` or `routines/` is a proposal first (PLAN P7-01). A proposal is one file's new text (or its removal) that waits until a team lead or a workspace admin looks at the lines that change and applies them. Nothing in those four places is committed any other way: the repo writer refuses a direct commit or restore from anybody, a lead and admin included, and a bot can only ever propose.

Package: `packages/plugins/proposals`. Manifest: `dependsOn: ['teams', 'bots', 'repo-git']`, capability `proposals.propose`, emits `proposals.proposal.created`, `.applied` and `.rejected`. Migration `proposals/0001_proposals.sql`. Schemas: `packages/shared/src/entities/proposal.ts`, `packages/shared/src/api/proposals`, events in `packages/shared/src/events/proposals.proposal.*.ts` (schema-compat snapshots are committed).

**Why a plugin of its own.** Plugins cannot import each other. The rule is the writer's (repo-git), the BOT.md check is the bots plugin's parser (which lives in `@manythreads/shared`), and the table, the routes and the events are new. Putting them in repo-git would make the git writer know about teams' review rules; putting them in bots would leave `skills/`, `routines/` and `TEAM.md` without a home. A small plugin that owns the table and calls the repo provider is the narrowest place.

## Routes

| Route | Who | What |
|---|---|---|
| `POST /api/teams/:slug/proposals` | a team member who can post, or a bot of the team | Makes a proposal: `{ path, op?, content?, baseBlobSha?, title?, note?, applyNow? }`. `201 { proposal: ProposalDetail }`. A change that changes nothing, a path outside the four places, a file over 256 KB, and a 51st open proposal of one author in a team are refused. |
| `GET /api/teams/:slug/proposals` | anyone who can read the team | The list, open ones first, with `openCount`. Filters: `status`, `path`, `limit`. |
| `GET /api/teams/:slug/proposals/:id` | same | One proposal with its diff, checks, whether the file moved since (`stale`, `staleReason`), and what **this** person may do (`canApply`, `cannotApplyReason`, `canReject`, `canWithdraw`). The proposed text is never returned; the diff is. |
| `POST .../:id/approve` | a lead of the team or a workspace admin (see below) | Applies it: one commit **as the person who applies it**, the author of the proposal as co-author, message `<title>` + `Proposal <id>`. |
| `POST .../:id/reject` | the same people, not the author | Declines it with an optional note. Nothing is committed. |
| `POST .../:id/withdraw` | the author | Takes it back. |

`baseBlobSha` is the blob the author edited (`null`: the file is new). Left out, the proposal is based on the file as it is now (what a bot does). Apply refuses when the file moved since: `409`, with the reason shown ("`bots/coder/BOT.md` changed after this was proposed ...").

## Who may apply

The approver needs what a direct commit used to require: lead of the team or workspace admin (owner or admin role). **Adding or removing a bot** (a `bots/` path that is new or deleted) needs a workspace admin (the owner rule of STATUS 2026-10-04 is kept). The repo writer checks the same rules again on the apply commit, so the proposals plugin cannot widen them.

**Self-approval (decision).** An author cannot apply a proposal they *saved for review* unless nobody else could: when no other active, non-guest lead of the team or workspace admin exists (admins only, for a bot being added or removed), the only eligible approver may apply their own. The explicit one-step "Propose and apply" (`applyNow: true`) lets a lead or admin apply their own proposal at once; it is recorded `selfApplied = true` and shown as "proposed and applied in one step". That keeps daily use quick and still leaves a proposal on record. The rule is one function in the database (`app.proposals_why_not`) used by the view and by the decision, so the buttons and the refusal cannot disagree.

A bot never applies, and cannot ask to (`applyNow` from a bot is refused). The MCP tool `proposals.propose` (capability `proposals.propose`, granted in BOT.md `capabilities.native`) files a proposal as the bot.

## Checks

Every proposal carries `checks` (name, ok, message). For `bots/<slug>/BOT.md` the check **"BOT.md loads"** runs the strict BOT.md parser the bots loader uses, plus the folder name rule. A failed check is stored with the loader's own error text, shown on the proposal, and **cannot be applied**; the checks run again on apply. Other files have no check yet.

## Data and access

`app.proposals` has RLS (`rls: team`): everyone who can read the team reads its proposals; insert, update and delete are for the system role only. Every write goes through a definer function (`proposals_create`, `proposals_decide`) and the rule is `proposals_why_not`; `proposals_other_approvers` counts the others (a bare number, no names). Checks and the status change are one transaction with the commit: a failed apply leaves the proposal open.

## Screens

- **Proposals** (`/t/:team/proposals`, `/t/:team/proposals/:id`): the list (waiting first) and one proposal with the diff, the checks, Apply, Decline and Withdraw. Reached from the Bots roster and the bot page.
- **Bot page**: the footer has **Save as proposal** and, for a lead or admin, **Propose and apply**. A member reads the definition and proposes from Files.
- **Files**: the four places are read-only for everyone ("Change by proposal"); **Propose a change** (file menu, the note, History) opens the dialog with the whole file, the lines that change, and the same two buttons; **Propose a file** adds a new file in such a folder; History offers **Propose this version** in place of Restore.

## Not yet

- Nobody is notified when a proposal waits (the Proposals link on the Bots roster shows the count).
- The bot templates do not grant `proposals.propose`; add it to a bot's `capabilities.native`.
- One proposal changes one file.

**Who listens to `proposals.proposal.applied`.** The bots plugin: an applied change to `bots/<slug>/BOT.md` or to a file in `bots/<slug>/evals/` starts a free run of that bot's scenario set at the new commit, and a score below the BOT.md's `minScore` is flagged on the bot's Evals tab ([bots.md](./bots.md#evals-p7-08)).
