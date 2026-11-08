import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  ConnectionsPersonOffboardedEvent,
  WorkspaceMemberStatusChangedEvent,
  type OffboardPreview,
  type PersonProviderId,
} from '@manythreads/shared';
import { z } from 'zod';
import { revokeToken, type FetchLike } from './oauth/flow.ts';
import { resolveApp } from './oauth/apps.ts';
import { endpointsFor, instanceReady, providerDef, PROVIDERS, servicesGranted } from './oauth/providers.ts';
import type { OAuthDeps } from './oauth/store.ts';
import { readConnectionSecretIn } from './secrets.ts';

// Removing the connections of a person who leaves (PLAN Bundle D, P16-11, decisions D33 and D34). Three steps, in this order:
//
//   1. FAIL CLOSED (one transaction, started by `workspace.member.status_changed` to `suspended`, or by an admin's button): every connection of the person's own is switched off
//      at once, so the tool source refuses their next call; every team or workspace connection they set up moves to the longest-serving lead of its team, else to the admin who
//      acted, else to the longest-serving admin (`app.connections_offboard_start`, which only the system role may run). The job below is queued in the same transaction.
//   2. ASK THE PROVIDERS (the job, no transaction open): for each of the person's connections the refresh token is read and the provider is asked to forget it (5 seconds each,
//      best effort; a provider with no revoke address is skipped and counted as neither). HTTP is never done inside a transaction (MISTAKES P19-10).
//   3. DELETE (the job, one transaction): the connections, their grants and their sealed tokens go together, and one audit line says how many (`connections.person.offboarded`).
//
// Reactivating the person restores nothing. No token appears in an event, a log line, an error or the job's payload (the job reads it at run time).

export const OFFBOARD_QUEUE = 'connections.offboard';
/** How long one provider gets to answer a revoke. */
export const REVOKE_TIMEOUT_MS = 5000;

const Payload = z.object({
  workspaceId: z.uuid(),
  personId: z.uuid(),
  /** The person's own connections that were switched off in step 1 (ids are no secret; the job reads the tokens itself). */
  connectionIds: z.array(z.uuid()).max(200),
  moved: z.number().int().min(0),
  newOwnerIds: z.array(z.uuid()).max(50),
  /** The admin who pressed the button; null when the person was suspended. */
  actorId: z.uuid().nullable(),
});
type Payload = z.infer<typeof Payload>;

export interface OffboardStart {
  disabled: number;
  moved: number;
  newOwnerIds: string[];
  connectionIds: string[];
  queued: boolean;
}

type StartRow = { connection_id: string; scope: 'person' | 'team' | 'workspace'; action: 'disabled' | 'moved'; new_owner_id: string | null };

/** The actor id of a person (the row `connections` and the teams point at), or null. */
async function actorOfPerson(tx: PluginTx, workspaceId: string, personId: string): Promise<string | null> {
  return (
    (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1 AND workspace_id = $2`, [personId, workspaceId])).rows[0]?.id ?? null
  );
}

/**
 * Step 1. `tx` must be a system transaction in the workspace. `fallbackPersonId` is the admin who acted (the owner of last resort for a team connection whose team has no other
 * lead). Queues the job in the same transaction, unless there is nothing to do and nobody pressed a button.
 */
export async function startOffboarding(
  ctx: Pick<PluginContext, 'jobs'>,
  tx: PluginTx,
  input: { workspaceId: string; personId: string; fallbackPersonId: string | null; actorId: string | null },
): Promise<OffboardStart> {
  const fallback = input.fallbackPersonId ? await actorOfPerson(tx, input.workspaceId, input.fallbackPersonId) : null;
  const rows = (await tx.query<StartRow>('SELECT connection_id, scope, action, new_owner_id FROM app.connections_offboard_start($1::uuid, $2::uuid)', [input.personId, fallback])).rows;
  const connectionIds = rows.filter((r) => r.scope === 'person').map((r) => r.connection_id);
  const movedRows = rows.filter((r) => r.action === 'moved');
  const newOwnerIds = [...new Set(movedRows.map((r) => r.new_owner_id).filter((id): id is string => id !== null))];
  const out: OffboardStart = { disabled: rows.filter((r) => r.action === 'disabled').length, moved: movedRows.length, newOwnerIds, connectionIds, queued: false };
  if (connectionIds.length === 0 && movedRows.length === 0 && input.actorId === null) return out;
  const payload: Payload = { workspaceId: input.workspaceId, personId: input.personId, connectionIds, moved: movedRows.length, newOwnerIds, actorId: input.actorId };
  await ctx.jobs.enqueue(tx, OFFBOARD_QUEUE, payload, { dedupeKey: `connections-offboard:${input.personId}` });
  out.queued = true;
  return out;
}

/**
 * What step 1 will do, for the dialog: the same function runs inside a savepoint that is rolled back, so the preview can never disagree with what happens. `tx` is a system
 * transaction in the workspace; `fallbackPersonId` the admin who is looking. Null when the person is not in the workspace.
 */
export async function previewOffboarding(tx: PluginTx, input: { workspaceId: string; personId: string; fallbackPersonId: string | null }): Promise<OffboardPreview | null> {
  const person = (await tx.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1 AND workspace_id = $2', [input.personId, input.workspaceId])).rows[0];
  const actor = await actorOfPerson(tx, input.workspaceId, input.personId);
  if (!person || !actor) return null;
  const own = (
    await tx.query<{ provider: string; scopes: string[] }>(
      `SELECT o.provider, o.scopes FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
        WHERE c.workspace_id = $1 AND c.scope = 'person' AND c.owner_id = $2 ORDER BY o.provider`,
      [input.workspaceId, actor],
    )
  ).rows;
  const fallback = input.fallbackPersonId ? await actorOfPerson(tx, input.workspaceId, input.fallbackPersonId) : null;
  await tx.query('SAVEPOINT offboard_preview');
  let moved: Array<{ slug: string; kind: string; owner: string }> = [];
  try {
    const rows = (await tx.query<StartRow>('SELECT connection_id, scope, action, new_owner_id FROM app.connections_offboard_start($1::uuid, $2::uuid)', [input.personId, fallback])).rows;
    const ids = rows.filter((r) => r.action === 'moved').map((r) => r.connection_id);
    if (ids.length > 0) {
      moved = (
        await tx.query<{ slug: string; kind: string; owner: string }>(
          `SELECT c.slug, c.kind, p.display_name AS owner
             FROM app.connections c JOIN app.actors a ON a.id = c.owner_id JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id
            WHERE c.id = ANY($1::uuid[]) ORDER BY c.created_at, c.id`,
          [ids],
        )
      ).rows;
    }
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT offboard_preview');
    await tx.query('RELEASE SAVEPOINT offboard_preview');
  }
  return {
    personId: input.personId,
    personName: person.display_name,
    own: own.map((r) => {
      const def = providerDef(r.provider);
      return { connector: r.provider, services: def ? servicesGranted(def, r.scopes) : [] };
    }),
    moving: moved.map((m) => ({ slug: m.slug, connector: m.kind, newOwnerName: m.owner })),
  } as OffboardPreview;
}

// --- step 2 and 3: ask the providers, then delete -------------------------------------------------------------------------------------------------------------

export interface RemovalResult {
  /** Connections deleted by this call. */
  removed: number;
  /** The provider has a revoke address and confirmed it forgot the token. */
  providerRevoked: number;
  /** The provider has a revoke address and did not confirm (down, refused, no app any more). */
  providerFailed: number;
}

/** Wraps a fetch so each call has the shorter limit offboarding allows. */
const withTimeout =
  (base: FetchLike | undefined): FetchLike =>
  (url, init) =>
    (base ?? ((u, i) => fetch(u, i)))(url, { ...init, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });

type Held = { id: string; provider: PersonProviderId; token: string };

/** Reads the token each connection would be revoked with (the refresh token, or the access token of a provider with none). Only the person's own connections of the workspace. */
async function heldTokens(deps: OAuthDeps, workspaceId: string, connectionIds: readonly string[], ownerActorId: string | null): Promise<Held[]> {
  if (connectionIds.length === 0) return [];
  return deps.db.system(
    async (tx) => {
      const rows = (
        await tx.query<{ id: string; provider: string }>(
          `SELECT c.id, o.provider FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id
            WHERE c.id = ANY($1::uuid[]) AND c.workspace_id = $2 AND c.scope = 'person' AND ($3::uuid IS NULL OR c.owner_id = $3::uuid)`,
          [connectionIds, workspaceId, ownerActorId],
        )
      ).rows;
      const out: Held[] = [];
      for (const row of rows) {
        const def = providerDef(row.provider);
        if (!def) continue;
        const token = await readConnectionSecretIn(deps.secrets, tx, { workspaceId, connectionId: row.id, name: def.refreshes ? 'refresh_token' : 'access_token' });
        if (token !== null) out.push({ id: row.id, provider: def.id, token });
      }
      return out;
    },
    { workspaceId },
  );
}

/** Asks one provider to forget one token. `none`: it has no revoke address, nothing was asked. No transaction is open. */
async function revokeOne(deps: OAuthDeps, workspaceId: string, held: Held): Promise<'revoked' | 'failed' | 'none'> {
  const def = PROVIDERS[held.provider];
  try {
    const app = await resolveApp(deps, workspaceId, held.provider);
    if (!instanceReady(held.provider, deps.env, app?.tenant ?? null)) return 'none';
    const endpoints = endpointsFor(held.provider, deps.env, app?.tenant ?? null);
    if (!endpoints.revokeUrl) return 'none';
    if (!app) return 'failed';
    return (await revokeToken({ provider: def, endpoints, app, fetchImpl: withTimeout(deps.fetchImpl) }, held.token)) ? 'revoked' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Steps 2 and 3 for a set of person connections: the providers are asked first (no transaction open), then everything is deleted in ONE transaction together with whatever
 * `inSameTransaction` writes there (the audit line), so a failure leaves the connections whole and the job tries again. A connection that is already gone, belongs to another
 * workspace or is not a person's sign-in is skipped. `ownerActorId` pins the owner (the leaving person) when given.
 */
export async function revokeAndDelete(
  deps: OAuthDeps,
  input: { workspaceId: string; connectionIds: readonly string[]; ownerActorId: string | null },
  inSameTransaction?: (tx: PluginTx, result: RemovalResult) => Promise<void>,
): Promise<RemovalResult> {
  const held = await heldTokens(deps, input.workspaceId, input.connectionIds, input.ownerActorId);
  let providerRevoked = 0;
  let providerFailed = 0;
  for (const h of held) {
    const outcome = await revokeOne(deps, input.workspaceId, h);
    if (outcome === 'revoked') providerRevoked += 1;
    else if (outcome === 'failed') providerFailed += 1;
  }
  return deps.db.system(
    async (tx) => {
      const mine = (
        await tx.query<{ id: string }>(
          `SELECT id FROM app.connections WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND scope = 'person' AND ($3::uuid IS NULL OR owner_id = $3::uuid) ORDER BY id FOR UPDATE`,
          [input.connectionIds, input.workspaceId, input.ownerActorId],
        )
      ).rows.map((r) => r.id);
      let removed = 0;
      if (mine.length > 0) {
        const sealed = await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.connection_secrets WHERE connection_id = ANY($1::uuid[]) AND workspace_id = $2', [mine, input.workspaceId]);
        removed = (await tx.query('DELETE FROM app.connections WHERE id = ANY($1::uuid[]) AND workspace_id = $2 RETURNING id', [mine, input.workspaceId])).rows.length;
        for (const row of sealed.rows) await deps.secrets.delete(tx, row.secret_id);
      }
      const result: RemovalResult = { removed, providerRevoked, providerFailed };
      if (inSameTransaction) await inSameTransaction(tx, result);
      return result;
    },
    { workspaceId: input.workspaceId },
  );
}

/** Registers the subscription to a suspension and the job that finishes the work. */
export function registerOffboard(ctx: PluginContext, deps: OAuthDeps): void {
  // A person was deactivated: step 1 in the consumer's own transaction (a failure rolls it back and the event is delivered again).
  ctx.events.subscribe('workspace.member.status_changed', async (raw, tx) => {
    const event = WorkspaceMemberStatusChangedEvent.parse(raw);
    if (event.status !== 'suspended') return;
    await startOffboarding(ctx, tx, { workspaceId: event.workspaceId, personId: event.personId, fallbackPersonId: event.changedBy, actorId: null });
  });

  ctx.jobs.register(
    OFFBOARD_QUEUE,
    async (raw, _unusable, job) => {
      const parsed = Payload.safeParse(raw);
      if (!parsed.success) {
        job.log.warn('connections: an offboarding job with a malformed payload was dropped');
        return;
      }
      const p = parsed.data;
      const ownerActor = await deps.db.system((tx) => actorOfPerson(tx, p.workspaceId, p.personId), { workspaceId: p.workspaceId });
      // a person that is not there any more owns nothing: only the audit line below could still be written
      const result = await revokeAndDelete(deps, { workspaceId: p.workspaceId, connectionIds: ownerActor ? p.connectionIds : [], ownerActorId: ownerActor }, async (tx, r) => {
        // one line per offboarding, written with the deletion; nothing happened (a person with no connections, suspended) = no line, unless an admin pressed the button
        if (r.removed === 0 && p.moved === 0 && p.actorId === null) return;
        await ctx.audit.emit(
          tx,
          ConnectionsPersonOffboardedEvent.parse({
            type: 'connections.person.offboarded',
            schemaVersion: 1,
            workspaceId: p.workspaceId,
            personId: p.personId,
            revoked: r.removed,
            providerRevoked: r.providerRevoked,
            providerFailed: r.providerFailed,
            moved: p.moved,
            newOwnerIds: p.newOwnerIds,
            actorId: p.actorId,
            at: ctx.runtime.now().toISOString(),
          }),
        );
      });
      // counts only: never a token, an address or a provider's text
      job.log.info(`connections: offboarding removed ${String(result.removed)} connection(s), ${String(result.providerRevoked)} forgotten by the provider, ${String(result.providerFailed)} not`);
    },
    { maxAttempts: 5, concurrency: 2, detached: true, serialKey: 'personId' },
  );
}
