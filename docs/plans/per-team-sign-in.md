# One sign-in for all teams, or one per team (P35-10)

Owner, 2026-11-24: "entertain both options in the runner setup. Either it will be a shared Claude/Codex sign-in or it would be per team Claude/Codex sign-in."

Today a Claude Code or Codex runner has **one** sign-in. Every team the runner serves uses it: the pod runners (`claude_cli`, `codex_cli`) keep it in one `state`
volume that every team pod mounts, and an enrolled server keeps it in `<root>/auth/claude` (read by every team user) and `<root>/auth/codex` (copied into a
team's Codex home for each run, P31-01). With full access a team holds a working copy of that one sign-in (R1 in `codex-teams-and-oom.md`); the owner accepted
that on 2026-11-20. This row adds the second choice.

Words: *shared* = one sign-in for every team of the runner (today); *per team* = each team of the runner signs in with an account of its own; *scope* = which
of the two a runner uses.

## 1. What a person sees
- **Runner setup** (the Runners page, a Claude Code or Codex runner on a pod or a server): a choice under the sign-in, *One sign-in for all teams* (default,
  today's behaviour) or *Each team signs in*. A bridge on one machine (`hermes_gateway` with a bridge agent) serves no teams of its own and keeps one sign-in;
  the choice is not offered there.
- **Each team signs in:** the sign-in section lists the runner's teams, each with its state (signed in, signed out, signing in) and *Sign in* / *Sign out*,
  the same dialog as today (device code, pasted code or API key) for that team. A team that is not signed in has no working runner: its bots' runs end at once with
  "Team <name> has not signed in to <Claude/Codex> on runner <name> yet. An admin can sign it in on the Runners page." The runner row says how many of its teams
  are signed in ("2 of 3 teams signed in").
- **Changing the choice** is a confirm dialog that says what happens: to *Each team signs in*, the shared sign-in is signed out and removed, and every team must
  sign in before its bots work again; to *One sign-in for all teams*, every team's own sign-in is signed out and removed, and the runner needs one sign-in.
  Runs under way are stopped.
- The warning on the Runners page that teams sharing a server share its sign-in (P35-10's interim note) shows only for a shared runner with more than one team.

Who: a workspace admin, as for every runner sign-in today (the routes stay admin-only). A team lead signing in their own team is a possible follow-up, not here.

## 2. Data and API
- `bot-runners` migration: `app.bot_runners.sign_in_scope text not null default 'shared' check (sign_in_scope in ('shared','per_team'))`. Only a runner of a
  pod kind or `server_agent` with agent `claude-code`/`codex` may be `per_team` (a check in the route; the column stays plain).
- `PUT /api/admin/bot-runners/:id/sign-in-scope {scope}` (admin): writes the column, audits `bot_runner.sign_in_scope.changed`, then applies it (section 3/4).
  If applying fails, the column is put back and the route answers with the plain sentence.
- The agent-auth routes (`GET/POST …/agent-auth`, login, answer, cancel, logout) take an optional `team` (slug). A `per_team` runner requires it and refuses an
  unknown team or a team the runner does not serve; a `shared` runner refuses it. The audit event gains an optional `team`.
- `GET /api/admin/bot-runners/:id/agent-auth/teams`: one state per served team (the page's list), each from the same check as the single state.
- The runner list carries `signInScope` and, for a `per_team` runner, `teamsSignedIn`/`teamsServed`.
- Runs: the dispatcher already knows the run's team. A `per_team` runner's run carries the scope to the place that runs it (below); a team with no sign-in is
  refused by the runner, never retried as shared.

## 3. Pods (`claude-pods`)
A runner is one pod per team; what makes the sign-in shared is the one `state` claim (`<runnerBase>-state`) every team pod mounts.
- **Per team:** each team pod mounts a claim of its own, `<base>-state` (the team's `base` name already exists). The keeper and the uploaded sign-in Secret are
  not used (a per-team runner signs in only through the Runners page; an upload is refused with a sentence).
- **Sign-in:** `pods.bridge({ runnerName, agent, team })` answers the team's own pod; `checkSignin` takes the team too. The pod's bridge is unchanged: its one
  sign-in is the team's.
- **Changing the scope:** to per team, delete the shared claim and the credentials Secret (as `removeCredentials` does) and let the controller make the team
  claims; to shared, delete every team claim. Pods restart (the controller already restarts a pod whose volumes change).
- A runner's readiness per team: the controller's sign-in check is asked per team pod; the runner is `ready` when at least one served team is signed in, and
  the dispatcher refuses a run for a team that is not.

## 4. Enrolled servers (agent bridge with team users)
The shared copy stays as it is. Per team, each team's sign-in lives in folders **owned by the team's own user**, inside its home: `<root>/work/<team>/.signin/claude`
and `<root>/work/<team>/.signin/codex` (0700). The team owns its own account, so there is nothing to copy in or write back, and no other team's user can reach it
(team homes are 0700 to their own user, P26-22).
- **The header rule** (`parseHeader`): `CLAUDE_CONFIG_DIR` may be the machine's `auth/claude` (shared) or the team's own `.signin/claude`; `CODEX_HOME` may be
  the team's Codex home (shared, copy-in as today) or the team's own `.signin/codex`. When `CODEX_HOME` is `.signin/codex`, the helper does **no** copy-in,
  write-back or removal of `auth.json` (it is the team's own); `clean-codex` never touches `.signin`.
- **Sign-in runs as the team user.** The bridge's `AuthManager` takes a target with an optional team. With a team, every program it starts (the probe and the
  device-code adapter, the pasted-code and API-key programs, sign-out) is started through the helper as that team user, with the team's `.signin` folder as the
  tool's home: the adapters through `TeamRun.start` (kind `claude`/`codex`, as runs are), the terminal programs (`claude`/`codex` CLI with a pty) through two new
  helper kinds `claude-cli`/`codex-cli` that start the configured CLI binary and nothing else (fixed program from the helper's table, header from the first
  line, same environment rules). Attempts are keyed by agent and team.
- **Runs:** the run request gains `signIn: 'per_team'`; `serverProfile` then sets `CLAUDE_CONFIG_DIR`/`CODEX_HOME` to the team's `.signin` folder. Before the
  run the bridge asks the probe (cached) and refuses at once with the sentence of section 1 when the team is signed out.
- **Changing the scope:** to per team, the bridge signs out the shared sign-in (today's logout, which also removes every team's Codex copy); to shared, it asks
  the helper for a new start-nothing kind `clean-signin` per team, which removes the team's `.signin` folder as the team user. The platform calls a new bridge
  route `POST /v1/signin/scope {scope, teams}` through the tunnel.
- **Without team users** (a server enrolled with one user) per team is refused: one user can read every folder, so "a team's own sign-in" would not be its own.

## 5. Order of work
1. **P35-10a** data, routes, scope dialog and per-team list on the Runners page, pods (section 3), and a run refused for a signed-out team. Tests: route
   (scope, team param, refusals), render (per-team claim), reconcile (scope change), web unit (the list's words); e2e on the stand-in pod runner.
2. **P35-10b** enrolled servers (section 4): helper kinds and header rule (unit tests as the helper is tested today, no root), `AuthManager` with a team,
   bridge route, run refusal; the container test of the helper; then live on the devbox (`devbox-claude`/`devbox-codex`, Engineering only) only after the
   owner says so, because switching signs the Engineering bots out.

## 6. Risks
- R1 Switching the live runners signs the Engineering bots out until each team signs in: never switched on the live site without the owner.
- R2 A full-access team on a per-team runner holds **its own** sign-in, as it would on its own machine; the shared sign-in's R1 does not apply.
- R3 Claude's transcripts: per team they live in the team's `.signin/claude`, so teams no longer read each other's transcripts (an improvement over shared).
- R4 Codex in a per-team pod renews its own tokens in its own volume; no keeper is needed, the same as a Runners-page sign-in today.
- R5 Pty through `sudo` and the helper: the header line goes on the pty before the program starts; the helper must read it with the terminal in raw mode or the
  echo shows it (no secret is in it, but the page must not show it). Measured in the container test before 10b ships.

## 7. Review (2026-11-24) — changes to the plan above before building
An independent read against the code found these; the plan is amended by them.
- **Sign-in state per team is stored, not probed.** Readiness and dispatch are per runner today (`resolveRunner` on `effectiveStatus`, `followSignIn`/`followPodSignIn`,
  `refreshServerSignIns` with no team). A new table `app.bot_runner_team_signins (runner_id, team_id, state, checked_at)` is written by the pod controller pass, the
  page's reads and the server refresh, and read by `resolveRunner` for a `per_team` runner; `teamsSignedIn` and the per-team list read it (no 70 s probes in a route).
- **Pods:** the per-team claim is named `<base>-signin` (never `<base>-state`, which can equal another runner's `<runnerBase>-state`), labelled with the team **id**;
  reconcile must apply, pin, move (`planNode`, `finishMove`), check (`foreignObject`) and delete those claims like the shared one; the keeper and the uploaded Secret
  are ignored by the controller for a `per_team` runner. A team signs in only once it has a pod, i.e. a bot on the runner (or the first-team placeholder pod).
  Switching scope also clears the shell homes and bridge sessions on the shared volume (say so in the confirm dialog).
- **Switching signs out for real first** (through each team pod's bridge, or as the team user through the helper), then deletes; deleting alone would leave a copy a
  full-access team may already hold valid. Leaving the runner, a team deleted, or the runner deleted also signs that team out; a claim or folder whose team id does
  not match is refused (slug reuse).
- **Servers:** the terminal sign-ins run as the team user by the helper itself (fixed kinds `claude-login`, `claude-logout`, `codex-login`, `codex-logout`,
  `codex-key`: the helper starts `script` as the team user, the header stays on the pipe), so no header goes onto a pty; the API-key kind takes the key on the
  pipe, never in the environment allowlist. `.signin` is made like `SH_PRIVATE_DIR` (0700, no setgid) because team homes may be 2750; the bridge never `mkdir`s
  inside a team home. `parseHeader` refuses `.signin` in `files`/`removeAtEnd`, and in per-team mode stops accepting `auth/claude` (emptied on the switch). The
  scope is kept by the bridge (set by `/v1/signin/scope`, read by `serverProfile`, whose cache is cleared on a switch), not sent per run. The sign-in gate becomes
  per folder. The tunnel hello says whether the server has team users, so the site refuses per team on a one-user server.
- **Honest limit:** per team protects teams from each other, not from the bridge user or root on that machine.
- The kind/agent rule for `per_team` is a database check (MISTAKES: rules in routes drift).
