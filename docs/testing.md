# Testing against a running server

How tests and screenshot runs get an authenticated caller. Real people sign in with a session cookie
(`manythreads_session`, HttpOnly) plus a readable CSRF cookie (`manythreads_csrf`); tests have three ways in.

## 1. Sessions through the real routes (preferred)

`packages/test-utils` has a cookie-jar client that behaves like the web client (keeps both cookies, sends `x-csrf-token`
on POST/PUT/PATCH/DELETE):

```ts
const s = await startTestServer({ now: clock.now });        // fresh database, server on a random port
await createPersonas(s.db);                                   // Kahf Software and the seven personas
const nadia = createApiClient(s.url);
await nadia.signIn('nadia@kahf.example', PERSONA_PASSWORD);   // POST /api/auth/password/sign-in
await nadia.get('/api/session');
```

`startTestServer` options: `now` (a clock you move to prove idle, absolute and rotation timing), `session` (lifetimes),
`testAuthToken`, `publicUrl`, `logger`. The server exposes `s.mailer` (every mail sent, in memory), `s.logs` and
`s.bootstrapToken()` (the one-time first-admin token printed at start while no workspace exists).

## 2. The test-only session endpoint (e2e runs)

For a server that is already running (Playwright `api`, `desktop`, `mobile-web` projects) a persona
can get a real session without typing a password. **Never on the live site**: the screenshots workflow does not use it (section 4):

```
POST /api/test/session            x-test-auth: <MANYTHREADS_TEST_AUTH_TOKEN>
{ "email": "nadia@kahf.example" }
-> 200 { sessionId, personId, workspaceId, csrfToken }  + Set-Cookie manythreads_session / manythreads_csrf
```

- It is **mounted only when the environment variable `MANYTHREADS_TEST_AUTH_TOKEN` is set** on the server
  (`startServer({ testAuthToken })` does the same in code). Without it the route does not exist: 404 like any unknown path.
- Even then a request must carry `x-test-auth` equal to that value (constant-time comparison). No header, a wrong header
  or an unknown person all answer the same 404, and the header is checked before the body is parsed.
- It issues exactly what a sign-in issues (a `sessions` row, hashed token, cookies, CSRF), for an existing, active person.
  It creates no people and writes no audit event. It is exempt from the CSRF check (a stale cookie must not block it).
- **Never set `MANYTHREADS_TEST_AUTH_TOKEN` on a real deployment.** The Playwright config sets it for the `api` server
  (`e2e-test-auth-token` by default; override with the same variable). Playwright specs use
  `e2e/api/support/api.ts` (`TEST_AUTH_TOKEN`, `PERSONA_EMAILS`):

```ts
const ctx = await playwright.request.newContext({ baseURL });
await ctx.post('/api/test/session', { data: { email: PERSONA_EMAILS.omar }, headers: { 'x-test-auth': TEST_AUTH_TOKEN } });
// ctx now carries the cookies; for a browser: context.addCookies((await ctx.storageState()).cookies)
```

## 3a. Visual specs (`e2e/visual/<area>/*.visual.spec.ts`, `pnpm vt`)

Each visual spec starts its own web origin + server on a fresh seeded database (`fixtures/stack.ts`; `MANYTHREADS_STACK_SEED=none`
gives an empty one that prints the first-admin link, `stack.bootstrapToken`) and signs the persona in through the real password
route (`visual/support/vt.ts`, `openPage`). Classes (PLAN section 5): **W** is `expectWireframe` (landmark order plus the frame against
its own baseline in `e2e/__baselines__/`, at most 0.2% differing, `[data-vt-mask]` painted over); **P / P-loose** is `comparePlate`:
the content box of the plate's pane (stepper rail and settings nav are not part of the screen) against the live region, both cut
to the same size; it prints `[vt] <class> <spec>: x% differing` and attaches plate, live and diff (`MANYTHREADS_VT_DUMP=<dir>`
also writes the two PNGs and the diff). Plates declare `regions` (landmarks; a selector matching several elements is the box around
all of them) and `copy` (`data-copy` texts, exact under P). Change a baseline only with `pnpm vt:update`, in a PR that says why.

**Masks are painted black on both images.** The live side is every `[data-vt-mask]` element of the region plus `liveMasks`
selectors (avatars, which the wireframe baselines keep unmasked); the plate side is `spec.masks` (times, avatars, the prototype's bot
lanes). The ratio counts only unmasked pixels. A plate that fills a whole frame (the channel and Threads plates of section `app`) is
compared at the plate's own size: `extraWidth` covers its 1 px frame borders and the live window is cut to the plate's 700 px height
(`page.setViewportSize`, so the composer sits where the plate's does). The plate's frame is moved onto the pixel grid before the clip
(a fractional offset shifts every line by a fraction of a pixel, which rounds to a whole pixel of difference on some rows) and a live
region that fits the window is captured without `fullPage` (a full-page capture resizes the viewport, which a virtualised list
answers by jumping to its end).

`e2e/visual/support/story.ts` builds the story of plates 1 and 2 through the real routes on a stack seeded with
`MANYTHREADS_STACK_SEED=content` (a `release-eng` channel in a `Product` group, a goal thread, two attachments, the other rows of the
inbox): the prototype's bots do not exist before phase 5, so the same words are spoken by the seed's people and their live rows are
masked. `scrollToFirstDay` puts the first day label where the plate's stream starts.

## 3. The dev-header actor (NODE_ENV=test only)

`x-manythreads-dev-actor: {"kind":"person"|"bot","id":"<actors.id>","workspaceId":"<uuid>"}` names an actor directly.
It is honoured **only when `NODE_ENV=test`** (vitest and the Playwright `api` server set it); in any other environment it is
ignored, whatever options or variables say. It never makes a request cookie-authenticated, so it skips CSRF. Use it for
bots, personas without a password, or low-level host tests; prefer sessions for anything about sign-in.

## 4. Screenshots of the live site (no bypass)

The live site has `testAuth.enabled: false`, so `/api/test/session` does not exist there. `e2e/screens/live.shots.ts` signs in through
the sign-in form with a password the screenshots workflow sets first, with the server's admin CLI:

```
printf '%s\n' "$PW" | pnpm --filter @manythreads/server admin set-password nadia@kahf.example
```

`set-password <email>` (`packages/server/src/cli/admin.ts`) reads the new password from **stdin only** (a TTY is refused; one trailing
newline is stripped), requires at least 12 characters, stores an argon2id hash, revokes every session of that person and every unused
reset link, and writes an `identity.password.admin_set` audit event (person and number of sessions revoked, never the password). It
connects as `manythreads_system` from `MANYTHREADS_SYSTEM_DATABASE_URL` (or derives it from `DATABASE_URL`), so it runs in the server
pod (`kubectl exec -i deploy/manythreads-server -- ...`, see `remote_set_password` in `.github/actions/lib/remote.sh`) and in a dev
checkout against `pnpm db:up`. Locally against a stack: `MANYTHREADS_LIVE_URL=<origin> MANYTHREADS_LIVE_PASSWORD=<pw> pnpm -C e2e exec
playwright test -c screens/live.config.ts`.

## Seed v3 and `pnpm seed`

`seedWorld(db, { demo, content })` (`packages/test-utils/src/seed.ts`, re-exported by `e2e/fixtures/seed.ts`) builds workspace **Kahf Software**:
teams Engineering, Customer support and Marketing (each with the template it was created from), the seven personas of PLAN.md section 4
with workspace roles, team seats, role tags and argon2id passwords, and a **verified `person_emails` row** per persona so OIDC can link
identities (Tariq also has `tariq@kahf.co`, his Google Workspace and Microsoft login; everyone else uses `<name>@kahf.example`). Ids are
fixed (`personas.ts`). It is idempotent, never replaces a password, and does nothing in a database that holds another workspace.
`createPersonas(db, { passwords: 'random', verifiedEmails: true })` is the building block.

With `content: true` (what `pnpm seed` does by default; `--no-content` turns it off) it also writes **seed v3** (`seed-content.ts`, the
words in `seed-data.ts`), straight into the tables as the system role, with fixed ids (`SEED_IDS`) and stable times, so a second run adds
not one row. It needs the plugin tables, so it runs after the server's migrations (the stack and the Helm Job arrange that; with the
tables missing `SeedResult.content.skipped` says so and nothing is written):

| What | Content |
|---|---|
| Channels | the template channels of the three teams (Engineering: #general #dev #releases #incidents #alerts #standup; Customer support: #support #escalations #enquiries #kb-updates; Marketing: #campaigns #content #social #analytics #brand), about 40 messages each from the people of that team; #dev talks about the cache TTL, the rollback and the rota, #support about customers, #content about the launch post |
| Thread | **"Deploy plan"** in #dev (root by Nadia, with `deploy-plan-v2.14.pdf` attached), 12 replies from Nadia, Rafi and Omar; Rafi has the last reply unread |
| Private channel | `#eng-leads`: Omar and Nadia only |
| DM | Nadia and Rafi; Rafi's last line is "Check the rota?" and it is unread for Nadia |
| Big channel | `#load-test` in Engineering: 5,000 messages generated in SQL (one statement) |
| Guest | Lena's `read` grant on `#releases` (a few dozen release announcements) |
| Extras | reactions, `@rafi` mentions (Rafi's bell: one mention, one thread reply, unread), read state so nobody sees a "New" divider above old messages |

Timestamps: ids always carry the same times (history starts Monday 2026-03-02 09:00 UTC, ten working days, `#load-test` after it).
`created_at` is the same with `MANYTHREADS_CLOCK=fixed` (or `contentOptions: { baseDate }`); otherwise the newest message is half an
hour old, so a demo site reads like a live team. The attachment is written to `MANYTHREADS_STORAGE_DIR` (default `./data/blobs`) where
`storage-local` looks; `--no-attachment` leaves it (and its card) out for a process that does not share the server's disk (the Helm seed Job shares it: it mounts the server's blob PVC).

```
pnpm seed                     # DATABASE_URL (default: dev compose Postgres), everyone has PERSONA_PASSWORD, with content
pnpm seed --demo              # random passwords, hashed and printed nowhere (public deployments)
pnpm seed --no-content        # workspace, teams and people only
pnpm seed --migrate --no-content --wait 60   # apply kernel migrations first / wait for the server's migrations
```

## Isolated stacks for api specs, and ports

The Playwright `api` project shares one server (`api/support/start-server.ts`, personas only). Specs on it must not change what a persona
can see (no channels, posts, follows, grants, uploads, providers): a spec that writes calls `useIsolatedStack()` from
`e2e/api/support/isolated.ts` and gets, for that spec file, a server and database of its own (`fixtures/stack.ts`), dropped when the file
ends. It re-exports `test` and `expect` (`request` and `baseURL` then point at the file's server); `await iso.start()` returns the
`Stack` (`origin`, owner `sql()`). `useIsolatedStack({ MANYTHREADS_STACK_SEED: 'content' })` seeds seed v3 instead of the bare people.
`fixtures/stack-server.ts` takes `MANYTHREADS_STACK_SEED` (`world` default, `content`, `personas`, `none`), `MANYTHREADS_STACK_API_ONLY`,
`MANYTHREADS_STACK_DEV_AUTH` and `MANYTHREADS_STACK_TEST_PLUGINS` (the isolated api stacks set the last three).

Ports are free ports picked when the Playwright config loads (`support/ports.ts`; the choice travels to the workers in
`MANYTHREADS_E2E_PORTS`), so two runs at once do not meet on a fixed number. Pin them with `MANYTHREADS_API_PORT` (+1, +2) and
`MANYTHREADS_WEB_PORT` (+1, +2). For two runs side by side also set `MANYTHREADS_E2E_AUTH_DIR`, `MANYTHREADS_E2E_OUTPUT_DIR` and
`PLAYWRIGHT_HTML_REPORT` to directories of their own.

## Browser specs with their own origin (OIDC, break-glass)

`e2e/fixtures/stack.ts` starts, per spec file, `fixtures/stack-server.ts`: the built web client and a real server on a fresh, seeded
database behind one origin (`http://127.0.0.1:<port>`; `/api` is proxied), so OIDC redirect URIs and cookies are same-origin and a spec
may change providers and workspace settings without touching the shared servers. `startStack({ MANYTHREADS_OIDC_MOCK_BASE })` returns
`{ origin, sql(), stop() }`; `signedInContext()` gives a persona's API session (test-session endpoint) and `createProvider()` the admin call.
The issuer is the in-process fake (`startFakeOidc`, `fixtures/oidc.ts`): its authorize endpoint redirects the browser straight back, so
Playwright follows the whole flow and the spec sets the claims with `fake.nextLogin(issuerId, claims)` before clicking. `tools/mock-oidc`
(the navikt container, with a login form) serves the same layout for manual runs. Needs `clients/web/dist` (the Playwright config builds it).
Specs: `identity/oidc-google`, `oidc-microsoft`, `oidc-any` (admin drives Settings, Sign-in), `break-glass` (the admin turns the member password form off in Settings, Sign-in; no SQL arrangement), `teams/roles`.
`MANYTHREADS_E2E_LOG=1` streams the stack's server log.

## First-admin bootstrap in tests

A server started on an empty database prints one line, `first-admin setup: open <url>/bootstrap/<token> ...`. In tests read
it with `s.bootstrapToken()`; GET `/api/bootstrap/<token>` is 200 until the form is posted, then 410 forever. A database
that already has a workspace (`createPersonas`) prints nothing.

## Mail

`s.mailer` is `createMemoryMailer()`: `s.mailer.last('nadia@kahf.example')?.text` holds the reset or verify link
(`<publicUrl>/reset-password/<token>`, `<publicUrl>/verify-email/<token>`). In development mail goes to mailpit
(`MANYTHREADS_SMTP_URL=smtp://localhost:1025`, UI on :8025).
