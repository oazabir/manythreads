import { conflict, forbidden, invalid, json, route, type HttpResponse, type PluginContext } from '@manythreads/sdk';
import {
  abuseLimit,
  disconnectPersonConnectionRoute,
  DisconnectPersonConnectionResponse,
  ListPersonConnectionsResponse,
  listPersonConnectionsRoute,
  PersonConnectionCallbackQuery,
  PersonConnectionParams,
  personConnectionCallbackRoute,
  StartPersonConnectionRequest,
  StartPersonConnectionResponse,
  startPersonConnectionRoute,
  type PersonConnectError,
  type PersonProviderId,
} from '@manythreads/shared';
import { accountLabelFor } from './oauth/api.ts';
import { authorizationUrl, exchangeCode, newFlowSecrets } from './oauth/flow.ts';
import { configuredProviders, resolveApp } from './oauth/apps.ts';
import { endpointsFor, PROVIDERS, providerIds, redirectUriFor, scopesFor, serviceDef, servicesGranted } from './oauth/providers.ts';
import { consumeFlow, disconnectPerson, ownConnections, recordFlow, saveSignIn, type OAuthDeps } from './oauth/store.ts';
import { PERSON_TOOL_DEFS } from './person-tools.ts';

// The routes where a person connects their own Google, Microsoft or Notion account (PLAN P8-02). One start route and one callback route serve every provider: they read
// the provider's entry in oauth/providers.ts and run the shared flow in oauth/flow.ts. The tokens go straight to the sealed store; no route returns one.
//
//   GET    /api/me/connections                       the providers, which services each offers, what the caller connected, and whether the server is set up for it
//   POST   /api/me/connections/:provider/start       { services?, returnTo? } -> { url }: where to send the browser (the provider's consent page); 409 when no app is set up
//   GET    /api/me/connections/:provider/callback    the provider sends the browser back here; the answer is a redirect to `returnTo` with `connected=` or `connect_error=`
//   DELETE /api/me/connections/:provider             disconnect: the provider forgets the token, and the connection and every sealed token are deleted

const DEFAULT_RETURN = '/settings/connections';

/** Only a path of this site: a leading slash, no second slash or backslash (which a browser reads as another host), no control character, a sane length. */
export function safeReturn(raw: string | undefined): string {
  if (!raw || raw.length > 500 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return DEFAULT_RETURN;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) < 0x20 || raw.charCodeAt(i) === 0x7f) return DEFAULT_RETURN;
  return raw;
}

/** `returnTo` with one query parameter set; it is a path of this site already, so the base used to parse it never shows. */
export function withParam(returnTo: string, key: string, value: string): string {
  const url = new URL(returnTo, 'http://site.invalid');
  url.searchParams.delete('connected');
  url.searchParams.delete('connect_error');
  url.searchParams.set(key, value);
  // `/a/..//x` parses to `//x`, which a browser reads as another host: keep one leading slash
  return `${url.pathname.replace(/^\/{2,}/, '/')}${url.search}${url.hash}`;
}

const redirect = (location: string): HttpResponse => ({ status: 302, headers: { location, 'cache-control': 'no-store' } });

export function registerPersonRoutes(ctx: PluginContext, deps: OAuthDeps): void {
  const publicUrl = ctx.runtime.publicUrl;

  const providerOf = (params: unknown): PersonProviderId => PersonConnectionParams.parse(params).provider;

  ctx.http.route({
    ...listPersonConnectionsRoute,
    schema: { response: ListPersonConnectionsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      if (tx.actor.kind !== 'person') throw forbidden('Only a person has connections of their own.');
      const own = await ownConnections(tx, tx.actor.id);
      const configured = await configuredProviders(deps, tx.actor.workspaceId);
      return json({
        providers: providerIds().map((id) => {
          const def = PROVIDERS[id];
          const mine = own.get(id);
          const granted = new Set(mine ? servicesGranted(def, mine.scopes) : []);
          return {
            id,
            label: def.label,
            configured: configured.has(id),
            problem: mine?.problem ?? null,
            refreshedAt: mine?.refreshedAt?.toISOString() ?? null,
            connected: mine !== undefined,
            state: mine ? mine.state : null,
            accountLabel: mine?.accountLabel ?? null,
            redirectUri: redirectUriFor(publicUrl, id),
            services: def.services.map((s) => ({
              id: s.id,
              label: s.label,
              description: s.description,
              tools: PERSON_TOOLS_BY_SERVICE(id, s.id),
              writes: PERSON_WRITES(id, s.id),
              granted: granted.has(s.id),
            })),
          };
        }),
      });
    }),
  });

  ctx.http.route({
    ...startPersonConnectionRoute,
    schema: { body: StartPersonConnectionRequest, response: StartPersonConnectionResponse },
    // a person's own limit (docs/deploy/rate-limits.md): each start writes a row and sends the browser to a third party
    rateLimit: abuseLimit(startPersonConnectionRoute.method, startPersonConnectionRoute.path),
    handler: route(async (req, tx) => {
      if (tx.actor.kind !== 'person') throw forbidden('Only a person has connections of their own.');
      const provider = providerOf(req.params);
      const def = PROVIDERS[provider];
      const app = await resolveApp(deps, tx.actor.workspaceId, provider);
      if (!app) throw conflict(`${def.label} is not set up on this server yet. A workspace admin has to add this server’s ${def.label} app (its client id and secret) first.`);
      const body = StartPersonConnectionRequest.parse(req.body);
      const named = [...new Set(body.services ?? def.defaultServices)];
      const unknown = named.find((s) => !serviceDef(def, s));
      if (unknown) throw invalid(`${def.label} has no service called “${unknown.slice(0, 40)}”.`);
      // Incremental scopes: ask only for what the person has not agreed to yet, so adding Calendar later does not ask about Drive again. When everything named is already
      // agreed to, the person is signing in again on purpose (to renew the sign-in), so the named services are asked as they are. A sign-in that has to be made again
      // asks for everything it covered before as well as the new ones, so reconnecting never loses a service.
      const mine = (await ownConnections(tx, tx.actor.id)).get(provider);
      const already = mine ? new Set(servicesGranted(def, mine.scopes)) : new Set<string>();
      const dead = mine !== undefined && mine.state !== 'ok';
      const delta = named.filter((s) => !already.has(s));
      const services = dead ? [...new Set([...already, ...named])] : delta.length > 0 ? delta : named;
      const secrets = newFlowSecrets(def);
      await recordFlow(deps, { workspaceId: tx.actor.workspaceId, ownerId: tx.actor.id, provider, services, state: secrets.state, verifier: secrets.verifier, returnTo: safeReturn(body.returnTo) });
      return json({
        url: authorizationUrl(def, endpointsFor(provider, deps.env, app.tenant), {
          clientId: app.clientId,
          redirectUri: redirectUriFor(publicUrl, provider),
          scopes: scopesFor(def, services),
          state: secrets.state,
          challenge: secrets.challenge,
        }),
      });
    }),
  });

  ctx.http.route({
    ...personConnectionCallbackRoute,
    schema: { query: PersonConnectionCallbackQuery },
    // the browser arrives from the provider carrying the signed-in person's session cookie (SameSite=Lax allows a top-level GET); the one-time state does the rest
    rateLimit: abuseLimit(personConnectionCallbackRoute.method, personConnectionCallbackRoute.path),
    handler: route(async (req, tx) => {
      const provider = providerOf(req.params);
      const def = PROVIDERS[provider];
      const query = PersonConnectionCallbackQuery.parse(req.query);
      const fail = (returnTo: string, code: PersonConnectError): HttpResponse => redirect(withParam(returnTo, 'connect_error', code));
      if (tx.actor.kind !== 'person') throw forbidden('Only a person has connections of their own.');
      if (!query.state) return fail(DEFAULT_RETURN, 'expired');

      // single use: the row is gone after this, whatever happens next
      const flow = await consumeFlow(deps, tx.actor.workspaceId, query.state);
      if (!flow || flow.provider !== provider) return fail(DEFAULT_RETURN, 'expired');
      const returnTo = safeReturn(flow.return_to);
      // the sign-in must finish in the browser, as the person, that started it
      if (flow.owner_id !== tx.actor.id) return fail(returnTo, 'wrong_person');
      if (query.error || !query.code) return fail(returnTo, 'denied');
      const app = await resolveApp(deps, tx.actor.workspaceId, provider);
      if (!app) return fail(returnTo, 'not_configured');

      try {
        const tokens = await exchangeCode(
          { provider: def, endpoints: endpointsFor(provider, deps.env, app.tenant), app, fetchImpl: deps.fetchImpl },
          { code: query.code, redirectUri: redirectUriFor(publicUrl, provider), verifier: flow.code_verifier },
        );
        const accountLabel = await accountLabelFor(deps, provider, tokens.accessToken, tokens.accountHint);
        await saveSignIn(deps, {
          workspaceId: tx.actor.workspaceId,
          ownerId: tx.actor.id,
          provider,
          label: def.label,
          tokens,
          requestedScopes: scopesFor(def, flow.services),
          accountLabel,
        });
      } catch {
        // the reason (a provider refusal, a database error) is deliberately not put in the address; the server log has the request, no token
        return fail(returnTo, 'failed');
      }
      return redirect(withParam(returnTo, 'connected', provider));
    }),
  });

  ctx.http.route({
    ...disconnectPersonConnectionRoute,
    schema: { response: DisconnectPersonConnectionResponse },
    rateLimit: abuseLimit(disconnectPersonConnectionRoute.method, disconnectPersonConnectionRoute.path),
    handler: route(async (req, tx) => {
      if (tx.actor.kind !== 'person') throw forbidden('Only a person has connections of their own.');
      const disconnected = await disconnectPerson(deps, { workspaceId: tx.actor.workspaceId, ownerId: tx.actor.id, provider: providerOf(req.params) });
      return json({ disconnected });
    }),
  });
}

// The tools a service gives, and whether any of them writes, for the list the screen shows.
const PERSON_TOOLS_BY_SERVICE = (provider: PersonProviderId, service: string): string[] => PERSON_TOOL_DEFS.filter((t) => t.provider === provider && t.service === service).map((t) => t.name);
const PERSON_WRITES = (provider: PersonProviderId, service: string): boolean => PERSON_TOOL_DEFS.some((t) => t.provider === provider && t.service === service && t.kind === 'write');
