import type { HttpRequest, HttpResponse, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  AuthProviderId,
  ListOidcMethodsQuery,
  ListOidcMethodsResponse,
  OidcStartQuery,
  listOidcMethodsRoute,
  oidcCallbackRoute,
  oidcStartRoute,
  type OidcProviderKind,
  type OidcSignInErrorCode,
} from '@manythreads/shared';
import { z } from 'zod';
import { linkPerson } from './linking.ts';
import {
  OIDC_KINDS,
  PROVIDER_COLUMNS,
  callbackUrl,
  defaultLabel,
  issuerFor,
  readConfig,
  type ProviderRow,
} from './provider.ts';
import {
  DiscoveryError,
  completeAuthorization,
  discoverIssuer,
  safeEqual,
  sha256,
  startAuthorization,
} from './protocol.ts';
import { evaluateClaims, safeReturnTo } from './rules.ts';

/** HttpOnly cookie that ties a callback to the browser that started the flow (the value is the `state`). */
export const FLOW_COOKIE = 'manythreads_oidc';
const FLOW_TTL_MS = 10 * 60_000;
const RATE = { limit: 120, windowMs: 60_000 } as const;

interface LoadedProvider {
  row: ProviderRow;
  kind: OidcProviderKind;
  secret: string;
}

type FlowRow = {
  workspace_id: string;
  provider_id: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
};

const CallbackQuery = z.looseObject({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
});

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Sign-in: the public methods list, `start` (redirect to the provider) and `callback` (verify, link, start a session). */
export function registerSignIn(ctx: PluginContext): void {
  const publicUrl = ctx.runtime.publicUrl;
  const secure = publicUrl.startsWith('https://');
  const cookieAttrs = `Path=/api/auth/oidc; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const setFlowCookie = (state: string): string => `${FLOW_COOKIE}=${state}; ${cookieAttrs}; Max-Age=${FLOW_TTL_MS / 1000}`;
  const clearFlowCookie = `${FLOW_COOKIE}=; ${cookieAttrs}; Max-Age=0`;

  const redirect = (location: string, extra: Record<string, string> = {}): HttpResponse => ({
    status: 302,
    headers: { location, 'cache-control': 'no-store', ...extra },
  });
  /** Back to the sign-in screen with a code it can turn into words (OIDC_SIGN_IN_ERROR_MESSAGES). */
  const failed = (code: OidcSignInErrorCode): HttpResponse =>
    redirect(`/sign-in?error=${code}`, { 'set-cookie': clearFlowCookie });

  async function loadProvider(tx: PluginTx, providerId: string): Promise<LoadedProvider | null> {
    const res = await tx.query<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM app.auth_providers WHERE id = $1 AND kind = ANY($2::text[])`,
      [providerId, [...OIDC_KINDS]],
    );
    const row = res.rows[0];
    if (!row || !row.enabled || !row.secret_id) return null;
    return { row, kind: row.kind as OidcProviderKind, secret: await ctx.secrets.get(tx, row.secret_id) };
  }

  /** Writes the refusal to the audit log and answers with the redirect. */
  async function refuse(p: ProviderRow, req: HttpRequest, reason: OidcSignInErrorCode, email: string | null): Promise<HttpResponse> {
    await ctx.identity.runAsSystem(
      (tx) =>
        ctx.events.emit(tx, {
          type: 'identity.oidc.refused',
          schemaVersion: 1,
          workspaceId: p.workspace_id,
          providerId: p.id,
          kind: p.kind,
          reason,
          email,
          ip: req.ip || null,
        }),
      { workspaceId: p.workspace_id },
    );
    return failed(reason);
  }

  ctx.http.route({
    method: listOidcMethodsRoute.method,
    path: listOidcMethodsRoute.path,
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { query: ListOidcMethodsQuery, response: ListOidcMethodsResponse },
    handler: async (req) => {
      const { workspace } = ListOidcMethodsQuery.parse(req.query);
      const methods = await ctx.identity.runAsSystem(async (tx) => {
        const ws = workspace
          ? await tx.query<{ id: string }>('SELECT id FROM app.workspaces WHERE slug = $1', [workspace])
          : await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY created_at, id LIMIT 1');
        const workspaceId = ws.rows[0]?.id;
        if (!workspaceId) return [];
        const res = await tx.query<ProviderRow>(
          `SELECT ${PROVIDER_COLUMNS} FROM app.auth_providers
            WHERE workspace_id = $1 AND enabled AND secret_id IS NOT NULL AND kind = ANY($2::text[])
            ORDER BY created_at, id`,
          [workspaceId, [...OIDC_KINDS]],
        );
        return res.rows.map((r) => ({
          id: AuthProviderId.parse(r.id),
          kind: r.kind as OidcProviderKind,
          label: readConfig(r.config).name || defaultLabel(r.kind as OidcProviderKind),
          startUrl: `/api/auth/oidc/${r.id}/start`,
        }));
      });
      return { body: { methods } };
    },
  });

  ctx.http.route({
    method: oidcStartRoute.method,
    path: oidcStartRoute.path,
    public: true,
    rateLimit: RATE,
    schema: { query: OidcStartQuery },
    handler: async (req): Promise<HttpResponse> => {
      const providerId = AuthProviderId.safeParse(req.params['providerId']);
      if (!providerId.success) return failed('provider_disabled');
      const returnTo = safeReturnTo(OidcStartQuery.parse(req.query).returnTo);

      const loaded = await ctx.identity.runAsSystem((tx) => loadProvider(tx, providerId.data));
      if (!loaded) return failed('provider_disabled');
      const config = readConfig(loaded.row.config);

      let flow;
      try {
        const metadata = await discoverIssuer(issuerFor(loaded.kind, config), config.clientId);
        const extra: Record<string, string> = { prompt: 'select_account' };
        if (loaded.kind === 'google' && loaded.row.allowed_domains.length === 1) {
          extra['hd'] = loaded.row.allowed_domains[0] as string;
        }
        flow = await startAuthorization({
          metadata,
          clientId: config.clientId,
          clientSecret: loaded.secret,
          redirectUri: callbackUrl(publicUrl),
          extra,
        });
      } catch (err) {
        if (err instanceof DiscoveryError) return failed('sign_in_failed');
        throw err;
      }

      const now = ctx.runtime.now();
      await ctx.identity.runAsSystem(async (tx) => {
        await tx.query('DELETE FROM app.oidc_flows WHERE expires_at < $1', [now]);
        await tx.query(
          `INSERT INTO app.oidc_flows (state_hash, workspace_id, provider_id, nonce, code_verifier, return_to, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            sha256(flow.state),
            loaded.row.workspace_id,
            loaded.row.id,
            flow.nonce,
            flow.codeVerifier,
            returnTo,
            now,
            new Date(now.getTime() + FLOW_TTL_MS),
          ],
        );
      });
      return redirect(flow.url.href, { 'set-cookie': setFlowCookie(flow.state) });
    },
  });

  ctx.http.route({
    method: oidcCallbackRoute.method,
    path: oidcCallbackRoute.path,
    public: true,
    rateLimit: RATE,
    schema: { query: CallbackQuery },
    handler: async (req): Promise<HttpResponse> => {
      const query = CallbackQuery.parse(req.query);
      const cookieState = readCookie(req.headers['cookie'], FLOW_COOKIE);
      // The state must come back with the cookie of the browser that started the flow (login CSRF defence).
      if (!query.state || !cookieState || !safeEqual(query.state, cookieState)) return failed('state_invalid');

      // Single use: the row is gone after this, whatever happens next.
      const now = ctx.runtime.now();
      const flow = await ctx.identity.runAsSystem(async (tx) => {
        const res = await tx.query<FlowRow>(
          `DELETE FROM app.oidc_flows WHERE state_hash = $1 AND expires_at > $2
           RETURNING workspace_id, provider_id, nonce, code_verifier, return_to`,
          [sha256(query.state as string), now],
        );
        return res.rows[0] ?? null;
      });
      if (!flow) return failed('state_invalid');

      const loaded = await ctx.identity.runAsSystem((tx) => loadProvider(tx, flow.provider_id));
      if (!loaded || loaded.row.workspace_id !== flow.workspace_id) return failed('provider_disabled');
      const { row, kind } = loaded;
      const config = readConfig(row.config);

      if (query.error || !query.code) return refuse(row, req, 'access_denied', null);

      let claims;
      try {
        const metadata = await discoverIssuer(issuerFor(kind, config), config.clientId);
        const url = new URL(callbackUrl(publicUrl));
        for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') url.searchParams.set(k, v);
        claims = await completeAuthorization({
          metadata,
          clientId: config.clientId,
          clientSecret: loaded.secret,
          callbackUrl: url,
          state: query.state,
          nonce: flow.nonce,
          codeVerifier: flow.code_verifier,
        });
      } catch (err) {
        return refuse(row, req, err instanceof DiscoveryError ? 'sign_in_failed' : 'token_invalid', null);
      }

      const verdict = evaluateClaims({ kind, tenantId: config.tenantId ?? null, allowedDomains: row.allowed_domains, claims });
      if (!verdict.ok) return refuse(row, req, verdict.reason, verdict.email);

      const outcome = await ctx.identity.runAsSystem(
        async (tx) => {
          const link = await linkPerson(ctx, tx, {
            workspaceId: row.workspace_id,
            providerId: row.id,
            subject: verdict.subject,
            email: verdict.email,
            name: verdict.name,
          });
          if (!link.ok) {
            await ctx.events.emit(tx, {
              type: 'identity.oidc.refused',
              schemaVersion: 1,
              workspaceId: row.workspace_id,
              providerId: row.id,
              kind,
              reason: link.reason,
              email: verdict.email,
              ip: req.ip || null,
            });
            return { ok: false as const, reason: link.reason };
          }
          const session = await ctx.identity.sessions.issue(tx, {
            workspaceId: row.workspace_id,
            personId: link.personId,
            device: req.headers['user-agent'] ?? null,
          });
          await ctx.events.emit(tx, {
            type: 'identity.oidc.signed_in',
            schemaVersion: 1,
            workspaceId: row.workspace_id,
            personId: link.personId,
            sessionId: session.sessionId,
            providerId: row.id,
            kind,
            createdPerson: link.createdPerson,
            ip: req.ip || null,
          });
          return { ok: true as const, session };
        },
        { workspaceId: row.workspace_id },
      );
      if (!outcome.ok) return failed(outcome.reason);
      return { ...redirect(flow.return_to, { 'set-cookie': clearFlowCookie }), setSession: outcome.session };
    },
  });
}
