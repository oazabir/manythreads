import { ensureActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { IssuedSession, PluginTx, SessionIssuer, SessionRecord } from '@manythreads/sdk';
import type { ActorId, PersonId, SessionId, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import type { SessionConfig } from './config.ts';
import { deviceLabel } from './device.ts';
import { csrfTokenFor, hashToken, newSessionToken } from './tokens.ts';

export type SessionRefusal = 'unknown' | 'revoked' | 'idle' | 'expired' | 'suspended';

/** A cookie token that resolved to a live session. */
export interface ResolvedSession {
  sessionId: SessionId;
  personId: PersonId;
  workspaceId: WorkspaceId;
  /** The person as an actor, ready for `withActor`. */
  actor: Actor;
  /** The token that was presented (needed to verify the CSRF token bound to it). */
  token: string;
  expiresAt: Date;
  /** Set when this lookup rotated the token: the response must carry these as the new cookies. */
  rotated: IssuedSession | null;
}

export type ResolveResult = { ok: true; session: ResolvedSession } | { ok: false; reason: SessionRefusal };

/** The server's session store: issue, look up (with idle and absolute expiry, rotation), list, revoke. */
export interface SessionService extends SessionIssuer {
  readonly config: SessionConfig;
  now(): Date;
  /** Cookie token -> live session, or why not. Touches `last_seen_at` and rotates old tokens as a side effect. */
  resolve(token: string): Promise<ResolveResult>;
  /**
   * Which of these sessions are still live right now (not revoked, not expired, not idle, person still active). Read only: it touches
   * nothing, so an open WebSocket can be re-checked without keeping its session alive or rotating its token.
   */
  live(sessionIds: readonly string[]): Promise<Set<string>>;
}

export interface SessionServiceOptions {
  /** manythreads_system pool: the lookup runs before anyone is known, so it cannot run as a person. */
  pool: pg.Pool;
  config: SessionConfig;
  /** Injectable clock (tests move it to prove idle expiry). */
  now?: () => Date;
}

const PURGE_EVERY_MS = 5 * 60_000;

/** `last_seen_at` is only rewritten when it is this stale: one write per minute per session, not per request. */
const touchIntervalMs = (config: SessionConfig): number => Math.min(60_000, Math.max(1_000, Math.floor(config.idleMs / 4)));

interface LookupRow {
  session_id: string;
  workspace_id: string;
  person_id: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  person_status: string;
  actor_id: string | null;
  token_issued_at: Date;
  superseded_at: Date | null;
}

const SELECT_COMMON = `s.id AS session_id, s.workspace_id, s.person_id, s.last_seen_at, s.expires_at, s.revoked_at,
       p.status AS person_status, a.id AS actor_id`;
const JOIN_COMMON = `JOIN app.sessions s ON s.id = X.session_id
  JOIN app.people p ON p.id = s.person_id AND p.workspace_id = s.workspace_id
  LEFT JOIN app.actors a ON a.kind = 'person' AND a.ref_id = s.person_id AND a.workspace_id = s.workspace_id`;

const HIT_SQL = `SELECT ${SELECT_COMMON}, c.created_at AS token_issued_at, NULL::timestamptz AS superseded_at
  FROM app.session_cache c ${JOIN_COMMON.replace(/X\./g, 'c.')}
  WHERE c.token_hash = $1`;
const MISS_SQL = `SELECT ${SELECT_COMMON}, t.issued_at AS token_issued_at, t.superseded_at
  FROM app.session_tokens t ${JOIN_COMMON.replace(/X\./g, 't.')}
  WHERE t.token_hash = $1`;

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { pool, config } = options;
  const clock = options.now ?? (() => new Date());
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool });

  const issuedFor = (sessionId: string, token: string, expiresAt: Date): IssuedSession => ({
    sessionId,
    token,
    csrfToken: csrfTokenFor(token),
    expiresAt: expiresAt.toISOString(),
  });

  /** New token row + cache row for a session. */
  async function addToken(tx: Tx, sessionId: string, expiresAt: Date, now: Date): Promise<string> {
    const token = newSessionToken();
    const hash = hashToken(token);
    await tx.query('INSERT INTO app.session_tokens (token_hash, session_id, issued_at) VALUES ($1, $2, $3)', [hash, sessionId, now]);
    await tx.query('INSERT INTO app.session_cache (token_hash, session_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
      hash,
      sessionId,
      expiresAt,
      now,
    ]);
    return token;
  }

  /** Ends sessions for good: marks them revoked and forgets every token (durable and cached). */
  async function endSessions(tx: Tx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.query('DELETE FROM app.session_cache WHERE session_id = ANY($1::uuid[])', [ids]);
    await tx.query('DELETE FROM app.session_tokens WHERE session_id = ANY($1::uuid[])', [ids]);
  }

  /**
   * Abandoned sessions (never used again, so `resolve` never ended them) would keep their token and cache rows forever.
   * Every few minutes a sign-in sweeps the rows of sessions that are revoked, past their absolute end or idle too long.
   */
  let lastPurge = Number.NEGATIVE_INFINITY;
  async function purgeDeadTokens(tx: Tx, now: Date): Promise<void> {
    const dead = `SELECT id FROM app.sessions WHERE revoked_at IS NOT NULL OR expires_at <= $1 OR last_seen_at <= $2`;
    const args = [now, new Date(now.getTime() - config.idleMs)];
    await tx.query(`DELETE FROM app.session_cache WHERE session_id IN (${dead})`, args);
    await tx.query(`DELETE FROM app.session_tokens WHERE session_id IN (${dead})`, args);
  }

  const isLive = (row: { expires_at: Date; last_seen_at: Date }, now: Date): boolean =>
    row.expires_at.getTime() > now.getTime() && row.last_seen_at.getTime() + config.idleMs > now.getTime();

  return {
    config,
    now: clock,

    async issue(tx: PluginTx, input) {
      const t = tx as unknown as Tx;
      const now = clock();
      if (now.getTime() - lastPurge >= PURGE_EVERY_MS) {
        lastPurge = now.getTime();
        await purgeDeadTokens(t, now);
      }
      const expiresAt = new Date(now.getTime() + config.absoluteMs);
      const created = await t.query<{ id: string }>(
        `INSERT INTO app.sessions (workspace_id, person_id, created_at, last_seen_at, expires_at, device)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [input.workspaceId, input.personId, now, expiresAt, deviceLabel(input.device)],
      );
      const id = created.rows[0]?.id;
      if (!id) throw new Error('session insert returned no row');
      await ensureActor(t, { kind: 'person', workspaceId: input.workspaceId as WorkspaceId, refId: input.personId as PersonId });
      const token = await addToken(t, id, expiresAt, now);
      return issuedFor(id, token, expiresAt);
    },

    async list(tx: PluginTx, personId, currentSessionId): Promise<SessionRecord[]> {
      const now = clock();
      const res = await (tx as unknown as Tx).query<{
        id: string;
        device: string | null;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
      }>(
        `SELECT id, device, created_at, last_seen_at, expires_at FROM app.sessions
         WHERE person_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_seen_at > $3
         ORDER BY last_seen_at DESC, id DESC`,
        [personId, now, new Date(now.getTime() - config.idleMs)],
      );
      return res.rows.map((r) => ({
        id: r.id,
        label: r.device ?? 'Unknown device',
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        current: r.id === currentSessionId,
      }));
    },

    async revoke(tx: PluginTx, input) {
      const t = tx as unknown as Tx;
      const res = await t.query<{ id: string }>(
        'UPDATE app.sessions SET revoked_at = $3 WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL RETURNING id',
        [input.sessionId, input.personId, clock()],
      );
      await endSessions(t, res.rows.map((r) => r.id));
      return res.rows.length > 0;
    },

    async revokeAll(tx: PluginTx, input) {
      const t = tx as unknown as Tx;
      const now = clock();
      const res = await t.query<{ id: string; expires_at: Date; last_seen_at: Date }>(
        `UPDATE app.sessions SET revoked_at = $3
         WHERE person_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)
         RETURNING id, expires_at, last_seen_at`,
        [input.personId, input.exceptSessionId ?? null, now],
      );
      await endSessions(t, res.rows.map((r) => r.id));
      return res.rows.filter((r) => isLive(r, now)).length;
    },

    async live(sessionIds) {
      if (sessionIds.length === 0) return new Set();
      const now = clock();
      const res = await run((tx) =>
        tx.query<{ id: string }>(
          `SELECT s.id FROM app.sessions s JOIN app.people p ON p.id = s.person_id AND p.workspace_id = s.workspace_id
            WHERE s.id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND p.status = 'active' AND s.expires_at > $2 AND s.last_seen_at > $3`,
          [sessionIds, now, new Date(now.getTime() - config.idleMs)],
        ),
      );
      return new Set(res.rows.map((r) => r.id));
    },

    resolve(token: string): Promise<ResolveResult> {
      const hash = hashToken(token);
      const now = clock();
      return run(async (tx): Promise<ResolveResult> => {
        let row = (await tx.query<LookupRow>(HIT_SQL, [hash])).rows[0];
        const fromCache = row !== undefined;
        if (!row) row = (await tx.query<LookupRow>(MISS_SQL, [hash])).rows[0];
        if (!row) return { ok: false, reason: 'unknown' };
        const found: LookupRow = row;

        const end = async (reason: SessionRefusal): Promise<ResolveResult> => {
          if (reason !== 'revoked') {
            await tx.query('UPDATE app.sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [found.session_id, now]);
          }
          await endSessions(tx, [found.session_id]);
          return { ok: false, reason };
        };

        if (found.revoked_at) return end('revoked');
        if (found.person_status !== 'active') return end('suspended');
        if (found.expires_at.getTime() <= now.getTime()) return end('expired');
        if (found.last_seen_at.getTime() + config.idleMs <= now.getTime()) return end('idle');
        if (found.superseded_at && now.getTime() - found.superseded_at.getTime() > config.rotationGraceMs) {
          await tx.query('DELETE FROM app.session_tokens WHERE token_hash = $1', [hash]);
          return { ok: false, reason: 'unknown' };
        }

        const actorId =
          found.actor_id ??
          (await ensureActor(tx, { kind: 'person', workspaceId: found.workspace_id as WorkspaceId, refId: found.person_id as PersonId })).id;

        if (now.getTime() - found.last_seen_at.getTime() >= touchIntervalMs(config)) {
          await tx.query('UPDATE app.sessions SET last_seen_at = $2 WHERE id = $1', [found.session_id, now]);
        }
        if (!fromCache && !found.superseded_at) {
          await tx.query(
            `INSERT INTO app.session_cache (token_hash, session_id, expires_at, created_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (token_hash) DO NOTHING`,
            [hash, found.session_id, found.expires_at, found.token_issued_at],
          );
        }

        let rotated: IssuedSession | null = null;
        if (!found.superseded_at && now.getTime() - found.token_issued_at.getTime() >= config.rotateMs) {
          // Only the request that wins this UPDATE rotates; a parallel one finds the token already superseded.
          const won = await tx.query(
            'UPDATE app.session_tokens SET superseded_at = $2 WHERE token_hash = $1 AND superseded_at IS NULL RETURNING token_hash',
            [hash, now],
          );
          if (won.rows.length > 0) {
            await tx.query('DELETE FROM app.session_cache WHERE token_hash = $1', [hash]);
            const next = await addToken(tx, found.session_id, found.expires_at, now);
            await tx.query('DELETE FROM app.session_tokens WHERE session_id = $1 AND superseded_at < $2', [
              found.session_id,
              new Date(now.getTime() - config.rotationGraceMs),
            ]);
            rotated = issuedFor(found.session_id, next, found.expires_at);
          }
        }

        return {
          ok: true,
          session: {
            sessionId: found.session_id as SessionId,
            personId: found.person_id as PersonId,
            workspaceId: found.workspace_id as WorkspaceId,
            actor: { kind: 'person', id: actorId as ActorId, workspaceId: found.workspace_id as WorkspaceId },
            token,
            expiresAt: found.expires_at,
            rotated,
          },
        };
      });
    },
  };
}
