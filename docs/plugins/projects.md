# projects

The **projects** plugin lets a team say which git repositories it works on. A *project* is one repository (an https address), a branch, and
optionally one of the team's channels. This page is for a team lead who wants bots to know what code a channel is about, and for an operator who
wants the team's agent pod to hold a copy. You need a team, a channel to tie the project to (optional), and, for the copy on the pod, the
`hermes-pods` plugin with the address allowed in the chart.

## What it does

- **Bots are told.** When a message in a project's channel wakes a bot, the run's prompt gets one extra block:
  `This channel is project <name>: repository <address>, branch <branch>. On the team's Hermes pod its repository of record is /workspace/repos/<name>.git and your clone is ~/<name>.`
  Bots on the Claude Code or Codex bridge get the same text.
- **The pod keeps a copy.** The `hermes-pods` plugin adds every project of a team to the pod's list of repositories of record (see
  [hermes-pods](hermes-pods.md)), so each bot gets its own clone. It does this only for addresses that start with a prefix in the chart value
  `hermesPods.repoOriginAllow` (for example `https://github.com/oazabir/`). A project on another address is saved and shown, but not copied.
  Changes reach the pod within about thirty seconds. Removing a project does not delete the copy on the pod.
- **The channel shows it.** A channel tied to a project shows `Project: <name>` beside its title.

## GitHub, GitLab and a team's own GitLab

A project is on one **provider**: `github` or `gitlab`. `https://github.com/…` is GitHub and `https://gitlab.com/…` is GitLab, decided by the address.
Any other host (GitHub Enterprise, or a GitLab the team runs itself) needs a lead to choose the provider when adding the project (`provider` in the
request, the provider choice on the Projects page); without it the request is refused with a 400. The host must also start with a prefix in the chart value
`hermesPods.repoOriginAllow` before the pod copies it or publishes to it. A GitHub address is `<host>/<owner>/<repo>`; a GitLab address may sit inside
nested groups (`<host>/<group>/<subgroup>/<project>`, 2 to 20 segments). GitLab is reached at `https://<host>/api/v4` with the token as `PRIVATE-TOKEN`.
Changing the provider of a project drops its token (set it again for the new provider).

**The bot account.** For each project the lead gives the **bot username** and a **token** of that account (GitHub: a fine-grained token with write access to
contents and pull requests; GitLab: a project or personal access token with `api` scope and the Developer role or more on the project). The provider is
asked before anything is kept: the token must belong to that username, must be able to write to the project, and must not be refused; the check also
learns the account's numeric id and the token's expiry. A project can be added without the bot account and have it set later.

**Whose name the commits carry.** The project has a checkbox, `commitAs` (`bot`: the default, or `requester`). The publishing bot makes **one commit
per card** (the card's whole change, squashed from the tested tree). Its **committer** is always the bot account. Its **author** is the bot account
when `commitAs` is `bot`; when it is `requester`, the author is the person who started the card (the writer of the first message of the card's thread,
else the card's creator), with their display name and account email, which become public in the repository's history (the page says so beside the box).
Changing the box takes effect at once, without touching the token; the pod is told too, and the change is refused with a 409 when the pod cannot be
reached. The Committer bot asks `tasks.commit_identity` before it publishes and passes the answer to `mt-publish.sh` (see [tasks](tasks.md)).

## Pull requests: publishing a tested branch

A project can also hold a **GitHub token** so that finished work reaches GitHub for a person to approve. With a token set, the bot that tested a card's
branch pushes that branch to the project's address and opens a **pull request**; a person merges it in GitHub, and that merge is the approval. The card
links the pull request and follows it: merged means done, closed without a merge means it goes back to its owner (see [tasks](tasks.md)). A project
without a token behaves as before: the committer completes the card and nothing leaves the pod.

- **Setting the token.** On the Projects page, a lead or admin enters the GitHub username and pastes a token into the project's "Pull requests" box (or
  calls `PUT /api/teams/:slug/projects/:projectId/push-credential` with `{ "username": "…", "token": "…" }`). Use a fine-grained token limited to that one
  repository, with write access to contents and pull requests. **GitHub is asked before anything is kept** (`GET /user`, then the repository): a token that
  belongs to another account than the username, one that cannot write to the repository and one GitHub refuses are each refused with their own message and
  store nothing. The page then reads "Connected as `<login>` · expires `<date>`" (the date is GitHub's own, and warns 14 days ahead).
  `POST …/push-credential/test` asks GitHub again ("Test connection"); an answer of 401 marks the project `needs_replacing`, and the form comes back.
  Removing the token (`DELETE` on the same path) takes it away at once, with the username and expiry.
- **One token for every project of an owner.** The form has a checkbox "Use for every project of this team that lives under `<owner>`" (`shareWithOwner: true`
  in the request). The token is kept **once per owner** in the Secret (key `_owner.<host>.<owner>`, for example `_owner.github.com.acme`); each project under
  that owner keeps only its address, branch and a pointer to it. GitHub is asked about every other project of the team under that owner too: one the token
  can write to is connected, one it cannot is left out and named in the answer (`alsoConnected`, `notConnected`), and GitHub not answering stops the whole
  save, and more than 25 other projects under the owner is refused (409) rather than cut short. The box covers the projects that exist when you save (a project
  added later needs the box ticked again); a project that already has a token of its own is left as it is and named in the answer (`keptOwn`). Replacing the token from any one of
  them replaces it for all; saving a token without the box, or removing one project's token, leaves the others on the owner's token, and the owner's token goes
  when no project points at it. The project row says `pushCredentialShared`.
- **When GitHub stops accepting the token.** A token can be revoked or expire without anyone telling this server. Two things on the server notice: the
  15-minute job `projects.credential-check` (asks GitHub about the tokens that are in use, a few at a time, once per token however many projects share it;
  it sends a token only to an address on the allow-list) and the pull-request sync in `tasks`. The sync, on a 401, marks the token as refused in the pod
  so every bot stops using it. The job turns a mark into "needs replacing" only after asking GitHub itself (`GET /user`): if GitHub accepts the token
  after all, the mark is cleared and the projects stay good. A 401 the job sees itself marks the pod and turns the project (and every project on the same
  owner token) to `needs_replacing`; the Projects page reads "Token needs replacing" and the form comes back. Only a 401 counts: any other odd answer
  (404, 410, 5xx) changes nothing. Nothing asks GitHub again until a new token is saved. The pod's publish command (`mt-publish.sh`) never writes the
  mark (it cannot); it only returns exit code 7 when the token is marked refused or the push or the API answers "bad credentials". A bot learns of it
  from the `check` command (exit 7) or from the `token_refused` answer of `tasks.pull_request`; the Committer then tells the lead once in the project's
  channel or thread and does not ask for the token. (The server itself does not post the message: a background job has no author to post as, so the
  bot that met the refusal does.)
- **Where the token lives.** Only in a Kubernetes Secret in the team's pod namespace (`hermes-<team>-push`, one entry per project). The database
  records only that a token is set and when (`push_credential_set_at`); no route, event, log line or error ever carries the token, and the page cannot
  show it again. Inside the pod, the Secret is readable by the root user only, and the pod's reconcile loop hands each token to the `repo` Unix user
  alone. Bots run as their own users, so a bot cannot read it; it can only ask the `repo` user to publish through `mt-publish.sh` (see
  [hermes-pods](hermes-pods.md)).
- **It is for one address.** The Secret holds the token together with the repository address it was issued for, and the pod's publish command and
  the server's pull-request sync refuse a token whose address is not the project's. Changing a project's address drops its token (set it again for the
  new address), removing a project removes it, and both are refused (nothing changes) when the pod cannot be reached to remove the token. A new project
  clears any token left under its name. The database row is written before the Secret, so a failed request leaves no token behind.
- **Which addresses.** Publishing works for an address of the form `https://<host>/<owner>/<repo>` that starts with a prefix in the chart value
  `hermesPods.repoOriginAllow`; `github.com` uses `api.github.com`, any other host is taken to be GitHub Enterprise (`https://<host>/api/v3`).
  Anything else is refused with a 400 when you set the token.
- **Needs the managed pods.** The token has nowhere to live unless the server runs the team pods (`hermesPods` on); otherwise the route answers 409.

## The page

`/t/<team>/projects` lists the team's projects; the **Projects** section of the sidebar lists them too (with a GitHub or GitLab tag, each one a link to
`/t/<team>/projects/<id>`, which opens the page on that project) and refreshes when a project is added, changed or removed. Everyone on the team can read it. A team lead or a workspace admin can
add a project (name, repository address, branch, channel), change the address, branch or channel, set or remove its bot account and token, choose whose name its commits carry, and remove it. The name cannot be changed, because it is
also the folder name on the pod; remove the project and add it again to rename it.

## Rules

- The name is lowercase letters, digits, `.`, `_` or `-`, up to 61 characters, and must not contain `..`. It is unique within the team.
- The address must be `https://`, with no user name or password, no query and no `#` fragment. (A private repository therefore needs another way to
  authenticate on the pod; this plugin stores no credentials in its database. The one token it handles, for publishing, goes straight to the pod's Secret.)
- The branch is a plain branch name (letters, digits, `.`, `_`, `-`, `/`). The default is `main`.
- The channel must be an ordinary channel of the same team, and a channel can belong to at most one project. Archiving or deleting the channel
  leaves the project in place with no channel.

## API

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/teams/:slug/projects` | team members | the team's projects, by name |
| `POST /api/teams/:slug/projects` | lead or admin | add one: `name`, `repoUrl`, optional `defaultBranch`, `channelId`, `provider` (`github` or `gitlab`; required for a host other than github.com and gitlab.com), `commitAs` (`bot` or `requester`, default `bot`) |
| `PATCH /api/teams/:slug/projects/:projectId` | lead or admin | change `repoUrl`, `defaultBranch`, `channelId` (send `null` to clear the channel), `provider` (drops the token) or `commitAs` |
| `DELETE /api/teams/:slug/projects/:projectId` | lead or admin | remove it (and its token) |
| `PUT /api/teams/:slug/projects/:projectId/push-credential` | lead or admin | set or replace the GitHub or GitLab token (`{ "username", "token", "shareWithOwner"? }`, token 20 to 255 characters of letters, digits, `_`, `-`, `.`); answers the project and the names of the other projects it also connected (`alsoConnected`) or could not (`notConnected`), never the token |
| `DELETE /api/teams/:slug/projects/:projectId/push-credential` | lead or admin | remove the token |

Errors: 403 for someone who may not (or cannot see the team), 404 for an unknown project, 409 for a name already used or a channel that already has a
project (or a pod that could not store the token), 400 for a channel that is not a channel of the team, a token of the wrong shape or an address that cannot
be published to.

## Data and events

Table `app.projects` (with `provider`, `commit_as`, `push_credential_set_at` and the bot's numeric id `push_user_id`, never the token; team-scoped; row-level security lets team members read and team leads and workspace admins write). Each change writes an
event: `project.project.created`, `project.project.updated` or `project.project.deleted`, with the project's id, team, name and, except on delete,
address, branch and channel.

## Dependencies

Depends on `teams` and `channels`. The token itself is kept through the `project.credentials` provider that `hermes-pods` registers. `runtime-hermes` (the prompt note) and `hermes-pods` (the copy on the pod) read the table and depend on this plugin.
