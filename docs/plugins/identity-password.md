# identity-password

Username and password sign-in (SPEC section 4): the password form, password change and reset, email verification by
mailed link, the one-time first-admin bootstrap link, and the session endpoints. Code: `packages/plugins/identity-password`.
Schemas: `packages/shared/src/api/auth/`. The cookie, rotation and expiry belong to the server's session service
(`packages/server/src/session`); this plugin decides who may have a session. Events: `identity.session.signed_in`,
`identity.session.sign_in_failed`, `identity.session.signed_out`, `identity.password.changed`, `identity.password.reset`,
`identity.password.admin_set`, `identity.email.verified`, `identity.workspace.bootstrapped`.

| Route | What it does |
|---|---|
| `GET /api/bootstrap/:token`, `POST /api/bootstrap/:token` | First-admin bootstrap. An empty database prints a one-time URL; the POST creates the workspace, the owner and a password. Used, expired or unknown tokens are 410. |
| `POST /api/auth/password/sign-in` | Email and password. Minimum 8 characters at every place a password is set. Unknown email and wrong password give the same 401; five failures per email and address lock it for 15 minutes (in-memory, per replica). |
| `POST /api/auth/sign-out`, `POST /api/auth/sign-out-everywhere`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` | Session management; writes need the CSRF header. |
| `GET /api/session` | Public. Anonymous: the sign-in methods. Signed in: person, workspace, role, teams and methods. |
| `POST /api/auth/password/change` | Needs the current password; ends every other session. |
| `POST /api/auth/password/reset-request`, `POST /api/auth/password/reset` | Mailed single-use link; the request never reveals whether the address exists. |
| `POST /api/auth/email/verify-request`, `POST /api/auth/email/verify` | Verifies an address; only a verified address is exclusive to its person. |
| `PATCH /api/account` | The person's own display name. |

## Break-glass: the password form for members

There is **one switch**: `workspaces.settings.passwordForMembers`, written by `PATCH /api/workspace` (Settings, General or
Sign-in methods). Nothing else decides it; the `password` row of `auth_providers` is not consulted.

- On (the default): everyone may use the password form.
- Off **and at least one single sign-on provider enabled**: a member (or guest) with the right password gets 403 "Password
  sign-in is turned off for members of this workspace", the failure is audited with reason `method_disabled`, and the
  anonymous `GET /api/session` no longer lists `password`, so the sign-in page shows the single sign-on buttons and a
  "sign in with a password" link only for admins.
- **Owners and admins always may** sign in with a password and always see `password` in their own session, so a broken
  provider never locks everyone out.
- The setting never bites without a working provider: `PATCH /api/workspace` answers 409 when asked to turn it off with no
  enabled provider, and sign-in treats it as on if the last provider is later removed or disabled.

Tests: `packages/plugins/identity-password/test/identity.test.ts` (break-glass), `packages/plugins/teams/test/workspace-settings.test.ts`
(the 409), `e2e/identity/break-glass.spec.ts` (the admin flips the switch in the real settings screen).
