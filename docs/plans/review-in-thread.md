# P35-02 · Review the bot's change in the thread

PLAN.md row: the card and the thread show the pull request's diff (files, hunks, renamed and binary files named), the CI checks and their state, the
tested commit and the test-site link; Approve and Request changes (with a comment that goes back to the bot as its next instruction, on the same
card) without leaving for GitHub or GitLab; merge only at the tested head (P6-04's rule).

## What there is today (2026-11-23)
- A card waits on a person once the Committer records its pull request (`tasks.pull_request`, `verifyPullRequest` in
  `packages/plugins/tasks/src/pull-requests.ts`). The columns `pull_request_number/project/origin/head_ref/head_sha/base_ref/state` are on `app.tasks`
  (migrations 0010, 0017); `pull_request_head_sha` is the published commit, which holds the tested work.
- `syncPullRequests` (every 3 minutes) only notices a merge made on the provider: a merge at any other commit than the recorded head finishes nothing
  (`divergence`, P6-04). Nothing in manythreads reads a diff or checks, reviews or merges.
- Provider reads: `getPull` (`github.ts`), `getMergeRequest` (`gitlab.ts`) with a timeout, `redirect: 'error'`, backoff, a 401 marks the token refused,
  no response text in errors. The token is read only by server code (`project.credentials`).
- Hand-off: `app.tasks_handoff` (0012) lets the card's owner or a lead of the team hand it over; the note becomes the bot's next instruction and the
  thread gets a hand-off row. While the PR waits, the owner is the Committer; leaving `waiting_on_person` marks the PR `withdrawn` (0010), and the
  Committer may record the same PR number again after the fix.
- Web: the card panel shows the PR as a link (`screens/boards/CardPanel.tsx`); diffs are drawn elsewhere with `parseUnifiedDiff` and the `.diff` classes.
- The test-site link exists only in the Deployer's hand-off note.

## Decisions (proposed defaults; the owner may change them)
- **Who:** anyone who can read the team sees the diff and checks. Approve, Request changes and Merge are for the team's leads (and admins), the same
  `manage` right that may hand any card over today. Widening to members (or a reviewer tag) is a later, small change in one SQL function.
- **Self-review:** allowed. The owner is often the only person on the team; the audit names who decided.
- **Checks:** a failing check disables Merge (with the reason); pending or no checks show a warning and allow it. Merge method: a plain merge (the
  Committer already makes one commit).
- **Test site:** a nullable `test_site_url` (https only) on the card, set by the bot that deployed it (an optional `testSiteUrl` on `tasks.handoff`);
  P35-03 later fills it per card.

## Steps (one commit each, `P35-02: …`)
1. **Diff read.** `listPullFiles` (GitHub `/pulls/:n/files`) and `listMergeRequestDiffs` (GitLab `/merge_requests/:iid/diffs`); 30 files a page; caps
   64 KB of patch per file and 256 KB per page; each file: status (added, deleted, modified, renamed with its old path), binary, truncated. Shared Zod
   type. Route `GET /api/teams/:slug/tasks/:taskId/pull-request/diff?page`. Tests with the GitHub stand-in (`test-utils/fake-github.ts`) and the
   GitLab fake fetch: paging, caps, renamed, binary, 401, no token in errors.
2. **Checks read.** GitHub check runs plus the combined status of the head; GitLab pipelines of the MR at the head. Answer: each check's name, state,
   https link; a summary (passing, failing, pending, none); whether the provider's head is still the recorded head. A 403 says the token cannot read
   checks (the Projects hint names the permission).
3. **Data.** Migration 0020: `test_site_url`; task event types `pull_request_approved`, `pull_request_changes_requested`, `pull_request_merged_here`;
   `app.tasks_review_pull_request(task, verdict, head)` (security definer, lead check, PR open, card waiting on a person, head = recorded head).
   Events `tasks.pull_request.reviewed` / `.merged` (no comment text in events) and audit mappers. `tasks.handoff` takes `testSiteUrl`.
4. **Approve.** Records the approval at the head and submits a provider review (GitHub APPROVE at `commit_id`; a 422 because the bot account opened the
   PR falls back to a COMMENT review "Approved by <name> in manythreads"; GitLab `/approve` with `sha`).
5. **Request changes.** Comment (≤ 1000 characters) as a provider review comment, then `app.tasks_handoff` to the Coder (the last `coder` bot that held
   the card, else the team's `coder`) with the comment as the note, in one transaction; the thread gets the hand-off row; the same card goes round again.
6. **Merge.** Reads the PR again; refuses when its head is not the recorded head or a check fails; merges with `sha` = recorded head (GitHub
   `PUT /pulls/:n/merge`, GitLab `PUT /merge_requests/:iid/merge`); the provider's 405/409 in plain words; the card is resolved at once through the same
   code as the sync (`resolveOne`, split out of `syncPullRequests`).
7. **Card panel.** A Review section: tested commit, test-site link, checks, files with hunks (renamed, binary and truncated named), Approve, Request
   changes (dialog), Merge (disabled with its reason). Patch text drawn as text only. New `pr-` classes in `styles/pull-review.css`, tokens and ProIcons.
   Screenshots at 1440 and 390 px.
8. **Thread.** A compact line in the thread of a card with an open PR: `#24 · 3 files +94 −5 · checks passing · Review`, which opens the card's Review.
9. **Docs and live proof.** `docs/plugins/tasks.md`, Projects token hint; on the live site with a real bot PR: the diff and checks match GitHub,
   Request changes wakes the Coder with the comment and the PR comes back, a moved head refuses Merge, Merge at the head finishes the card.

## Risks
- Project tokens may lack `Checks: read` / `Commit statuses: read`: shown plainly, never an error page.
- GitHub refuses an approval from the PR's author (the bot account): handled by the comment fallback; branch protection that needs a human approval
  will still block the merge (said in plain words).
- A PR's head can lag a push by about 15 s on GitHub: a refusal says "try again in a moment".
- Patch text and comments are untrusted: text only, never in an event or audit row.
