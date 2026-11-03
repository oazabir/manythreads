import { randomUUID } from 'node:crypto';
import { conflict, forbidden, invalid, json, notFound, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CONNECTION_ADMIN_ONLY,
  ConnectionCredentialPathParams,
  ConnectionPathParams,
  ConnectionsTeamParams,
  CreateConnectionRequest,
  CreateConnectionResponse,
  DeleteConnectionResponse,
  DeliverMailParams,
  DeliverMailRequest,
  DeliverMailResponse,
  ListConnectionsResponse,
  PutConnectionCredentialRequest,
  PutConnectionCredentialResponse,
  UpdateConnectionRequest,
  UpdateConnectionResponse,
  abuseLimit,
  connectionKindInfo,
  createConnectionRoute,
  deleteConnectionRoute,
  deliverMailRoute,
  listConnectionsRoute,
  listMyConnectionsRoute,
  putConnectionCredentialRoute,
  updateConnectionRoute,
} from '@manythreads/shared';
import { revocableToken, revokeAtProvider, type OAuthDeps } from './oauth/store.ts';
import { CONNECTION_COLUMNS, toConnection, type ConnectionRow } from './rows.ts';
import { deleteConnectionAndSecrets, putConnectionSecret } from './secrets.ts';
import { WATCH_QUEUE } from './watch.ts';

// The routes of connections (PLAN P8-28, P8-06). Reading: the connections of a team, and a person's own, as the caller's row-level security lets them see them. Writing: a
// workspace admin adds a team's connection (switched off, nothing stored), puts a credential in, switches it on and off, and removes it; a person removes their own.
// The answer is always the strict `Connection` shape, which has no field for a credential; no route gives one back. Every change leaves one audit line (kind of
// change, ids, short name; never a credential or a display name) through the `connections.connection.changed` event.

const READ_LIMIT = { limit: 120, windowMs: 60_000 };

type Change = 'created' | 'updated' | 'switched' | 'credential_set' | 'deleted';

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden(CONNECTION_ADMIN_ONLY);
}

/** A connection as the caller sees it, or 404 (a connection the caller cannot see answers the same as one that is not there). */
async function loadConnection(tx: PluginTx, id: string): Promise<ConnectionRow> {
  const row = (await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.connections c WHERE c.id = $1::uuid`, [id])).rows[0];
  if (!row) throw notFound('No such connection');
  return row;
}

/** Changing a team's or the workspace's connection takes a workspace admin; a person's own is the owner's (the database lets nobody else see it). */
async function requireMayChange(tx: PluginTx, row: ConnectionRow): Promise<void> {
  if (row.scope === 'person') {
    if (row.owner_id !== tx.actor.id) throw forbidden();
    return;
  }
  await requireWorkspaceAdmin(tx);
}

/** Why a connection with nothing stored is not switched on. */
export const CREDENTIAL_FIRST = 'Put the credential in first: a connection with nothing stored cannot be switched on.';

/**
 * Switches a team's connection on, as the route does for `PATCH { status: 'enabled' }`: a workspace admin's act, refused until a credential is stored, one audit line
 * (`switched`). The Deploy action (deploy.ts) calls it; a connection that is already on is returned as it is.
 */
export async function enableConnection(ctx: PluginContext, tx: PluginTx, current: ConnectionRow): Promise<ConnectionRow> {
  await requireMayChange(tx, current);
  if (current.status === 'enabled') return current;
  if (!current.has_credentials) throw conflict(CREDENTIAL_FIRST);
  const updated = await tx.query<ConnectionRow>(`UPDATE app.connections c SET status = 'enabled', updated_at = now() WHERE c.id = $1::uuid RETURNING ${CONNECTION_COLUMNS}`, [current.id]);
  const row = updated.rows[0];
  if (!row) throw forbidden();
  await audit(ctx, tx, row, 'switched');
  return row;
}

const slugFromName = (name: string): string => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base === '' ? 'connection' : base;
};

async function freeSlug(tx: PluginTx, teamId: string, name: string): Promise<string> {
  const base = slugFromName(name);
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : `${base}-${String(n)}`;
    const taken = await tx.query("SELECT 1 FROM app.connections WHERE scope = 'team' AND team_id = $1::uuid AND slug = $2", [teamId, candidate]);
    if (taken.rows.length === 0) return candidate;
  }
  throw conflict('Too many connections with a similar name. Pick a different name.');
}

async function audit(ctx: PluginContext, tx: PluginTx, row: ConnectionRow, change: Change): Promise<void> {
  await ctx.audit.emit(tx, {
    type: 'connections.connection.changed',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    connectionId: row.id,
    slug: row.slug,
    kind: row.kind,
    scope: row.scope,
    change,
    actorId: tx.actor.id,
    at: now(ctx),
  });
}

export function registerRoutes(ctx: PluginContext, oauth: OAuthDeps): void {
  ctx.http.route({
    ...listConnectionsRoute,
    schema: { response: ListConnectionsResponse },
    rateLimit: READ_LIMIT,
    handler: route(async (req, tx) => {
      const { slug } = ConnectionsTeamParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM app.connections c WHERE c.scope = 'team' AND c.team_id = $1 ORDER BY lower(c.name), c.id`,
        [team.id],
      );
      return json({ connections: rows.rows.map(toConnection) });
    }),
  });

  ctx.http.route({
    ...listMyConnectionsRoute,
    schema: { response: ListConnectionsResponse },
    rateLimit: READ_LIMIT,
    handler: route(async (_req, tx) => {
      const rows = await tx.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM app.connections c WHERE c.scope = 'person' AND c.owner_id = $1::uuid ORDER BY lower(c.name), c.id`,
        [tx.actor.id],
      );
      return json({ connections: rows.rows.map(toConnection) });
    }),
  });

  ctx.http.route({
    ...createConnectionRoute,
    schema: { body: CreateConnectionRequest, response: CreateConnectionResponse },
    rateLimit: abuseLimit(createConnectionRoute.method, createConnectionRoute.path),
    handler: route(async (req, tx) => {
      const { slug: teamSlug } = ConnectionsTeamParams.parse(req.params);
      const body = CreateConnectionRequest.parse(req.body);
      await requireWorkspaceAdmin(tx);
      const team = await requireTeam(tx, teamSlug);
      const info = connectionKindInfo(body.kind);
      if (!info) throw invalid('That kind of connection does not exist.');
      if (!info.available) throw conflict(info.unavailableReason ?? 'That kind of connection is not available yet.');
      if (!info.scopes.includes('team')) throw invalid('A team cannot have a connection of that kind.');
      let slug = body.slug;
      if (slug !== undefined) {
        const taken = await tx.query("SELECT 1 FROM app.connections WHERE scope = 'team' AND team_id = $1::uuid AND slug = $2", [team.id, slug]);
        if (taken.rows.length > 0) throw conflict('A connection with that short name already exists on this team. Short names are used in bot files, so pick a different one.');
      } else {
        slug = await freeSlug(tx, team.id, body.name);
      }
      const inserted = await tx.query<ConnectionRow>(
        `INSERT INTO app.connections AS c (workspace_id, team_id, slug, kind, name, scope, owner_id, environment, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'team', $6::uuid, $7, $8::timestamptz)
         RETURNING ${CONNECTION_COLUMNS}`,
        [tx.actor.workspaceId, team.id, slug, body.kind, body.name, tx.actor.id, body.environment ?? 'production', body.expiresAt ?? null],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('the connection insert answered no row');
      await audit(ctx, tx, row, 'created');
      return json(CreateConnectionResponse.parse({ connection: toConnection(row) }), 201);
    }),
  });

  ctx.http.route({
    ...updateConnectionRoute,
    schema: { body: UpdateConnectionRequest, response: UpdateConnectionResponse },
    rateLimit: abuseLimit(updateConnectionRoute.method, updateConnectionRoute.path),
    handler: route(async (req, tx) => {
      const { id } = ConnectionPathParams.parse(req.params);
      const body = UpdateConnectionRequest.parse(req.body);
      const current = await loadConnection(tx, id);
      await requireMayChange(tx, current);
      if (body.status === 'enabled' && current.status !== 'enabled' && !current.has_credentials) {
        throw conflict(CREDENTIAL_FIRST);
      }
      const sets: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown, cast = ''): void => {
        values.push(value);
        sets.push(`${column} = $${String(values.length)}${cast}`);
      };
      const detailsChanged =
        (body.name !== undefined && body.name !== current.name) ||
        (body.environment !== undefined && body.environment !== current.environment) ||
        (body.expiresAt !== undefined && (body.expiresAt === null ? current.expires_at !== null : current.expires_at?.toISOString() !== new Date(body.expiresAt).toISOString()));
      const switched = body.status !== undefined && body.status !== current.status;
      if (body.name !== undefined) set('name', body.name);
      if (body.environment !== undefined) set('environment', body.environment);
      if (body.expiresAt !== undefined) set('expires_at', body.expiresAt, '::timestamptz');
      if (body.status !== undefined) set('status', body.status);
      if (sets.length === 0) return json(UpdateConnectionResponse.parse({ connection: toConnection(current) }));
      const updated = await tx.query<ConnectionRow>(`UPDATE app.connections c SET ${sets.join(', ')}, updated_at = now() WHERE c.id = $1::uuid RETURNING ${CONNECTION_COLUMNS}`, values);
      const row = updated.rows[0];
      if (!row) throw forbidden();
      if (detailsChanged) await audit(ctx, tx, row, 'updated');
      if (switched) await audit(ctx, tx, row, 'switched');
      return json(UpdateConnectionResponse.parse({ connection: toConnection(row) }));
    }),
  });

  ctx.http.route({
    ...putConnectionCredentialRoute,
    schema: { body: PutConnectionCredentialRequest, response: PutConnectionCredentialResponse },
    rateLimit: abuseLimit(putConnectionCredentialRoute.method, putConnectionCredentialRoute.path),
    handler: route(async (req, tx) => {
      const { id, name } = ConnectionCredentialPathParams.parse(req.params);
      const body = PutConnectionCredentialRequest.parse(req.body);
      const current = await loadConnection(tx, id);
      await requireMayChange(tx, current);
      const info = connectionKindInfo(current.kind);
      if (!info?.credentials.some((c) => c.name === name)) throw invalid('This kind of connection has no credential with that name.');
      // The audit line first: if the sealing fails, the request rolls back and no line is left for a change that did not happen. The value goes nowhere but the sealer.
      await audit(ctx, tx, current, 'credential_set');
      await putConnectionSecret(
        { db: ctx.db, secrets: ctx.secrets },
        { workspaceId: current.workspace_id, connectionId: current.id, name, plaintext: body.value },
      );
      return json(PutConnectionCredentialResponse.parse({ connection: toConnection(await loadConnection(tx, id)) }));
    }),
  });

  ctx.http.route({
    ...deleteConnectionRoute,
    schema: { response: DeleteConnectionResponse },
    rateLimit: abuseLimit(deleteConnectionRoute.method, deleteConnectionRoute.path),
    handler: route(async (req, tx) => {
      const { id } = ConnectionPathParams.parse(req.params);
      const current = await loadConnection(tx, id);
      await requireMayChange(tx, current);
      await audit(ctx, tx, current, 'deleted');
      // A person's sign-in to an outside account is also forgotten at the provider (as the disconnect route does); the token is read before the row goes
      const held = current.scope === 'person' ? await revocableToken(oauth, { workspaceId: current.workspace_id, connectionId: current.id }) : null;
      // Deleting is a system act (the credentials go first); it was checked above under the caller's own rights.
      const gone = await deleteConnectionAndSecrets({ db: ctx.db, secrets: ctx.secrets }, { workspaceId: current.workspace_id, connectionId: current.id });
      if (!gone) throw notFound('No such connection');
      if (held) await revokeAtProvider(oauth, { workspaceId: current.workspace_id, provider: held.provider, token: held.token });
      return json(DeleteConnectionResponse.parse({ deleted: true }));
    }),
  });

  ctx.http.route({
    ...deliverMailRoute,
    schema: { body: DeliverMailRequest, response: DeliverMailResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = DeliverMailParams.parse(req.params);
      const body = DeliverMailRequest.parse(req.body);
      const team = await requireTeam(tx, params.slug);
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can put mail into a mailbox.');
      if (team.archived_at) throw conflict('This team is archived, so its mailbox takes no mail.');
      const connection = (
        await tx.query<{ id: string; kind: string }>(`SELECT id, kind FROM app.connections WHERE team_id = $1 AND scope = 'team' AND slug = $2`, [team.id, params.connection])
      ).rows[0];
      if (!connection) throw notFound(`This team has no connection called “${params.connection}”.`);
      if (connection.kind !== 'email') throw invalid(`The connection “${params.connection}” is not a mail connection.`);

      const messageRef = body.messageRef ?? `<${randomUUID()}@mail.manythreads.invalid>`;
      // a mail that answers one the mailbox holds joins its thread; any other starts its own
      const parent = body.inReplyTo
        ? (await tx.query<{ thread_key: string }>('SELECT thread_key FROM app.connection_messages WHERE connection_id = $1 AND message_id = $2 ORDER BY seq LIMIT 1', [connection.id, body.inReplyTo])).rows[0]
        : undefined;
      const threadKey = parent?.thread_key ?? messageRef;
      const inserted = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, folder, thread_key, message_id, in_reply_to, from_address, to_address, subject, body)
           VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (connection_id, direction, message_id) DO NOTHING RETURNING id`,
          [team.workspace_id, team.id, connection.id, body.folder ?? 'INBOX', threadKey, messageRef, body.inReplyTo ?? null, body.from, body.to, body.subject, body.body],
        )
      ).rows[0];
      // the same mail twice is one mail: the answer names the row that is already there
      const row = inserted
        ? { id: inserted.id, thread_key: threadKey }
        : (await tx.query<{ id: string; thread_key: string }>(`SELECT id, thread_key FROM app.connection_messages WHERE connection_id = $1 AND direction = 'in' AND message_id = $2`, [connection.id, messageRef])).rows[0];
      if (!row) throw conflict('That mail could not be stored.');
      if (inserted) await ctx.jobs.enqueue(tx, WATCH_QUEUE, { workspaceId: team.workspace_id, connectionId: connection.id });
      return json({ mail: { id: row.id, connectionId: connection.id, threadKey: row.thread_key, messageRef, duplicate: !inserted } }, inserted ? 201 : 200);
    }),
  });
}
