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

## 2. The test-only session endpoint (e2e runs, screenshots)

For a server that is already running (Playwright `api`, `desktop`, `mobile-web` projects, plate screenshots) a persona
can get a real session without typing a password:

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

## 3. The dev-header actor (NODE_ENV=test only)

`x-manythreads-dev-actor: {"kind":"person"|"bot","id":"<actors.id>","workspaceId":"<uuid>"}` names an actor directly.
It is honoured **only when `NODE_ENV=test`** (vitest and the Playwright `api` server set it); in any other environment it is
ignored, whatever options or variables say. It never makes a request cookie-authenticated, so it skips CSRF. Use it for
bots, personas without a password, or low-level host tests; prefer sessions for anything about sign-in.

## First-admin bootstrap in tests

A server started on an empty database prints one line, `first-admin setup: open <url>/bootstrap/<token> ...`. In tests read
it with `s.bootstrapToken()`; GET `/api/bootstrap/<token>` is 200 until the form is posted, then 410 forever. A database
that already has a workspace (`createPersonas`) prints nothing.

## Mail

`s.mailer` is `createMemoryMailer()`: `s.mailer.last('nadia@kahf.example')?.text` holds the reset or verify link
(`<publicUrl>/reset-password/<token>`, `<publicUrl>/verify-email/<token>`). In development mail goes to mailpit
(`MANYTHREADS_SMTP_URL=smtp://localhost:1025`, UI on :8025).
