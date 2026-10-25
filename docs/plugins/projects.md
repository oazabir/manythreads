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

## The page

`/t/<team>/projects` (linked from the Agents page) lists the team's projects. Everyone on the team can read it. A team lead or a workspace admin can
add a project (name, repository address, branch, channel), change the address, branch or channel, and remove it. The name cannot be changed, because it is
also the folder name on the pod; remove the project and add it again to rename it.

## Rules

- The name is lowercase letters, digits, `.`, `_` or `-`, up to 61 characters, and must not contain `..`. It is unique within the team.
- The address must be `https://`, with no user name or password, no query and no `#` fragment. (A private repository therefore needs another way to
  authenticate on the pod; this plugin stores no credentials.)
- The branch is a plain branch name (letters, digits, `.`, `_`, `-`, `/`). The default is `main`.
- The channel must be an ordinary channel of the same team, and a channel can belong to at most one project. Archiving or deleting the channel
  leaves the project in place with no channel.

## API

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/teams/:slug/projects` | team members | the team's projects, by name |
| `POST /api/teams/:slug/projects` | lead or admin | add one: `name`, `repoUrl`, optional `defaultBranch`, optional `channelId` |
| `PATCH /api/teams/:slug/projects/:projectId` | lead or admin | change `repoUrl`, `defaultBranch` or `channelId` (send `null` to clear the channel) |
| `DELETE /api/teams/:slug/projects/:projectId` | lead or admin | remove it |

Errors: 403 for someone who may not (or cannot see the team), 404 for an unknown project, 409 for a name already used or a channel that already has a
project, 400 for a channel that is not a channel of the team.

## Data and events

Table `app.projects` (team-scoped; row-level security lets team members read and team leads and workspace admins write). Each change writes an
event: `project.project.created`, `project.project.updated` or `project.project.deleted`, with the project's id, team, name and, except on delete,
address, branch and channel.

## Dependencies

Depends on `teams` and `channels`. `runtime-hermes` (the prompt note) and `hermes-pods` (the copy on the pod) read the table and depend on this plugin.
