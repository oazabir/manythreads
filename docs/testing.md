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
also writes the two PNGs). Plates declare `regions` (landmarks) and `copy` (`data-copy` texts, exact under P). Change a baseline
only with `pnpm vt:update`, in a PR that says why.

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

## Seed v2 and `pnpm seed`

`seedWorld(db, { demo })` (`packages/test-utils/src/seed.ts`, re-exported by `e2e/fixtures/seed.ts`) builds workspace **Kahf Software**:
teams Engineering, Customer support and Marketing (each with the template it was created from), the seven personas of PLAN.md section 4
with workspace roles, team seats, role tags and argon2id passwords, and a **verified `person_emails` row** per persona so OIDC can link
identities (Tariq also has `tariq@kahf.co`, his Google Workspace and Microsoft login; everyone else uses `<name>@kahf.example`). Ids are
fixed (`personas.ts`). It is idempotent, never replaces a password, and does nothing in a database that holds another workspace.
`createPersonas(db, { passwords: 'random', verifiedEmails: true })` is the building block.

```
pnpm seed                     # DATABASE_URL (default: dev compose Postgres), everyone has PERSONA_PASSWORD
pnpm seed --demo              # random passwords, hashed and printed nowhere (public deployments)
pnpm seed --migrate --wait 60 # apply kernel migrations first / wait for the server's migrations
```

## Browser specs with their own origin (OIDC, break-glass)

`e2e/fixtures/stack.ts` starts, per spec file, `fixtures/stack-server.ts`: the built web client and a real server on a fresh, seeded
database behind one origin (`http://127.0.0.1:<port>`; `/api` is proxied), so OIDC redirect URIs and cookies are same-origin and a spec
may change providers and workspace settings without touching the shared servers. `startStack({ MANYTHREADS_OIDC_MOCK_BASE })` returns
`{ origin, sql(), stop() }`; `signedInContext()` gives a persona's API session (test-session endpoint) and `createProvider()` the admin call.
The issuer is the in-process fake (`startFakeOidc`, `fixtures/oidc.ts`): its authorize endpoint redirects the browser straight back, so
Playwright follows the whole flow and the spec sets the claims with `fake.nextLogin(issuerId, claims)` before clicking. `tools/mock-oidc`
(the navikt container, with a login form) serves the same layout for manual runs. Needs `clients/web/dist` (the Playwright config builds it).
Specs: `identity/oidc-google`, `oidc-microsoft`, `oidc-any` (admin drives Settings, Sign-in), `break-glass`.
`MANYTHREADS_E2E_LOG=1` streams the stack's server log.

## First-admin bootstrap in tests

A server started on an empty database prints one line, `first-admin setup: open <url>/bootstrap/<token> ...`. In tests read
it with `s.bootstrapToken()`; GET `/api/bootstrap/<token>` is 200 until the form is posted, then 410 forever. A database
that already has a workspace (`createPersonas`) prints nothing.

## Mail

`s.mailer` is `createMemoryMailer()`: `s.mailer.last('nadia@kahf.example')?.text` holds the reset or verify link
(`<publicUrl>/reset-password/<token>`, `<publicUrl>/verify-email/<token>`). In development mail goes to mailpit
(`MANYTHREADS_SMTP_URL=smtp://localhost:1025`, UI on :8025).
