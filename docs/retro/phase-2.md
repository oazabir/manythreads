# Phase 2 retro · Identity, workspace and teams (gate verification)

Branch `claude/inspiring-turing-dzp82p`. Verified 2026-10-01 against PLAN.md Phase 2 and section 6.

## 1. What was built

| Area | Where |
|---|---|
| Identity schema (`workspaces`, `people`, `person_emails`, `workspace_members`, `auth_providers`, `identities`, `secrets`) with RLS and mappers | `kernel/migrations/0004_identity.sql`, `shared/src/entities`, `kernel/src/db/mappers` |
| Envelope-encrypted secrets, `Kms` interface with the Postgres-key implementation, never returned by any API | `kernel/src/kms`, `app.put_secret` / `app.delete_secret` |
| Sessions, session cache (UNLOGGED), invitations, email verification, SMTP mailer (mailpit in dev) | `0005_sessions.sql`, `0008_session_tokens.sql`, `kernel/src/mail`, `server/src/session` |
| Password sign-in, bootstrap by one-time URL, reset, verification, change password, break-glass | `plugins/identity-password` ([docs](../plugins/identity-password.md)) |
| OIDC: Google, Microsoft, any-OIDC (discovery, code + PKCE, state, nonce, SSRF guard) | `plugins/identity-oidc` ([docs](../plugins/identity-oidc.md)) |
| Teams, `team_members`, role tags, `acl_entries`, `app.can()`, `stub_resources` (test migration), last-owner guard | `0006_teams_acl.sql`, `0009_last_owner_guard.sql`, `plugins/teams` ([docs](../plugins/teams.md)) |
| Team templates as data (five, each with Brain), apply is idempotent, `TEAM.md` held in `team_pending_files` | `templates/`, `kernel/src/templates` |
| Web: router, session bootstrap, typed API client, sign-in, bootstrap, invite, workspace and sign-in settings, teams, roster, roles, account | `clients/web` |
| Seed v2, persona auth fixtures, fake OIDC issuer (in-process and container) | `e2e/fixtures`, `packages/test-utils`, `tools/mock-oidc` |

Added by this gate: `0010_person_emails_verified_unique.sql`, `kernel/src/kms/rewrap.ts` (KMS re-wrap job), `docs/plugins/identity-password.md`,
`e2e/teams/roles.spec.ts`, `e2e/mobile/identity.spec.ts`, and the break-glass enforcement rework in section 4.

## 2. Reflect and refactor (P2-00)

The three prompts of PLAN Phase 2 section 0, and what happened:

- **`withActor` system form.** Answered yes: `withSystem(fn, { workspaceId })` is a workspace-scoped system actor on the real `manythreads_system` login role.
  Sign-in, bootstrap and session code use it, so no code needs a person to exist.
- **RLS harness reads a table comment.** Every table carries `COMMENT ON TABLE ... IS 'rls: <kind> — ...'`; `kernel/test/rls/harness.test.ts` fails on a table with RLS
  and no comment, an unknown kind, or a stray `global`. Phase 3 tables need no hand edits to the harness, only the comment.
- **`createPersonas`.** `packages/test-utils` makes the workspace, three teams and all seven personas in one idempotent call (`kernel/test/personas.test.ts`);
  `world.ts` helpers (`createWorld`, `as`, `system`) build on it for RLS, plugin and event tests.
- Carried from phase 1: the pnpm cyclic-dependency warning is unchanged; the dev-header actor is now test-only (`NODE_ENV=test`) and real sessions are the only auth.

## 3. Criteria to tests

### Acceptance criteria
| # | Proof |
|---|---|
| 1 Bootstrap URL once, 410 on reuse | `identity-password/test/identity.test.ts` (bootstrap: unknown token 410, reuse GET and POST 410, token stored hashed); `e2e/identity/bootstrap.spec.ts` (browser: workspace created as Omar, reuse shows the expired page) |
| 2 11 characters refused with the rule; unknown email creates nothing and is not revealed | `identity.test.ts` ("refuses an 11-character password with the rule", "unknown email and a wrong password with the same error, and creates nothing"); `account.test.ts` (change password rule); `e2e/identity/bootstrap.spec.ts` (rule shown as `role=alert`); `e2e/identity/password-signin.spec.ts` (wrong password alert does not say which half) |
| 3 Google `kahf.co` refuses `other.com`; Microsoft refuses another tenant; failed any-OIDC discovery leaves provider disabled with the reason; with OIDC members lose the password form, admins keep it | `e2e/identity/oidc-google.spec.ts`, `oidc-microsoft.spec.ts`, `oidc-any.spec.ts`; `e2e/api/identity/oidc.spec.ts`; `identity-oidc/test/oidc.test.ts`, `rules.test.ts`, `net-guard.test.ts`; password half: `e2e/identity/break-glass.spec.ts` (admin flips the switch in the real settings screen, sign-in page shows only the provider and an admin link, Nadia refused, Omar in) and `identity.test.ts` break-glass |
| 4 Idle session returns 401, client returns to sign-in keeping the return path | `e2e/identity/session.spec.ts` (fake clock, return path kept); `identity.test.ts` (idle 401 and cookie cleared, absolute limit); `server/test/session.test.ts` |
| 5 Applying Engineering: Omar `lead`, template id stored, stored definition lists the six channels, board, bots incl. Brain; twice duplicates nothing | `plugins/teams/test/teams-api.test.ts` ("creates the team with Omar as lead, the stored definition, pending TEAM.md and role tags", "applying twice duplicates nothing"); `e2e/teams/create-from-template.spec.ts`; `kernel/test/templates.test.ts` (five templates, each with Brain) |
| 6 Lena 403 on Engineering stub; Nadia 403 on Marketing, 200 on Engineering; no API returns a secret | `e2e/teams/acl-team-denial.spec.ts`; `e2e/api/identity/rls.spec.ts`; `e2e/api/identity/secret-readback.spec.ts` (every GET, every persona and anonymous, scanner self-test); `kernel/test/rls/identity.test.ts`, `teams.test.ts`, `review-p2.test.ts`; `teams-api.test.ts` |

### Section 4 e2e rows
| Spec | Status |
|---|---|
| `e2e/identity/bootstrap.spec.ts` | present, green |
| `password-signin.spec.ts` | present, green (HttpOnly cookie, `role=alert`, lock after 5) |
| `oidc-google.spec.ts`, `oidc-microsoft.spec.ts`, `oidc-any.spec.ts` | present, green (person created once, refusals, discovery) |
| `break-glass.spec.ts` | present, green; **reworked**: no SQL arrangement, the admin uses the real Sign-in settings toggle and `PATCH /api/workspace` (five tests: refused without SSO, set with SSO and survives a reload, form hidden, member refused, admin in) |
| `session.spec.ts` | present, green |
| `e2e/teams/create-from-template.spec.ts` | present, green |
| `e2e/teams/acl-team-denial.spec.ts` | present, green |
| `e2e/teams/roles.spec.ts` | **was missing, written**: owner promotes and demotes Priya (settings appear and vanish), admin cannot grant or touch owner, last owner cannot be demoted (409), role tag shows on the Roles screen, Nadia gets the 404 page |
| `e2e/api/identity/rls.spec.ts`, `secret-readback.spec.ts` | present, green |

Extra: `e2e/identity/account.spec.ts`, `e2e/api/identity/oidc.spec.ts`, and the new `e2e/mobile/identity.spec.ts` (390x844: sign-in, settings nav as a top select, denial page; it also
fixes `pnpm e2e --project=mobile-web`, which exited 1 with "No tests found" because the project ignores `identity/` and `teams/`).

### Section 5 visual specs
| Spec | Class | Result |
|---|---|---|
| `identity/signin` (1440x900, 390x844) | W | green, own baselines |
| `identity/bootstrap` | W | green |
| `identity/signin-methods` | P-loose (Step 1 · Sign-in methods) | 10.81% differing, limit 12% (tight: the toggle added to the password box moved it; watch it) |
| `teams/teams-create` | P (Step 5 · Teams) | 5.32%, limit 6% (tight) |
| `teams/roster` | P-loose (Team roster) | 6.72%, limit 12% |
| `settings/members` (1440, 390) | W | green |
| `identity/empty-error` (empty teams, expired invite, 403) | W | green |

### Section 6 exit
"All four sign-in routes pass against the mock provider" (password, Google, Microsoft, any-OIDC: `e2e/identity/password-signin`, `oidc-google`, `oidc-microsoft`, `oidc-any`); "the ACL denies Lena, Priya
and Sameera what they must never reach" (`acl-team-denial`, `api/identity/rls`, `kernel/test/rls/teams.test.ts`); "no API returns a secret" (`secret-readback`).

## 4. Break-glass: one source of truth

A report said `passwordForMembers` was stored but not enforced, while `e2e/identity/break-glass.spec.ts` arranged things by SQL. Findings:

- Sign-in **did** read `workspaces.settings.passwordForMembers` (`identity-password/src/accounts.ts`), but a second, hidden switch also existed (the `password` row of
  `auth_providers`, `enabled=false`) that nothing in the product could set. The e2e used both, and the sign-in page hid the password form only from that second switch, so the
  setting an admin could actually change (`PATCH /api/workspace`, General) never hid the form.
- Fixed: `workspaces.settings.passwordForMembers` is the only source. `findCandidates` and `loadMethods` no longer read the `password` provider row (bootstrap still writes it, harmless).
  Off **and** an enabled SSO provider exists: members get 403 "turned off for members" (audited `method_disabled`) and the anonymous `GET /api/session` stops listing `password`, so the sign-in
  screen shows the providers plus the admin link. Owners and admins always may sign in and always see `password` in their own session.
- Safety rails (PLAN: "with OIDC the only method for members"): without an enabled provider the setting never bites, and `PATCH /api/workspace` answers 409 if asked to turn it off with none.
- UI: the Sign-in methods screen has the toggle (the General screen kept its own); both call `PATCH /api/workspace`.
- Tests: `identity.test.ts` (no SSO: member still signs in; SSO on: member refused, methods hide password, admin sees it), `workspace-settings.test.ts` (409), `break-glass.spec.ts` (real UI).
- The sign-in screen already did the PLAN criterion (SSO buttons, "Your workspace uses single sign-on. Admins can still sign in with a password", form behind the link); now driven by the real setting.

## 5. Timings

4 vCPU sandbox, warm store, Postgres 19 in docker, wall clock.

| Command | Wall | Result |
|---|---|---|
| `pnpm lint` | 6 s | ok |
| `pnpm typecheck` | 30 s | ok |
| `pnpm test` | 35 s, 53 files, 810 tests | ok (one run in four had `kernel/test/events/emit.test.ts` fail to load, not reproduced in three reruns: suspect the parallel test-database setup) |
| `pnpm test:rls` | 9 s, 10 files, 124 tests | ok |
| `pnpm test:events` | 8 s, 5 files, 22 tests | ok |
| `pnpm test:schema-compat` | 2 s, 174 tests | ok |
| `pnpm e2e --project=api` | 10 s, 26 tests | ok |
| `pnpm e2e --project=desktop` | 77 s, 47 tests (includes the vt specs; builds the web client) | ok |
| `pnpm e2e --project=mobile-web` | 21 s, 3 tests | ok |
| `pnpm vt` | 38 s, 14 tests | ok |

## 6. Deviations from PLAN

- **`secrets.workspace_id`** (0007): secrets are owned by a workspace; without it an admin of workspace A could link B's secret to a provider. `put_secret` stamps the caller's workspace.
- **`invitations.grant_spec`** (0005): what accepting grants (team, role, later channels) is a JSON spec on the invitation, so a guest invitation made in phase 2 can carry its phase 3 channel grant without a schema change.
- **Event names `workspace.team.*`**: team lifecycle events are `workspace.team.created/renamed/archived/unarchived` (plus `team.member.*`, `team.role.changed`, `team.tag.*`, `team.template.applied`); PLAN says `team.created` etc. The registry is the contract.
- **Test auth vs the admin set-password CLI**: `POST /api/test/session` (needs `MANYTHREADS_TEST_AUTH_TOKEN`, refused in production) serves e2e and local screenshots; the live site has it off, so live screenshots sign in through the real form
  with a password set by `pnpm --filter @manythreads/server admin set-password <email>` (password on stdin only; `docs/testing.md`, `docs/deploy.md`).
- **`MANYTHREADS_TRUST_PROXY=2`** in production: Traefik and the web pod's nginx each append to `X-Forwarded-For`; 1 would make every visitor look like Traefik (one shared lockout) and `true` trusts a client-written leftmost entry. Compose default 0.
- **Capacitor, not React Native** for mobile (owner decision): phase 11 wraps this web app; the phone layout is already tested at 390x844 (`e2e/mobile`, W baselines).
- **Product rename**: the product is manythreads everywhere (packages, env vars, DB roles, docs); an earlier name was removed in `3b5e38d` and the rule is in CLAUDE.md.
- Settings: only `Workspace` (General, Sign-in, Members, Roles) and the team pages shipped; PLAN's `Team: Template, Channels` panes show the stored definition as text.

## 7. Security review findings fixed

- **Schema review (2773304):** admins could rewrite the owner's email/status or attach a verified address to an owner (takeover through reset): owner rows are now owner-only; `secrets` got a workspace;
  FK-like references (person_emails, identities, role_members, invitations) are checked for the same workspace by one definer guard; terminal invitation/session states are system-only.
- **Teams review (35e549e):** a lead could take over foreign role tags, promote a guest through an invitation, and unassign tags outside the team; stale lead invitations now die with their lead.
- **Auth review (a8a2431):** one-hop proxy trust (leftmost XFF was client-writable), parallel guesses count against the lockout, SSRF guard on OIDC discovery/token/JWKS in production, test-auth refused in production,
  `Secure` cookies without a public URL, reset spends sibling links, dead session-token sweep.
- Lessons recorded in `MISTAKES.md`: definer functions see `is_system()` as true (check the caller with `lookup_*`), terminal states are system-only, trust exactly the hops you have.
- Later and also done: last-owner guard (`0009`), `workspace.member.role_changed` audit, password change ends other sessions.

## 8. Follow-ups handled in this gate

- **KMS re-wrap job** (done): `rewrapSecrets(tx, kms)` re-encrypts every secret on an earlier key under a fresh data key bound to the current key id (the AAD includes the key id, so a plain re-wrap would not decrypt),
  skips and counts rows whose old key is gone, is idempotent; `createKmsRewrapHandler()` is the `kms.rewrap` job handler and `enqueueKmsRewrap(tx)` queues it with a dedupe key. Tests in `kernel/test/kms.test.ts`.
  Not yet wired: the server hosts no job worker today, so someone has to call `enqueueKmsRewrap` (or the handler) after rotating `MANYTHREADS_KMS_KEY`; phase 5/6 adds the worker host.
- **`person_emails` uniqueness** (done, `0010`): unique per workspace among **verified** rows only, plus one row per person and address; unverified rows may repeat, so an address cannot be squatted. Test: `kernel/test/rls/person-emails.test.ts`.
  Edge: verifying an address another person of the workspace already verified now fails with a unique violation (a 500 from the reset route); it needs a friendly error if it ever happens in practice.
- **Stale "PLAN P2-08" doc comment** in `plugins/teams/src/index.ts` (done).
- Already done before this gate: last-owner protection (`0009`), MANYTHREADS_KMS_KEY in compose and helm.
- **Not done** (not quick): the phase 1 `Zod enum vs SQL CHECK` comparison test (no table-to-enum map exists yet; build it with the first phase 3 enum tables); response schemas for non-200 statuses.

## 9. Follow-ups for phase 3

1. **RLS cost of `app.can()` is the first phase 3 task, not a later tuning.** Measured on this gate (300,000 `stub_resources` rows, three teams, FORCE RLS, policy `app.can_in_team(team_id,'read') OR app.can(...)`):
   `SELECT count(*)` takes 77 s for Nadia (member of one team), 74 s for Lena (denied everything) and 21 s for Omar. Newest-50 for a readable team is fast (6 ms, the index scan finds 50 survivors), but a denied
   or sparse caller scans everything (Lena, newest-50 of Engineering: 24.5 s), and cross-team listings, counts, unread badges and search would all hit it. The cause is a `STABLE` plpgsql function evaluated per row
   (about 70 to 250 microseconds each), and `app.can(id)` falls through for every row the team check refuses.
   Prototype that fixed it: a definer function `app.zz_teams(perm) RETURNS uuid[]` that lists the caller's readable teams once, used as `team_id = ANY (((SELECT app.zz_teams('read')))::uuid[])` so the planner hoists it as an
   InitPlan: the same three counts take 0.48 s (about 150x faster, still a seq scan, but the per-row cost is a plain array probe). Do this in the kernel before channels exist:
   `app.readable_team_ids(permission)` plus the same hoisting for ACL grants (`id = ANY ((SELECT app.acl_grant_ids('channel','read'))::uuid[])`), keep `app.can()` for single-row checks, and check
   `EXPLAIN` (InitPlan present, no per-row function calls) in the RLS harness for every new table. Add partial indexes on `(team_id, id DESC)`-style hot paths, and measure with 1M rows (`tools/bench`).
   Also decide for private channels and DMs, where visibility is per row (membership), not per team.
2. **Trigram search under RLS** (carried): scope the plan before search: a trigram index scan plus the per-row policy has the same per-row cost; check the plan with the hoisted policy and a `team_id` equality in the query.
3. **Plugin duplicates of kernel helpers.** Plugins cannot import kernel internals, so `teams` re-implements get-or-create (`DO SELECT`) and template loading (`teams.ts` says so in a comment); `identity-*` repeat
   candidate/method queries. Consider SDK helpers for `getOneOrCreate`, template loading and `emitAudit` before channels, bots and tasks copy them a fourth time.
4. **Rate-limit tests for invite accept** (`/api/invitations/:token/accept`, `/api/invitations/:token`): the sign-in lockout is tested, token endpoints (invite, reset, verify, bootstrap) have no limiter test.
5. **Last-lead protection:** a team can lose its last `lead` (the last-owner guard covers workspaces only). Add a guard like `workspace_owner_guard` for `team_members`, with an admin override.
6. **Migration numbering.** PLAN names `0010_channels.sql`; the kernel is now at `0010_person_emails_verified_unique.sql`. Channels live in a plugin (own `migrations/` namespace), but if any kernel migration is needed, start at `0011`.
7. **Template apply left `TEAM.md` pending** in `team_pending_files` (`applied_at IS NULL`): phase 3 creates the channels from the stored definition; phase 4 must commit `TEAM.md` to the team repo and stamp `applied_at`.
8. Wire the `kms.rewrap` handler into the first job worker host, and decide who triggers it (an admin CLI `kms rewrap` is the simplest).
9. The two tight P-class visual comparisons (`signin-methods` 10.81/12, `teams-create` 5.32/6) leave little room; budget time for them when the shell changes in phase 3.

## 10. Answers to the phase 3 "reflect and refactor" prompts (PLAN Phase 3 section 0)

- **Is `app.can()` fast inside a policy on a million-row table?** No. See follow-up 1: per-row `STABLE` function calls cost 70 to 250 microseconds, so a 300,000-row unscoped read takes 20 to 77 seconds. A hoisted
  once-per-statement `uuid[]` of readable teams (InitPlan) brings the same scan to 0.48 s. Do it before channels and messages exist; add the `EXPLAIN` check to the harness. `team_members(actor_id)` and
  `acl_entries(subject_type, subject_id)` indexes exist already; no covering index is needed once the per-row calls are gone.
- **Does every screen call the typed API client? Is the settings frame reusable for channel settings?** Yes to the first: no `fetch` outside `clients/web/src/api/` (every call goes through `call(route, schemas)` with the shared
  route constants and Zod request and response parsing; the one hand-built URL is the OIDC start link, a browser navigation, built from the server's `startUrl`). Yes to the second: `SettingsFrame`
  (`components/frames.tsx`) is driven by a group list (Workspace, Team) and renders both the left nav and the mobile top select from the same data, so a `Channel` group is one more entry.
- **Did template apply leave anything half-done (`TEAM.md` pending commit)?** Yes, by design: the team row stores `template_id` and the definition; `TEAM.md` waits in `team_pending_files` (system-only table, written through
  `app.put_team_pending_files`), channels and bots exist as text only. Phase 3 creates the channels, phase 4 commits `TEAM.md` and stamps `applied_at`, phase 5 creates bots. Applying again is a no-op (`DO SELECT`), so a
  retry after a half-finished later step is safe.
