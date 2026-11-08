import { json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  ConnectorHealthRow,
  CreateProviderHookRequest,
  CreateProviderHookResponse,
  DeleteProviderHookResponse,
  ListConnectorHealthResponse,
  ListProviderHooksResponse,
  ProviderEndpoint,
  ProviderHookChannelParams,
  ProviderHookPathParams,
  PutProviderSigningSecretRequest,
  PutProviderSigningSecretResponse,
  RotateProviderHookResponse,
  UpdateProviderHookRequest,
  UpdateProviderHookResponse,
  WebhooksProviderEndpointChangedEvent,
  abuseLimit,
  createProviderHookRoute,
  deleteProviderHookRoute,
  listProviderHooksRoute,
  providerEndpointsHealthRoute,
  putProviderSigningSecretRoute,
  rotateProviderHookRoute,
  updateProviderHookRoute,
  type ProviderSecretSource,
  type WebhookProvider,
} from '@manythreads/shared';
import { conflict, forbidden, invalid } from './http.ts';
import { newSigningSecret } from './secrets.ts';

// Work package H (P16-10, decisions D16 to D19): a channel's lead makes an address a work app calls (GitHub, GitLab, Jira, Linear, Zendesk, Intercom, HubSpot, Asana, or a generic sender),
// changes which kinds of event it takes, gives or replaces its signing secret, rotates it, or turns it off. The secret is sealed and shown once.
//
// Who may: a lead of the channel's team or a workspace admin who can also read the channel (the bots that answer post into it). The caller's own transaction decides that
// (`app.channel_can`), and the rows are read through row-level security. Writes to `webhook_provider` and to the sealed secret are the system role's, in a transaction of their own
// that opens after the caller's check; the caller's transaction reads the result back (a committed row, so it sees it).

/** The apps whose secret is the app's own client secret, pasted by the lead. Every other app's is made here (Asana's comes from its handshake). */
const PASTED: ReadonlySet<WebhookProvider> = new Set(['zendesk', 'intercom', 'hubspot']);
export const secretSourceOf = (provider: WebhookProvider): ProviderSecretSource => (PASTED.has(provider) ? 'pasted' : 'generated');

const LABELS: Record<WebhookProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  jira: 'Jira',
  linear: 'Linear',
  zendesk: 'Zendesk',
  intercom: 'Intercom',
  hubspot: 'HubSpot',
  asana: 'Asana',
  generic: 'Other app',
};

interface EndpointRow {
  id: string;
  team_id: string;
  workspace_id: string;
  channel_id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  provider: WebhookProvider;
  slug: string;
  event_filter: string[];
  has_secret: boolean;
  rotated_at: Date | null;
  [key: string]: unknown;
}

const SELECT = `SELECT w.id, w.team_id, w.workspace_id, w.channel_id, w.name, w.created_at, w.last_used_at, p.provider, p.slug, p.event_filter, p.signing_secret_id IS NOT NULL AS has_secret, p.rotated_at
                  FROM app.webhooks w JOIN app.webhook_provider p ON p.webhook_id = w.id`;

const toEndpoint = (r: EndpointRow): ProviderEndpoint =>
  ProviderEndpoint.parse({
    id: r.id,
    teamId: r.team_id,
    channelId: r.channel_id,
    provider: r.provider,
    slug: r.slug,
    name: r.name,
    eventFilter: r.event_filter,
    secretSource: secretSourceOf(r.provider),
    hasSecret: r.has_secret,
    path: `/hooks/apps/${r.id}`,
    lastReceivedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    rotatedAt: r.rotated_at ? r.rotated_at.toISOString() : null,
  });

/** A live provider endpoint the caller may see (a lead of its team or an admin: row-level security), or a 404. */
async function visibleEndpoint(tx: PluginTx, id: string): Promise<EndpointRow> {
  const row = (await tx.query<EndpointRow>(`${SELECT} WHERE w.id = $1::uuid AND w.kind = 'provider' AND w.revoked_at IS NULL`, [id])).rows[0];
  if (!row) throw notFound('No such address');
  return row;
}

const can = async (tx: PluginTx, channelId: string, level: 'manage' | 'read'): Promise<boolean> =>
  (await tx.query<{ ok: boolean }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, level])).rows[0]?.ok === true;

/** The Postgres "unique violation" for the short name or the display name, put into a sentence. */
function taken(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'webhook_provider_slug') throw conflict('Another address of this team already uses that short name. Pick another one.');
  if (e.code === '23505' && e.constraint === 'webhooks_channel_name') throw conflict('This channel already has an integration with that name. Pick another name.');
  throw err;
}

export function registerProviderRoutes(ctx: PluginContext): void {
  const announce = (tx: PluginTx, row: EndpointRow, change: 'created' | 'rotated' | 'secret_set' | 'revoked'): Promise<void> =>
    ctx.audit.emit(
      tx,
      WebhooksProviderEndpointChangedEvent.parse({
        type: 'webhooks.provider_endpoint.changed',
        schemaVersion: 1,
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        channelId: row.channel_id,
        webhookId: row.id,
        provider: row.provider,
        change,
        actorId: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      }),
    );

  /** Seals `plaintext` as the endpoint's signing secret and drops the old one (system transaction). */
  const seal = (row: { id: string; workspace_id: string }, plaintext: string, rotated: boolean): Promise<void> =>
    ctx.db.system(
      async (sys) => {
        const old = (await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhook_provider WHERE webhook_id = $1::uuid FOR UPDATE', [row.id])).rows[0];
        if (!old) throw notFound('No such address');
        const id = await ctx.secrets.put(sys, plaintext);
        await sys.query(`UPDATE app.webhook_provider SET signing_secret_id = $2::uuid, rotated_at = CASE WHEN $3::boolean THEN now() ELSE rotated_at END WHERE webhook_id = $1::uuid`, [row.id, id, rotated]);
        await sys.query('UPDATE app.webhooks SET signed = true WHERE id = $1::uuid', [row.id]);
        if (old.signing_secret_id) await ctx.secrets.delete(sys, old.signing_secret_id);
      },
      { workspaceId: row.workspace_id },
    );

  ctx.http.route({
    ...listProviderHooksRoute,
    schema: { response: ListProviderHooksResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ProviderHookChannelParams.parse(req.params);
      if (!(await can(tx, channelId, 'manage'))) throw forbidden('Only a lead of this channel’s team or a workspace admin can see its work app addresses');
      const rows = (await tx.query<EndpointRow>(`${SELECT} WHERE w.channel_id = $1::uuid AND w.kind = 'provider' AND w.revoked_at IS NULL ORDER BY w.created_at, w.id`, [channelId])).rows;
      return json(ListProviderHooksResponse.parse({ endpoints: rows.map(toEndpoint) }));
    }),
  });

  ctx.http.route({
    ...createProviderHookRoute,
    schema: { body: CreateProviderHookRequest, response: CreateProviderHookResponse },
    rateLimit: abuseLimit('POST', createProviderHookRoute.path),
    handler: route(async (req, tx) => {
      const { channelId } = ProviderHookChannelParams.parse(req.params);
      const body = CreateProviderHookRequest.parse(req.body);
      if (!(await can(tx, channelId, 'manage'))) throw forbidden('Only a lead of this channel’s team or a workspace admin can make an address for a work app');
      if (!(await can(tx, channelId, 'read'))) throw forbidden('You can only make an address for a channel you can read yourself, because the bots that answer post into it. Join the channel first.');
      if (body.provider === 'asana' && body.signingSecret !== undefined) throw invalid('Asana makes its own secret when you connect the address. Leave the secret empty.');
      let name = (body.name ?? LABELS[body.provider]).trim();
      if ([...name].length > 60) throw invalid('Use a name of at most 60 characters.');
      // A name left to us is made unique in the channel by adding the short name ("GitHub (github-ci)"); a name the lead chose is theirs and a clash is told.
      if (body.name === undefined) {
        const clash = await tx.query('SELECT 1 FROM app.webhooks WHERE channel_id = $1::uuid AND revoked_at IS NULL AND lower(name) = lower($2) LIMIT 1', [channelId, name]);
        if (clash.rows.length > 0) name = `${name} (${body.slug})`.slice(0, 60);
      }
      // The secret: yours when you pasted one, else ours for an app that takes one from us (shown once), else none yet.
      const plaintext = body.signingSecret ?? (body.provider === 'asana' || PASTED.has(body.provider) ? null : newSigningSecret());
      const shown = body.signingSecret === undefined ? plaintext : null;
      const person = (await tx.query<{ display_name: string | null }>('SELECT p.display_name FROM app.people p WHERE p.id = app.person_id()')).rows[0]?.display_name ?? null;
      const actorId = tx.actor.id;
      // The caller was checked above (lead or admin, can read the channel). The make itself runs in a system transaction so that the sealed secret can be attached to the
      // row in the same step; the function keeps its own limits (20 integrations a channel, an archived channel).
      const id = await ctx
        .db.system(
          async (sys) => {
            const made = await sys.query<{ id: string }>('SELECT app.integrations_create_provider($1::uuid, $2, NULL, $3, $4, $5::text[]) AS id', [channelId, name, body.provider, body.slug, body.eventFilter]);
            const newId = made.rows[0]?.id;
            if (!newId) throw new Error('the endpoint make answered no row');
            // a system transaction has no person behind it, so the function leaves the maker empty (migration 0005) and the caller, checked above, is named here
            await sys.query('UPDATE app.webhooks SET created_by = $2::uuid, created_by_name = $3 WHERE id = $1::uuid', [newId, actorId, person === null ? null : person.slice(0, 200)]);
            if (plaintext !== null) {
              const sealed = await ctx.secrets.put(sys, plaintext);
              await sys.query('UPDATE app.webhook_provider SET signing_secret_id = $2::uuid WHERE webhook_id = $1::uuid', [newId, sealed]);
              await sys.query('UPDATE app.webhooks SET signed = true WHERE id = $1::uuid', [newId]);
            }
            return newId;
          },
          { workspaceId: tx.actor.workspaceId },
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === 'check_violation' || code === '23514') throw conflict((err as Error).message);
          if (code === 'P0002') throw notFound('No such channel');
          return taken(err);
        });
      const row = await visibleEndpoint(tx, id);
      await announce(tx, row, 'created');
      return json(CreateProviderHookResponse.parse({ endpoint: toEndpoint(row), signingSecret: shown }), 201);
    }),
  });

  ctx.http.route({
    ...updateProviderHookRoute,
    schema: { body: UpdateProviderHookRequest, response: UpdateProviderHookResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { endpointId } = ProviderHookPathParams.parse(req.params);
      const body = UpdateProviderHookRequest.parse(req.body);
      const row = await visibleEndpoint(tx, endpointId);
      if (body.name !== undefined && [...body.name].length > 60) throw invalid('Use a name of at most 60 characters.');
      await ctx.db
        .system(
          async (sys) => {
            if (body.name !== undefined) await sys.query('UPDATE app.webhooks SET name = $2 WHERE id = $1::uuid', [endpointId, body.name]);
            if (body.eventFilter !== undefined) await sys.query('UPDATE app.webhook_provider SET event_filter = $2::text[] WHERE webhook_id = $1::uuid', [endpointId, body.eventFilter]);
          },
          { workspaceId: row.workspace_id },
        )
        .catch(taken);
      return json(UpdateProviderHookResponse.parse({ endpoint: toEndpoint(await visibleEndpoint(tx, endpointId)) }));
    }),
  });

  ctx.http.route({
    ...deleteProviderHookRoute,
    schema: { response: DeleteProviderHookResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { endpointId } = ProviderHookPathParams.parse(req.params);
      const row = await visibleEndpoint(tx, endpointId);
      // Only a lead of the channel's team or an admin sees the row (row-level security) and the check below repeats it. The switch-off and the sealed secret's removal then happen in ONE system
      // transaction: done from the caller's, the secret's delete would wait for the caller's own uncommitted change to the row that points at it.
      if (!(await can(tx, row.channel_id, 'manage'))) throw forbidden('Only a lead of this channel’s team or a workspace admin can switch off a work app address');
      await ctx.db.system(
        async (sys) => {
          const gone = await sys.query<{ signing_secret_id: string | null }>('SELECT signing_secret_id FROM app.webhooks_revoke($1::uuid)', [endpointId]).catch((err: unknown) => {
            if ((err as { code?: string }).code === 'P0002') throw notFound('No such address');
            throw err;
          });
          const sealed = gone.rows[0]?.signing_secret_id ?? null;
          if (sealed) await ctx.secrets.delete(sys, sealed);
        },
        { workspaceId: row.workspace_id },
      );
      await announce(tx, row, 'revoked');
      return json(DeleteProviderHookResponse.parse({ revoked: true }));
    }),
  });

  ctx.http.route({
    ...putProviderSigningSecretRoute,
    schema: { body: PutProviderSigningSecretRequest, response: PutProviderSigningSecretResponse },
    rateLimit: abuseLimit('PUT', putProviderSigningSecretRoute.path),
    handler: route(async (req, tx) => {
      const { endpointId } = ProviderHookPathParams.parse(req.params);
      const body = PutProviderSigningSecretRequest.parse(req.body);
      const row = await visibleEndpoint(tx, endpointId);
      if (row.provider === 'asana') throw conflict('Asana makes its own secret when you connect the address. Connect it again in Asana instead.');
      await seal(row, body.signingSecret, false);
      await announce(tx, row, 'secret_set');
      return json(PutProviderSigningSecretResponse.parse({ endpoint: toEndpoint(await visibleEndpoint(tx, endpointId)) }));
    }),
  });

  ctx.http.route({
    ...rotateProviderHookRoute,
    schema: { response: RotateProviderHookResponse },
    rateLimit: abuseLimit('POST', rotateProviderHookRoute.path),
    handler: route(async (req, tx) => {
      const { endpointId } = ProviderHookPathParams.parse(req.params);
      const row = await visibleEndpoint(tx, endpointId);
      if (row.provider === 'asana') throw conflict('Asana makes its own secret. To get a new one, make a new address and connect that.');
      if (secretSourceOf(row.provider) === 'pasted') throw conflict(`${LABELS[row.provider]} gives you the secret. Paste the new one instead.`);
      const plaintext = newSigningSecret();
      await seal(row, plaintext, true);
      await announce(tx, row, 'rotated');
      return json(RotateProviderHookResponse.parse({ endpoint: toEndpoint(await visibleEndpoint(tx, endpointId)), signingSecret: plaintext }));
    }),
  });

  // Admin page, Connectors tab (D31): one row per app that has addresses, from this plugin's own tables. Refused counts come from the audit trail when the audit plugin is loaded.
  ctx.http.route({
    ...providerEndpointsHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const role = (await tx.query<{ role: string | null }>('SELECT app.lookup_workspace_role() AS role')).rows[0]?.role ?? null;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace admin can see how the work app addresses are doing');
      const workspaceId = tx.actor.workspaceId;
      const rows = await ctx.db.system(
        async (sys) => {
          const live = await sys.query<{ provider: string; endpoints: string; without_secret: string; last: Date | null }>(
            `SELECT p.provider, count(*)::text AS endpoints, count(*) FILTER (WHERE p.signing_secret_id IS NULL)::text AS without_secret, max(w.last_used_at) AS last
               FROM app.webhook_provider p JOIN app.webhooks w ON w.id = p.webhook_id
              WHERE p.workspace_id = $1::uuid AND p.live AND w.revoked_at IS NULL GROUP BY p.provider`,
            [workspaceId],
          );
          const received = await sys.query<{ provider: string; n: string }>(
            `SELECT provider, count(*)::text AS n FROM app.webhook_provider_events WHERE workspace_id = $1::uuid AND received_at > now() - interval '7 days' GROUP BY provider`,
            [workspaceId],
          );
          const refused: Record<string, Record<string, number>> = {};
          const table = await sys.query<{ present: boolean }>("SELECT to_regclass('app.audit_events') IS NOT NULL AS present");
          if (table.rows[0]?.present === true) {
            const audit = await sys.query<{ provider: string | null; phrase: string; n: string }>(
              `SELECT target_label AS provider, split_part(reason, ',', 1) AS phrase, coalesce(sum(((regexp_match(reason, ', ([0-9]+) time'))[1])::int), count(*))::text AS n
                 FROM app.audit_events WHERE workspace_id = $1::uuid AND action = 'webhook.provider_event_refused' AND occurred_at > now() - interval '7 days' GROUP BY 1, 2`,
              [workspaceId],
            );
            const byPhrase: Record<string, string> = { 'Wrong signature': 'bad_signature', 'Too old': 'stale', 'Sent twice': 'replayed', 'Too large': 'too_large', 'No such address': 'unknown_endpoint', 'The bot was too busy': 'bot_busy' };
            for (const a of audit.rows) {
              const reason = byPhrase[a.phrase] ?? 'other';
              const provider = a.provider ?? 'unknown';
              const bucket = (refused[provider] ??= {});
              bucket[reason] = (bucket[reason] ?? 0) + Number(a.n);
            }
          }
          return { live: live.rows, received: received.rows, refused };
        },
        { workspaceId },
      );
      const count = new Map(rows.received.map((r) => [r.provider, Number(r.n)]));
      const out = rows.live.map((r) => {
        const refused = rows.refused[r.provider] ?? {};
        const failures = Object.values(refused).reduce((a, b) => a + b, 0);
        const missing = Number(r.without_secret);
        return ConnectorHealthRow.parse({
          connector: r.provider,
          area: 'webhooks',
          people: 0,
          shared: Number(r.endpoints),
          needsReconnect: missing,
          calls7d: (count.get(r.provider) ?? 0) + failures,
          failures7d: failures,
          refused7d: refused,
          lastUsedAt: r.last ? r.last.toISOString() : null,
          problem: missing > 0 ? `${missing === 1 ? 'An address has' : `${missing} addresses have`} no signing secret yet, so every call to ${missing === 1 ? 'it is' : 'them are'} turned away.` : null,
        });
      });
      return json(ListConnectorHealthResponse.parse({ rows: out }));
    }),
  });
}
