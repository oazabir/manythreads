# identity-oidc

OpenID Connect sign-in (SPEC section 4, PLAN P2-05): the Google Workspace and Microsoft 365 presets and any OIDC provider
(Okta, Keycloak, GitHub through a bridge, Apple). Code: `packages/plugins/identity-oidc`. Schemas:
`packages/shared/src/api/auth/oidc.ts`. Events: `identity.provider.changed`, `identity.oidc.signed_in`,
`identity.oidc.refused`. Test issuers: [tools/mock-oidc](../../tools/mock-oidc/README.md) and `startFakeOidc()` in
`packages/test-utils`.

Besides the SDK and shared schemas the plugin depends on `openid-client` (discovery, code exchange, PKCE) and `jose` (id_token signatures). It decides who may have a session; the cookie, rotation and expiry belong to the server's session service
(`identity.sessions.issue`). Members can be OIDC-only: the password form for members is a workspace setting owned by
`identity-password`, and owners and admins keep it as break-glass. Enabled providers appear in `GET /api/session`
(`methods`) next to the password form.

## Setting up a provider (workspace owners and admins only)

Register `<public URL>/api/auth/oidc/callback` as the redirect URI at the provider (`callbackUrl` in every provider response).

| Kind | You give | Rules at sign-in |
|---|---|---|
| `google` | client id, secret, allowed domains (at least one) | issuer `https://accounts.google.com`; `hd` and the email domain must both be allowed (a personal Gmail account has no `hd`); `email_verified` true |
| `microsoft` | tenant id (a GUID), client id, secret, allowed domains (optional) | issuer `https://login.microsoftonline.com/<tenant>/v2.0`; the `tid` claim must be that tenant, so another tenant is refused; the address is `email` or the UPN in `preferred_username` |
| `oidc` | issuer URL (https; plain http only for localhost), client id, secret, allowed domains (optional) | `email_verified` true; the domain list applies when it is not empty |

| Route | What it does |
|---|---|
| `GET /api/auth/oidc/providers` | The workspace's OIDC providers. |
| `POST /api/auth/oidc/providers` | Create. Discovery runs now; `enabled` (default true) only takes effect when it passes. |
| `PATCH /api/auth/oidc/providers/:id` | Change label, client id, secret, domains, tenant or issuer. Changing an endpoint re-runs discovery. A provider an earlier failure switched off comes back on when the fix passes; one switched off by hand stays off. |
| `POST .../:id/test` | Discovery again (never cached). A failing test switches an enabled provider off with the reason. |
| `POST .../:id/enable`, `POST .../:id/disable` | Enable runs discovery first; a failure leaves it disabled with `disabledReason`. |
| `DELETE .../:id` | Removes the provider, its links and its secret. |

A provider whose discovery fails is saved **disabled** with `disabledReason` (for example "Could not read the discovery
document at https://idp.example: ...") and `lastTest`, so the settings screen can show the result. Nobody can sign in
through it. The client secret goes in on create and update and is stored with envelope encryption (`ctx.secrets`, the KMS
of `packages/kernel/src/kms`); no route returns it and no event carries it: responses have `hasSecret: true`.

## The sign-in flow

1. `GET /api/auth/oidc/methods` (public) lists the enabled providers as `{ id, kind, label, startUrl }` for the sign-in screen.
2. The screen navigates (not fetches) to `GET /api/auth/oidc/:providerId/start?returnTo=/path`. The server runs discovery
   (cached ten minutes), makes a random `state`, `nonce` and PKCE verifier, stores the nonce and verifier in the UNLOGGED
   table `oidc_flows` under the sha256 of the state (ten minutes), sets the HttpOnly, SameSite=Lax cookie
   `manythreads_oidc` (path `/api/auth/oidc`) holding the state, and redirects with `code_challenge_method=S256`.
3. The provider redirects to `GET /api/auth/oidc/callback`. The state must match the cookie of the same browser (login CSRF)
   and an unexpired row, which is deleted on the spot: a callback works once.
4. The code is exchanged (client secret, PKCE verifier). `openid-client` checks state, issuer, audience, expiry and nonce;
   `jose` then verifies the id_token **signature** against the provider's JWKS; the nonce is compared again.
5. The provider rules above run (`src/rules.ts`, pure and unit-tested).
6. The person is found or created inside the provider's workspace only (`src/linking.ts`):
   - an identity row for (provider, subject) exists: that person (a suspended one is refused);
   - a person of the workspace has the verified email: linked. The local address must be verified, or the person must have
     no password (so an account cannot be pre-claimed with an unverified address and a password); a person already linked to
     another subject at this provider is refused (`identity_mismatch`);
   - otherwise a person is created only when the workspace allows self sign-up (`workspaces.self_signup`) or an open
     invitation names the address (role and team seat come from the invitation, which is marked accepted).
   Linking never crosses workspaces: lookups filter on the provider's workspace and a provider belongs to one.
7. A session is issued and the browser is redirected to `returnTo` (a same-origin path; anything else becomes `/`).

A refusal redirects to `/sign-in?error=<code>`; the codes and their sentences are `OidcSignInErrorCode` and
`OIDC_SIGN_IN_ERROR_MESSAGES` in the shared schemas ("That domain is not allowed." for `domain_not_allowed`). Every
refusal after the provider answered is an `identity.oidc.refused` event; every sign-in an `identity.oidc.signed_in` event.

## Development

`MANYTHREADS_OIDC_MOCK_BASE=http://localhost:8080` makes the Google and Microsoft presets use the mock issuer at
`<base>/google` and `<base>/microsoft` (ignored in production). Rate limits: 120 per minute per client address on `start`
and `callback`, in process memory.
