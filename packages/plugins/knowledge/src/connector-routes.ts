import { HttpError, conflict, forbidden, invalid, json, notFound, requireManage, requireTeam, route, type ConnectorCaller, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AddKnowledgeConnectorSourceRequest,
  AddKnowledgeConnectorSourceResponse,
  CONNECTOR_SOURCE_CONNECTOR,
  DeletePersonalKnowledgeSourceResponse,
  KnowledgeConnectorPersonalParams,
  KnowledgeConnectorProvider,
  KnowledgeConnectorTeamParams,
  ListConnectorHealthResponse,
  ListConnectorProvidersResponse,
  ListConnectorRootsQuery,
  ListConnectorRootsResponse,
  PersonalKnowledgeSourceParams,
  addKnowledgeConnectorSourceRoute,
  addPersonalKnowledgeConnectorSourceRoute,
  connectorEntry,
  connectorSourcesHealthRoute,
  deletePersonalKnowledgeSourceRoute,
  listConnectorProvidersRoute,
  listConnectorRootsRoute,
  type ConnectorHealthRow,
} from '@manythreads/shared';
import { documentsDoorOf, enqueueConnectorPass } from './connector-sync.ts';
import { SOURCE_COLUMNS, providerLabel, toSource, type SourceRow } from './rows.ts';

// Work package D2 (P16-08): adding a connector source to a team base (a lead or admin, with their own connection) or to a Personal base (its owner), the folders a person can pick, which
// services they have connected, and the admin's health rows. Removing, pausing and changing the rhythm of a source use the routes every source already has (a Personal source is removed
// here, because the Personal routes had none). docs/plugins/knowledge.md "Documents from connected apps".
//
//  * The folder list and the first look at a folder ride on the CALLER's own connection (`connector.documents`, which uses nobody else's). A route holds its transaction while the
//    connections plugin asks the service (it opens a transaction of its own and never waits inside this one); both are bounded by the door's own timeouts and the routes' rate limits.
//  * A source is only ever made with the caller's own grant: `granted_by` is the caller, and a team source says so on screen.

/** The service of the person's connection each reader needs (the catalog's service ids), to say which providers a person may offer. */
const SERVICE: Readonly<Record<KnowledgeConnectorProvider, string>> = {
  google_drive: 'drive',
  onedrive: 'onedrive',
  sharepoint: 'sharepoint',
  notion: 'notion',
  confluence: 'pages',
  dropbox: 'files',
  box: 'files',
};
/** Services whose permission is not a scope the sign-in can be compared with (the app fixes what a grant may read). */
const SCOPE_FREE: ReadonlySet<KnowledgeConnectorProvider> = new Set(['notion', 'box']);
const PROVIDERS = KnowledgeConnectorProvider.options;

interface Me {
  personId: string;
  workspaceId: string;
}

/** Who is asking: an active member (a guest has no connections of their own to read documents with, and no Personal space). */
async function requireMe(tx: PluginTx): Promise<Me> {
  const row = (await tx.query<{ person_id: string | null; role: string | null }>('SELECT app.person_id() AS person_id, app.workspace_role() AS role')).rows[0];
  if (!row?.person_id) throw forbidden('Only a person can read documents from a connected app.');
  if (row.role === 'guest') throw forbidden('A guest cannot read documents from a connected app.');
  return { personId: row.person_id, workspaceId: tx.actor.workspaceId };
}

const tableExists = async (tx: PluginTx, table: string): Promise<boolean> => (await tx.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [table])).rows[0]?.ok === true;

const connectFirst = (provider: KnowledgeConnectorProvider): HttpError =>
  conflict(`Connect ${providerLabel(provider)} first: Settings, Connections. Then come back and add the folder.`);

/** The caller's usable connections and the scopes each holds, by catalog id. Read under the caller's own row-level security (a person reads their own). */
async function ownConnections(tx: PluginTx): Promise<Map<string, { id: string; scopes: string[] }>> {
  const out = new Map<string, { id: string; scopes: string[] }>();
  if (!(await tableExists(tx, 'app.connections')) || !(await tableExists(tx, 'app.connection_oauth'))) return out;
  const rows = (
    await tx.query<{ id: string; slug: string; scopes: string[] }>(
      `SELECT c.id, c.slug, o.scopes
         FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
        WHERE c.scope = 'person' AND c.owner_id = app.actor() AND c.status = 'enabled' AND c.has_credentials
          AND (c.expires_at IS NULL OR c.expires_at > now()) AND o.state = 'ok'`,
    )
  ).rows;
  for (const r of rows) out.set(r.slug, { id: r.id, scopes: r.scopes });
  return out;
}

/** True when the connection holds the permission to read documents of this provider. */
function canRead(connections: Map<string, { id: string; scopes: string[] }>, provider: KnowledgeConnectorProvider): boolean {
  const slug = CONNECTOR_SOURCE_CONNECTOR[provider];
  const held = connections.get(slug);
  if (!held) return false;
  if (SCOPE_FREE.has(provider)) return true;
  const service = connectorEntry(slug)?.services.find((s) => s.id === SERVICE[provider]);
  return service !== undefined && service.scopes.every((scope) => held.scopes.includes(scope));
}

export function registerConnectorRoutes(ctx: PluginContext): void {
  const doorOrDown = (): NonNullable<ReturnType<typeof documentsDoorOf>> => {
    const door = documentsDoorOf(ctx);
    if (!door) throw new HttpError(503, 'internal', 'Connected apps are not available on this server right now.');
    return door;
  };

  /** Checks the folder is one the caller's own connection can open and names it; then makes the source and starts the first read. */
  async function addSource(tx: PluginTx, me: Me, base: { id: string }, scope: { teamId: string } | { ownerPersonId: string }, body: AddKnowledgeConnectorSourceRequest): Promise<SourceRow> {
    const connections = await ownConnections(tx);
    if (!canRead(connections, body.provider)) throw connectFirst(body.provider);
    const caller: ConnectorCaller & { provider: KnowledgeConnectorProvider } = { workspaceId: me.workspaceId, personId: me.personId, provider: body.provider };
    const listed = await doorOrDown().listRoots(tx, caller);
    if (!listed.ok) {
      if (listed.code === 'not_connected' || listed.code === 'scope_missing') throw connectFirst(body.provider);
      throw new HttpError(503, 'internal', `${providerLabel(body.provider)} did not answer. Try again in a minute.`);
    }
    const root = listed.value.find((r) => r.id === body.root);
    if (!root) throw invalid(`That is not a folder your ${providerLabel(body.provider)} connection can open.`);
    const taken = await tx.query('SELECT 1 FROM app.knowledge_sources WHERE base_id = $1 AND kind = $2 AND provider = $3 AND remote_root = $4', [base.id, 'connector', body.provider, body.root]);
    if (taken.rows.length > 0) throw conflict('This base already reads that folder.');
    const connectionId = connections.get(CONNECTOR_SOURCE_CONNECTOR[body.provider])?.id ?? null;
    const label = (body.label ?? root.name).trim().slice(0, 120) || providerLabel(body.provider);
    const made = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_sources (base_id, team_id, owner_person_id, kind, provider, connection_id, granted_by, remote_root, label, sync_minutes)
         VALUES ($1, $2, $3, 'connector', $4, $5, $6, $7, $8, $9) RETURNING id`,
        [base.id, 'teamId' in scope ? scope.teamId : null, 'ownerPersonId' in scope ? scope.ownerPersonId : null, body.provider, connectionId, me.personId, body.root, label, body.syncMinutes],
      )
    ).rows[0] as { id: string };
    // the first read starts at once (a full read of the folder), off this request
    await enqueueConnectorPass(ctx, tx, me.workspaceId, made.id, 'force');
    return (await tx.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM app.knowledge_sources s WHERE s.id = $1`, [made.id])).rows[0] as SourceRow;
  }

  ctx.http.route({
    ...addKnowledgeConnectorSourceRoute,
    schema: { body: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeConnectorTeamParams.parse(req.params);
      const body = AddKnowledgeConnectorSourceRequest.parse(req.body);
      const me = await requireMe(tx);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      if (team.archived_at) throw conflict('This team is archived, so its knowledge cannot be changed.');
      const teamName = (await tx.query<{ name: string }>('SELECT name FROM app.teams WHERE id = $1', [team.id])).rows[0]?.name ?? 'the team';
      const base = (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_bases WHERE team_id = $1 AND slug = $2', [team.id, params.base])).rows[0];
      if (!base) throw notFound(`${teamName} has no knowledge base called “${params.base}”.`);
      // the consent sentence of the dialog: what is copied and what is not
      if (!body.acknowledgeTeamRule) throw invalid(`Confirm that documents everyone on ${teamName} can already open will be copied into this base. Others stay with the people who can open them.`);
      const made = await addSource(tx, me, base, { teamId: team.id }, body);
      return json({ source: toSource(made) }, 201);
    }),
  });

  ctx.http.route({
    ...addPersonalKnowledgeConnectorSourceRoute,
    schema: { body: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeConnectorPersonalParams.parse(req.params);
      const body = AddKnowledgeConnectorSourceRequest.parse(req.body);
      const me = await requireMe(tx);
      const base = (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_bases WHERE owner_person_id = $1 AND slug = $2', [me.personId, params.base])).rows[0];
      if (!base) throw notFound(`You have no knowledge base called “${params.base}”.`);
      const made = await addSource(tx, me, base, { ownerPersonId: me.personId }, body);
      return json({ source: toSource(made) }, 201);
    }),
  });

  ctx.http.route({
    ...deletePersonalKnowledgeSourceRoute,
    schema: { response: DeletePersonalKnowledgeSourceResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = PersonalKnowledgeSourceParams.parse(req.params);
      const me = await requireMe(tx);
      const base = (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_bases WHERE owner_person_id = $1 AND slug = $2', [me.personId, params.base])).rows[0];
      if (!base) throw notFound(`You have no knowledge base called “${params.base}”.`);
      const source = (await tx.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM app.knowledge_sources s WHERE s.base_id = $1 AND s.id = $2`, [base.id, params.sourceId])).rows[0];
      if (!source) throw notFound('That source is not in this knowledge base.');
      if (source.kind !== 'url' && source.kind !== 'connector') throw conflict('Only a web-page source or a source from a connected app can be removed; uploads are part of every base.');
      const removed = (await tx.query<{ id: string }>('DELETE FROM app.knowledge_documents WHERE source_id = $1 RETURNING id', [source.id])).rows.length;
      await tx.query('DELETE FROM app.knowledge_sources WHERE id = $1', [source.id]);
      const left = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.knowledge_documents WHERE base_id = $1', [base.id])).rows[0]?.n ?? 0;
      await ctx.audit.emit(tx, { type: 'knowledge.personal_base.changed', workspaceId: me.workspaceId, personId: me.personId, baseId: base.id, change: 'document_removed', documents: left, at: ctx.runtime.now().toISOString() });
      return json({ removed: true, documents: removed });
    }),
  });

  ctx.http.route({
    ...listConnectorRootsRoute,
    schema: { query: ListConnectorRootsQuery, response: ListConnectorRootsResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const query = ListConnectorRootsQuery.parse(req.query);
      const me = await requireMe(tx);
      // `parent` is accepted for the day a reader can list inside a root; the readers list the roots a person can pick, so it changes nothing yet
      const connections = await ownConnections(tx);
      if (!canRead(connections, query.provider)) return json({ roots: [], connected: false });
      const listed = await doorOrDown().listRoots(tx, { workspaceId: me.workspaceId, personId: me.personId, provider: query.provider });
      if (!listed.ok) {
        if (listed.code === 'not_connected' || listed.code === 'scope_missing') return json({ roots: [], connected: false });
        throw new HttpError(503, 'internal', `${providerLabel(query.provider)} did not answer. Try again in a minute.`);
      }
      return json({ roots: listed.value.slice(0, 200), connected: true });
    }),
  });

  ctx.http.route({
    ...listConnectorProvidersRoute,
    schema: { response: ListConnectorProvidersResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await requireMe(tx);
      const connections = await ownConnections(tx);
      return json({ providers: PROVIDERS.filter((p) => canRead(connections, p)) });
    }),
  });

  ctx.http.route({
    ...connectorSourcesHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can see how connected apps are used.');
      // Counts across every base of the workspace, Personal ones included: no name, no text, no person (a Personal base is otherwise closed to an admin). System role, as the connections admin page.
      const workspaceId = tx.actor.workspaceId;
      const rows = await ctx.db.system(
        async (sys) =>
          (
            await sys.query<{ provider: string; sources: number; people: number; shared: number; paused: number; attention: number; read7d: number; failed7d: number; limited: number; last: Date | null }>(
              `SELECT s.provider,
                      count(*)::int AS sources,
                      count(DISTINCT s.granted_by)::int AS people,
                      count(*) FILTER (WHERE s.team_id IS NOT NULL)::int AS shared,
                      count(*) FILTER (WHERE s.status = 'paused')::int AS paused,
                      count(*) FILTER (WHERE s.status = 'attention')::int AS attention,
                      count(*) FILTER (WHERE s.last_synced_at >= now() - interval '7 days')::int AS read7d,
                      count(*) FILTER (WHERE s.last_synced_at >= now() - interval '7 days' AND s.status <> 'ready')::int AS failed7d,
                      coalesce(sum(s.skipped_limited), 0)::int AS limited,
                      max(s.last_synced_at) AS last
                 FROM app.knowledge_sources s JOIN app.knowledge_bases b ON b.id = s.base_id
                WHERE s.kind = 'connector' AND b.workspace_id = $1 GROUP BY s.provider`,
              [workspaceId],
            )
          ).rows,
        { workspaceId },
      );
      const out = rows.map((r): ConnectorHealthRow => {
        const problem =
          r.paused > 0
            ? `${String(r.paused)} ${r.paused === 1 ? 'source is' : 'sources are'} paused because a sign-in is gone.`
            : r.attention > 0
              ? `${String(r.attention)} ${r.attention === 1 ? 'source' : 'sources'} could not be read at the last pass.`
              : null;
        return {
          connector: r.provider,
          area: 'knowledge',
          people: r.people,
          shared: r.shared,
          needsReconnect: r.paused,
          // sources read in the last seven days, and how many of them did not end well: there is no log of passes to count calls from
          calls7d: r.read7d,
          failures7d: r.failed7d,
          refused7d: r.limited > 0 ? { not_everyone_on_team: r.limited } : {},
          lastUsedAt: r.last ? r.last.toISOString() : null,
          problem,
        };
      });
      out.sort((a, b) => b.people + b.shared - (a.people + a.shared) || a.connector.localeCompare(b.connector));
      return json({ rows: out.slice(0, 100) });
    }),
  });
}
