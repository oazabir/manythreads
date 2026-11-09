# Phase 19 retro (runners: Hermes, Claude Code, Codex, model gateway)

Written at the end of Bundle E, package WP-R2 (P19-11: the stand-in commands, seed v19, the docs). The other Phase 19 packages of Bundle E (pod publishing,
the Codex server and bridge half, the chart) are written up by their own authors in `STATUS.md`. This page says what was built and decided, what went well, what
cost time and what is still open. Live results are in `STATUS.md`, not here: nothing in this page claims a screen or a pod was seen on the live site.

## What was built, in the order it landed

1. **The catalog (P19-02, P19-04).** One table of runners owned by the workspace, a short list for teams through one database function, and the admin screen.
2. **Placement (P19-03).** `placement.runs_on` in `BOT.md` names a runner; the loader asks whether the team may use it.
3. **Claude Code pods (P19-05 to P19-07).** One pod per runner, a sign-in file uploaded by an admin and stored byte for byte in the runner's own Secret, a keeper
   container that copies a renewed file back, a gate in the bridge that lets one run go at a time near the expiry, and a pause when the plan's limit is reached.
4. **The machine a pod stands on (P19-08).** A node picker, with a move that deletes a work volume only when an admin confirmed it.
5. **The model gateway runner (P19-10).** A bot that only calls a model alias.
6. **Stand-ins and seed v19 (P19-11).** A stand-in `claude` and a stand-in `codex` in `deploy/images/claude-pod-fake` that print the real tools' JSON lines, call the
   run's MCP address and fail, hit a limit or renew the sign-in file on a word; a test that runs both under the real bridge; the seed that makes five runners and
   a Codex runner with a bot on each; the `runners` stack that starts the Kubernetes stand-in.
7. **Docs.** The permission list, egress, who may do what, the bridge's pod section, how to find a sign-in file, and this page.

## Decisions taken without the owner (reversible)

- The stand-ins are one image for both tools, switched by a word in the prompt or by one file (`/state/fake-mode`), because a pod cannot be given a different prompt per
  check. They run on the stage only, never for a runner made on the live site.
- The stand-in failure texts include `authentication_error` and "usage limit reached" so the bridge's table classifies them. This is a guess at the real wording.
- Seed v19 is opt-in, like seed v21, so no older baseline moves, and it goes through the real routes (a proposal changes each `BOT.md`) so a bug in a route shows in the seed.
- The made-up sign-in file starts its access token with `fake-` and carries one canary string; a test looks for the canary in every table of the catalog, the audit
  rows, the events and the log, and finds it only in the Secret.
- Docs say "public 443 until measured" for egress. A narrower list that is wrong would stop every run, so the wide rule stays until the hosts are measured.

## What went well

- **Real bridge, fake tool.** Running the stand-ins under the real bridge found one real defect (below) that a test of the table alone had not.
- **A hazard made visible.** The Codex stand-in takes 500 ms to renew, so two processes started together meet `refresh_token_reused`. The test shows the gate prevents
  it and shows what happens without the gate.
- **No home folder read.** Both stand-ins and the seed are checked by a test that fails if their source names the operator's own Claude or Codex folder, and every
  bridge test runs with a made-up config folder.
- **Disjoint files.** Four other packages ran in the same tree. Two small edits in files that belong to others (the stack server hook and the deploy script's copy line)
  were additive and are named in the commit.

## What cost time

- **A table that says case-insensitive and is not.** `FAILURE_PATTERNS` documents "matched case-insensitively", but its patterns carry no `i` flag. The stand-in's
  first wording ("Invalid authentication credentials") was never classified until it was changed to include `authentication_error`. The real tool's text may differ in
  case from the guess. The comment or the patterns should change; this package did not touch the file (it belongs to the Codex bridge package).
- **Self-checks that matched their own comments.** The "no home folder" regular expressions matched the literal path written in a comment and the `$HOME` inside the
  expression. The comments were reworded and the expression narrowed. A grep check must be run against the file it guards.
- **A harness without the gate gave no reason field.** Tests of a refused sign-in need the config folder set, or the bridge has no gate and the failed run carries no
  `reason`. The test helper now sets it.
- **Export lists.** The seed was finished and its test failed only because the package index did not export two names.
- **Killing by pattern.** A `pkill -f` matched the command that ran it. Harmless here; kill by process id.

## Still open (owner-blocked; none of it was run on the live site, as decided in E12)

1. **No real sign-in has been used.** The measurement task P19-01 needs a second Claude login made for the test; the owner's working login must not be copied, because a
   renewal in the pod can sign the source machine out. The same holds for Codex.
2. **k3s Secrets encryption is off.** An uploaded file would sit as base64 in the datastore. Turning it on restarts the k3s server, which is a production change.
3. **The egress host list is not measured** (P19-01 (d)), so the pod's policy is the wide public 443.
4. **The real failure texts are not measured** (refused sign-in, plan limit, renewal), for either tool. The table `FAILURE_PATTERNS` is one line per text to change.
5. **The macOS sign-in file location is not measured** (P19-01 (e)). The guide says so and sends the admin to a Linux or Windows machine.
6. **The added permissions are not accepted.** The list is in [claude-pods](../plugins/claude-pods.md#every-permission-the-runners-add): the controller creating keeper
   Roles, the nodes ClusterRole, and `delete` on claims in the pods namespace.
7. **The live checks are not run.** The plan (E12) makes them a checklist the owner runs, or allows a session to run, once items 1 to 4 are settled; the runbook page for it is not written yet.
8. **The Codex pod objects** follow the plan (`codex-<runner>`, Secret key `auth.json`, `CODEX_HOME=/state/codex`) and are drawn by the pod package; the Codex driver is
   not tested against a real Codex install.

## Mistakes added to MISTAKES.md

Lines for the lead to add (this package does not edit that file): a pattern table that claims case-insensitive without the flag; a self-check regular expression that
matches the comment that explains it; a stub of a seed that is finished but not exported.
