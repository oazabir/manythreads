import { UnreadCounterMissingError, type PluginReadState, type UnreadCounter } from '@manythreads/sdk';
import { ReadTarget, ReadTargetType, type ReadStateEntry, type UnreadSummary } from '@manythreads/shared';
import { z } from 'zod';
import { toReadStateEntry, type ReadStateRow } from '../db/mappers/read-state.ts';
import type { Tx } from '../db/with-actor.ts';
import { emit } from '../events/index.ts';
import { publishRealtime, type RealtimeMessage } from '../transport/realtime.ts';

/** The registered counters by target type (the host owns one map; `ctx.readState.registerCounter` fills it). */
export type UnreadCounters = Map<ReadTargetType, { plugin: string; counter: UnreadCounter }>;

/** Realtime message type pushed to a person's sockets whenever one of their entries changes. */
export const READ_STATE_PUSH_TYPE = 'reading.state.changed';

const Uuid = z.uuid();
const MAX_TARGETS = 500;

type ChangedRow = Pick<ReadStateRow, 'person_id' | 'last_read_id' | 'unread_count' | 'followed'>;

const COLUMNS = 'target_type, target_id, last_read_id, unread_count, followed';

/**
 * Emits `reading.state.changed` (one event for all rows of one change) and queues the live push for each person. Both ride in the
 * caller's transaction: nothing is announced for a change that rolls back.
 */
async function announce(
  tx: Tx,
  target: ReadTarget,
  reason: 'posted' | 'read' | 'followed',
  rows: readonly ChangedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const changes = rows.map((r) => ({ personId: r.person_id, lastReadId: r.last_read_id, unreadCount: r.unread_count, followed: r.followed }));
  await emit(tx, {
    type: 'reading.state.changed',
    schemaVersion: 1,
    workspaceId: tx.actor.workspaceId,
    targetType: target.targetType,
    targetId: target.targetId,
    reason,
    changes,
  });
  const pushes: RealtimeMessage[] = changes.map((c) => ({
    workspaceId: tx.actor.workspaceId,
    personId: c.personId,
    type: READ_STATE_PUSH_TYPE,
    payload: { targetType: target.targetType, targetId: target.targetId, lastReadId: c.lastReadId, unreadCount: c.unreadCount, followed: c.followed, reason },
  }));
  await publishRealtime(tx, pushes);
}

const entryOf = (row: ChangedRow & { target_type: string; target_id: string }): ReadStateEntry => toReadStateEntry(row);

/** Entry for a target with no row yet. */
const emptyEntry = (target: ReadTarget): ReadStateEntry => ({
  targetType: target.targetType,
  targetId: target.targetId,
  lastReadId: null,
  unreadCount: 0,
  followed: false,
});

/**
 * The read-state service behind `ctx.readState` (P3-03). Everything here runs in the caller's transaction. A person's own rows are
 * written under RLS (policy P); other people's counters move only through `app.read_state_bump` (migration 0013).
 */
export function createReadStateService(deps: { counters: UnreadCounters; plugin?: string }): PluginReadState {
  const service: PluginReadState = {
    async onPosted(txIn, input) {
      const tx = txIn as unknown as Tx;
      const target = ReadTarget.parse({ targetType: input.targetType, targetId: input.targetId });
      const messageId = Uuid.parse(input.messageId);
      const authorId = Uuid.parse(input.authorId);
      const recipients = [...new Set(input.recipientPersonIds.map((r) => Uuid.parse(r)))];
      if (recipients.length === 0) return [];
      const res = await tx.query<ChangedRow & { target_type: string; target_id: string }>(
        `SELECT b.person_id, b.last_read_id, b.unread_count, b.followed, $1::text AS target_type, $2::uuid AS target_id
         FROM app.read_state_bump($1, $2, $3, $4, $5::uuid[]) b`,
        [target.targetType, target.targetId, messageId, authorId, recipients],
      );
      await announce(tx, target, 'posted', res.rows);
      return res.rows.map((r) => ({ ...entryOf(r), personId: r.person_id }));
    },

    async markRead(txIn, personId, targetIn, upToMessageId, options = {}) {
      const tx = txIn as unknown as Tx;
      const person = Uuid.parse(personId);
      const target = ReadTarget.parse(targetIn);
      const upTo = Uuid.parse(upToMessageId);
      // 1. The row must exist to be locked (a person who never received a post has none). A hit writes nothing.
      await tx.query(
        `INSERT INTO app.read_state (person_id, target_type, target_id) VALUES ($1, $2, $3) ON CONFLICT (person_id, target_type, target_id) DO NOTHING`,
        [person, target.targetType, target.targetId],
      );
      // 2. Lock it. A concurrent post (read_state_bump) or mark-read waits here until this transaction ends, so the count taken
      //    below is never overtaken: a post committed before the lock is in the count and already bumped; one after it bumps after.
      const cur = (
        await tx.query<{ advance: boolean } & ChangedRow & { target_type: string; target_id: string }>(
          `SELECT (last_read_id IS NULL OR last_read_id <= $4) AS advance, person_id, target_type, target_id, last_read_id, unread_count, followed
           FROM app.read_state WHERE person_id = $1 AND target_type = $2 AND target_id = $3 FOR UPDATE`,
          [person, target.targetType, target.targetId, upTo],
        )
      ).rows[0];
      if (!cur) throw new Error('read_state row vanished while locked');
      // 3. Monotonic: a position older than the stored one changes nothing.
      if (!cur.advance) return entryOf(cur);
      // 4. Messages newer than `upTo`.
      let remaining = options.remaining;
      if (remaining === undefined) {
        const registered = deps.counters.get(target.targetType);
        if (!registered) {
          throw new UnreadCounterMissingError(target.targetType);
        }
        remaining = await registered.counter(txIn, target, upTo);
      }
      if (!Number.isInteger(remaining) || remaining < 0) throw new RangeError(`remaining must be a non-negative integer, got ${String(remaining)}`);
      const res = await tx.query<ChangedRow & { target_type: string; target_id: string }>(
        `UPDATE app.read_state SET last_read_id = $4, unread_count = $5, updated_at = now()
         WHERE person_id = $1 AND target_type = $2 AND target_id = $3
         RETURNING person_id, target_type, target_id, last_read_id, unread_count, followed`,
        [person, target.targetType, target.targetId, upTo, remaining],
      );
      const row = res.rows[0] as ChangedRow & { target_type: string; target_id: string };
      if (cur.last_read_id !== row.last_read_id || cur.unread_count !== row.unread_count) await announce(tx, target, 'read', [row]);
      return entryOf(row);
    },

    async setFollowed(txIn, personId, targetIn, followed) {
      const tx = txIn as unknown as Tx;
      const person = Uuid.parse(personId);
      const target = ReadTarget.parse(targetIn);
      const res = await tx.query<ChangedRow & { target_type: string; target_id: string }>(
        `INSERT INTO app.read_state AS rs (person_id, target_type, target_id, followed) VALUES ($1, $2, $3, $4)
         ON CONFLICT (person_id, target_type, target_id) DO UPDATE SET followed = EXCLUDED.followed, updated_at = now()
           WHERE rs.followed IS DISTINCT FROM EXCLUDED.followed
         RETURNING person_id, target_type, target_id, last_read_id, unread_count, followed`,
        [person, target.targetType, target.targetId, followed],
      );
      const changed = res.rows[0];
      if (changed) {
        await announce(tx, target, 'followed', [changed]);
        return entryOf(changed);
      }
      return (await service.get(txIn, personId, [target]))[0] ?? emptyEntry(target);
    },

    async get(txIn, personId, targetsIn) {
      const tx = txIn as unknown as Tx;
      const person = Uuid.parse(personId);
      const targets = z.array(ReadTarget).max(MAX_TARGETS).parse(targetsIn);
      if (targets.length === 0) return [];
      const res = await tx.query<{ target_type: string; target_id: string; last_read_id: string | null; unread_count: number; followed: boolean }>(
        `SELECT ${COLUMNS} FROM app.read_state
         WHERE person_id = $1 AND (target_type, target_id) IN (SELECT * FROM unnest($2::text[], $3::uuid[]))`,
        [person, targets.map((t) => t.targetType), targets.map((t) => t.targetId)],
      );
      const byKey = new Map(res.rows.map((r) => [`${r.target_type}:${r.target_id}`, r]));
      return targets.map((t) => {
        const row = byKey.get(`${t.targetType}:${t.targetId}`);
        return row ? toReadStateEntry(row) : emptyEntry(t);
      });
    },

    async unreadSummary(txIn, personId): Promise<UnreadSummary> {
      const tx = txIn as unknown as Tx;
      const person = Uuid.parse(personId);
      // `unread_count > 0` is the predicate of the partial index; INCLUDE (target_type, unread_count) makes this index-only.
      const res = await tx.query<{ target_type: string; target_id: string; unread_count: number }>(
        `SELECT target_type, target_id, unread_count FROM app.read_state WHERE person_id = $1 AND unread_count > 0`,
        [person],
      );
      const channels: UnreadSummary['channels'] = [];
      let threadCount = 0;
      let threadUnread = 0;
      for (const r of res.rows) {
        if (r.target_type === 'channel') channels.push({ channelId: r.target_id as UnreadSummary['channels'][number]['channelId'], unreadCount: r.unread_count });
        else {
          threadCount += 1;
          threadUnread += r.unread_count;
        }
      }
      channels.sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0));
      const total = threadUnread + channels.reduce((n, c) => n + c.unreadCount, 0);
      return { channels, threads: { threadCount, unreadCount: threadUnread }, total };
    },

    registerCounter(targetType, counter) {
      const type = ReadTargetType.parse(targetType);
      const existing = deps.counters.get(type);
      if (existing) {
        throw new Error(`The unread counter for "${type}" targets is already registered by plugin "${existing.plugin}"`);
      }
      deps.counters.set(type, { plugin: deps.plugin ?? 'unknown', counter });
    },
  };
  return service;
}
