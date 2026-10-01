# mock-oidc

A mock OpenID Connect provider for development and Playwright runs: `ghcr.io/navikt/mock-oauth2-server:2.1.10`,
configured by [`config.json`](./config.json). One container plays every provider; the first path segment is the issuer id:

| Issuer id | Issuer URL | Plays | Default claims added to every id_token |
|---|---|---|---|
| `google` | `http://localhost:8080/google` | Google Workspace preset | `email_verified: true`, `hd: kahf.co` |
| `microsoft` | `http://localhost:8080/microsoft` | Microsoft 365 preset | `tid: 9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11` |
| `any` | `http://localhost:8080/any` | any-OIDC provider | `email_verified: true` |

## Run it

```
docker compose -f deploy/compose/docker-compose.dev.yml up -d oidc        # the compose service mounts config.json
# or on its own:
docker run -d --name mock-oidc -p 8080:8080 -e SERVER_PORT=8080 -e JSON_CONFIG_PATH=/config/config.json \
  -v "$PWD/tools/mock-oidc/config.json:/config/config.json:ro" ghcr.io/navikt/mock-oauth2-server:2.1.10
```

Discovery: `http://localhost:8080/<issuerId>/.well-known/openid-configuration`.

## Point manythreads at it

The Google and Microsoft presets talk to the real Google and Microsoft endpoints. In development and tests only, set

```
MANYTHREADS_OIDC_MOCK_BASE=http://localhost:8080
```

and the presets use `<base>/google` and `<base>/microsoft` instead (ignored when `NODE_ENV=production`). An any-OIDC provider
simply uses `http://localhost:8080/any` as its issuer URL (plain http is accepted for localhost only). Create the providers
through the admin API or the Sign-in settings screen with any client id and secret; the mock accepts all of them:

```
POST /api/auth/oidc/providers  {"kind":"google","clientId":"google-client","clientSecret":"anything","allowedDomains":["kahf.co"]}
POST /api/auth/oidc/providers  {"kind":"microsoft","tenantId":"9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11","clientId":"ms-client","clientSecret":"anything","allowedDomains":["kahf.co"]}
POST /api/auth/oidc/providers  {"kind":"oidc","issuer":"http://localhost:8080/any","clientId":"any-client","clientSecret":"anything"}
```

## Choosing the claims per test

`interactiveLogin` is on: the authorize endpoint shows a login form with a **username** (becomes `sub`) and a **claims**
text area (JSON merged into the id_token). A browser test fills both, so every case picks its own person:

| Case | username | claims |
|---|---|---|
| Tariq signs in with Google | `tariq-sub` | `{"email":"tariq@kahf.co","name":"Tariq"}` |
| Other domain (refused) | `eve-sub` | `{"email":"eve@other.com","hd":"other.com"}` |
| Other tenant (refused) | `eve-sub` | `{"email":"eve@kahf.co","tid":"11111111-2222-4333-8444-555555555555"}` |
| Unverified email (refused) | `eve-sub` | `{"email":"eve@kahf.co","email_verified":false}` |

Without a browser, post the same two fields to the authorize URL the `start` route redirected to (this is what the
Playwright helper does) and follow the redirect to `/api/auth/oidc/callback` with the `manythreads_oidc` cookie that `start` set.

To change the defaults of an issuer, edit `tokenCallbacks[].requestMappings[].claims` in `config.json`. Anything fancier
(extra issuers, expiry) is in the upstream documentation: <https://github.com/navikt/mock-oauth2-server>.

## In vitest

Unit and integration tests do not use the container. `startFakeOidc()` in `packages/test-utils/src/fake-oidc.ts` is an
in-process issuer with the same URL layout (`/<issuerId>/...`), set up per test with `nextLogin(issuerId, claims, options)`;
its options break one thing at a time (wrong nonce, bad signature, wrong audience, expired token, missing id_token).
