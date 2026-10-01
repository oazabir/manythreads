import { randomUUID } from 'node:crypto';
import { ActorId, parseEvent, WorkspaceId } from '@majlis/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@majlis/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppPool, createSystemPool, withActor, withSystem } from '../../src/db/index.ts';
import { emit, eventToRaw, subscribe } from '../../src/events/index.ts';
import { ensureActor, personActor } from '../../src/identity/index.ts';

let db: TestDatabase;
let pool: pg.Pool;
let sys: pg.Pool;
const workspaceId = WorkspaceId.parse(randomUUID());

beforeAll(async () => {
  db = await createTestDatabase();
  pool = createAppPool(db.appUrl, 4);
  sys = createSystemPool(db.systemUrl, 4);
  await withSystem(
    async (tx) => {
      await subscribe(tx, 'sub-a', 'kernel.test.pinged');
      await subscribe(tx, 'sub-b', 'kernel.test.pinged');
      await subscribe(tx, 'sub-c', 'channel.message.posted');
    },
    { pool: sys },
  );
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await sys?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

const count = (table: string): Promise<number> =>
  withSystem(async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n), {
    pool: sys,
  });

describe('ensureActor', () => {
  it('is get-or-create', async () => {
    const refId = randomUUID() as never;
    const [a, b] = await withSystem(
      async (tx) => [
        await ensureActor(tx, { kind: 'person', workspaceId, refId }),
        await ensureActor(tx, { kind: 'person', workspaceId, refId }),
      ],
      { pool: sys },
    );
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe('person');
  });
});

describe('emit', () => {
  it('writes the event and one outbox row per subscriber atomically, as a normal actor', async () => {
    const actor = personActor(ActorId.parse(randomUUID()), workspaceId);
    const result = await withActor(
      actor,
      (tx) => emit(tx, { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId, note: 'hello' }),
      { pool },
    );
    expect(result.subscribers.sort()).toEqual(['sub-a', 'sub-b']);
    expect(result.record.actorId).toBe(actor.id);
    const rows = await withSystem(
      async (tx) => ({
        ev: (await tx.query('SELECT * FROM app.events WHERE id = $1', [result.record.id])).rows,
        ob: (await tx.query('SELECT subscriber FROM app.outbox WHERE event_id = $1 ORDER BY subscriber', [result.record.id]))
          .rows,
      }),
      { pool: sys },
    );
    expect(rows.ev).toHaveLength(1);
    expect(rows.ob.map((r) => r["subscriber"])).toEqual(['sub-a', 'sub-b']);
    // The captured event matches its registry schema.
    expect(() => parseEvent(eventToRaw(rows.ev[0] as never))).not.toThrow();
    expect(parseEvent(eventToRaw(rows.ev[0] as never))).toMatchObject({ type: 'kernel.test.pinged', note: 'hello' });
  });

  it('extracts team_id into its column', async () => {
    const actor = personActor(ActorId.parse(randomUUID()), workspaceId);
    const teamId = randomUUID();
    const { record } = await withActor(
      actor,
      (tx) =>
        emit(tx, {
          type: 'channel.message.posted',
          schemaVersion: 1,
          workspaceId,
          channelId: randomUUID(),
          teamId,
          messageId: randomUUID(),
          authorId: actor.id,
          threadRootId: null,
        }),
      { pool },
    );
    expect(record.teamId).toBe(teamId);
  });

  it('throws naming the field and writes nothing on an invalid payload', async () => {
    const events = await count('app.events');
    const outbox = await count('app.outbox');
    const actor = personActor(ActorId.parse(randomUUID()), workspaceId);
    const err = await withActor(
      actor,
      (tx) => emit(tx, { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId, note: 42 }),
      { pool },
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe('ZodError');
    expect(JSON.stringify((err as { issues: unknown }).issues)).toContain('note');
    await expect(
      withActor(actor, (tx) => emit(tx, { type: 'nope.nope.nope', schemaVersion: 1, workspaceId }), { pool }),
    ).rejects.toThrow(/type/);
    expect(await count('app.events')).toBe(events);
    expect(await count('app.outbox')).toBe(outbox);
  });

  it('rolls back event and outbox together when the transaction fails', async () => {
    const events = await count('app.events');
    const outbox = await count('app.outbox');
    const actor = personActor(ActorId.parse(randomUUID()), workspaceId);
    await expect(
      withActor(
        actor,
        async (tx) => {
          await emit(tx, { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId, note: 'x' });
          throw new Error('boom');
        },
        { pool },
      ),
    ).rejects.toThrow('boom');
    expect(await count('app.events')).toBe(events);
    expect(await count('app.outbox')).toBe(outbox);
  });

  it('cannot fan out an event written by someone else, and a normal actor cannot touch outbox directly', async () => {
    const author = personActor(ActorId.parse(randomUUID()), workspaceId);
    const other = personActor(ActorId.parse(randomUUID()), workspaceId);
    const { record } = await withActor(
      author,
      (tx) => emit(tx, { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId, note: 'y' }),
      { pool },
    );
    const fan = await withActor(other, (tx) => tx.query('SELECT app.enqueue_outbox($1)', [record.id]), { pool });
    expect(fan.rowCount).toBe(0);
    await expect(
      withActor(other, (tx) => tx.query(`INSERT INTO app.outbox (event_id, subscriber) VALUES ($1, 'x')`, [record.id]), {
        pool,
      }),
    ).rejects.toThrow(/row-level security/);
  });
});
