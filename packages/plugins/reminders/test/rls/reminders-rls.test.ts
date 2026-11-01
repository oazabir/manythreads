import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type MigrationSource, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  webhooksMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, priya, tariq, lena } = personas;

const remindersMigrationSource: MigrationSource = {
  namespace: 'reminders',
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

// P14-04: who reads and writes what for `/remind` (pnpm test:rls). A reminder is private to its maker, an admin included; a person only makes one
// for a place they may use and only cancels it afterwards; the system role (the reminders job) delivers and removes. The budget is a trigger.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const failure = (promise: Promise<unknown>): Promise<{ code?: string; message?: string } | null> =>
  promise.then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );

let openChannel = ''; // public, Engineering: Omar (admin), Nadia, Rafi and Priya read and post; Tariq (Marketing only) and Lena (guest) do not
let marketingChannel = ''; // public, Marketing: Tariq and Priya, and Omar as an admin
let shared = ''; // private, Engineering: Omar and Nadia are members
let aloneChannel = ''; // private, Engineering: Omar only

const newChannel = (name: string, isPrivate: boolean, members: Persona[], teamId: string = TEAM_IDS.Engineering): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        'INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [omar.workspaceId, teamId, name, 'channel', isPrivate, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });

interface Make {
  kind: 'me' | 'person' | 'channel';
  who?: Persona;
  channel?: string | null;
  text?: string;
  /** SQL for the time; the default is an hour from now */
  at?: string;
  creator?: Persona;
}
/** Inserts a reminder as `p` (the maker is `p` unless `creator` says otherwise, to try to make one for somebody else). */
const make = (p: Persona, m: Make): Promise<{ id: string }[]> =>
  q<{ id: string }>(
    p,
    `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, target_person_id, channel_id, text, remind_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${m.at ?? "now() + interval '1 hour'"}) RETURNING id`,
    [p.workspaceId, (m.creator ?? p).personId, m.kind, m.who?.personId ?? null, m.channel ?? null, m.text ?? 'call the plumber'],
  );
/** Fills a maker's rows as the system role (which the budget trigger does not count), `n` of one shape. */
const fill = (maker: Persona, n: number, kind: 'me' | 'channel', channel: string | null, state: 'pending' | 'cancelled' = 'pending'): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, channel_id, text, remind_at, state)
       SELECT $1::uuid, $2::uuid, $3, $4::uuid, 'filler', now() + interval '2 hours', $5 FROM generate_series(1, $6::int)`,
      [maker.workspaceId, maker.personId, kind, channel, state, n],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, webhooksMigrationSource, remindersMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  openChannel = await newChannel('remind-open', false, []);
  marketingChannel = await newChannel('remind-marketing', false, [], TEAM_IDS.Marketing);
  shared = await newChannel('remind-shared', true, [omar, nadia]);
  aloneChannel = await newChannel('remind-alone', true, [omar]);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the reminders tables pass the RLS harness', () => {
  it('RLS is enabled and forced, with policies and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'reminders')).toEqual([]);
      const plan = await admin.query(
        "SELECT c.relname, c.relrowsecurity AS on, c.relforcerowsecurity AS forced FROM pg_class c WHERE c.oid IN ('app.reminders'::regclass, 'app.reminder_senders'::regclass) ORDER BY c.relname",
      );
      expect(plan.rows).toEqual([
        { relname: 'reminder_senders', on: true, forced: true },
        { relname: 'reminders', on: true, forced: true },
      ]);
    } finally {
      await admin.end();
    }
  });
});

describe('making a reminder', () => {
  it('a person makes one for themself, as themself and nobody else', async () => {
    expect(await make(nadia, { kind: 'me' })).toHaveLength(1);
    expect(await code(make(nadia, { kind: 'me', creator: rafi }))).toBe('42501'); // in the name of somebody else
  });

  it('a reminder for a channel needs the right to post there', async () => {
    expect(await make(nadia, { kind: 'channel', channel: openChannel })).toHaveLength(1);
    expect(await code(make(tariq, { kind: 'channel', channel: openChannel }))).toBe('42501'); // another team's channel
    expect(await code(make(nadia, { kind: 'channel', channel: aloneChannel }))).toBe('42501'); // a private channel they are not in
    expect(await make(omar, { kind: 'channel', channel: aloneChannel })).toHaveLength(1); // a member
    expect(await make(omar, { kind: 'channel', channel: openChannel })).toHaveLength(1); // an admin posts in every team's public channels
  });

  it('a reminder for a person needs a conversation both read, and the person must be someone else', async () => {
    expect(await make(nadia, { kind: 'person', who: rafi, channel: openChannel })).toHaveLength(1);
    expect(await make(omar, { kind: 'person', who: nadia, channel: shared })).toHaveLength(1);
    // the target cannot read the place (a trigger refuses before the policy is asked)
    const noRead = await failure(make(nadia, { kind: 'person', who: tariq, channel: openChannel }));
    expect(noRead?.code).toBe('23514');
    expect(noRead?.message).toContain('cannot read this conversation');
    expect(await code(make(omar, { kind: 'person', who: rafi, channel: shared }))).toBe('23514'); // Rafi is not in the private channel
    expect(await code(make(nadia, { kind: 'person', who: lena, channel: openChannel }))).toBe('23514'); // a guest is not reminded about a team channel
    // the maker cannot read the place: the same refusal, and the answer does not tell who reads it
    expect(await code(make(priya, { kind: 'person', who: nadia, channel: shared }))).toBe('23514');
    const self = await failure(make(nadia, { kind: 'person', who: nadia, channel: openChannel }));
    expect(self?.code).toBe('23514');
    expect(self?.message).toContain('/remind me');
  });

  it('a guest makes none', async () => {
    const err = await failure(make(lena, { kind: 'me' }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('members of the workspace');
  });

  it('the shape of a row is checked: one line of 1 to 500 characters, the target fields, a time within a year', async () => {
    expect(await code(make(nadia, { kind: 'me', text: '' }))).toBe('23514');
    expect(await code(make(nadia, { kind: 'me', text: 'two\nlines' }))).toBe('23514');
    expect(await code(make(nadia, { kind: 'me', text: 'two\rlines' }))).toBe('23514');
    expect(await code(make(nadia, { kind: 'me', text: 'x'.repeat(501) }))).toBe('23514');
    expect(await make(nadia, { kind: 'me', text: 'x'.repeat(500) })).toHaveLength(1);
    expect(await code(make(nadia, { kind: 'me', channel: openChannel }))).toBe('23514'); // `me` has no channel
    expect(await code(make(nadia, { kind: 'channel', channel: null }))).toBeDefined(); // a channel reminder needs its channel
    expect(await code(make(nadia, { kind: 'me', at: "now() + interval '400 days'" }))).toBe('23514');
    expect(await make(nadia, { kind: 'me', at: "now() + interval '365 days'" })).toHaveLength(1);
  });

  it('a person cannot make one that is already sent or cancelled', async () => {
    const insert = (state: string, sentAt: string | null): Promise<unknown> =>
      as(nadia, (tx) =>
        tx.query(
          "INSERT INTO app.reminders (workspace_id, creator_id, target_kind, text, remind_at, state, sent_at) VALUES ($1, $2, 'me', 'x', now() + interval '1 hour', $3, $4::timestamptz)",
          [nadia.workspaceId, nadia.personId, state, sentAt],
        ),
      );
    expect(await code(insert('cancelled', null))).toBe('42501');
    expect(await code(insert('sent', new Date().toISOString()))).toBe('42501');
  });
});

describe('reading', () => {
  it('a person reads their own reminders only; an admin sees nobody else\'s, and the person a reminder is for never reads it', async () => {
    const ids = (rows: { creator_id: string }[]): string[] => [...new Set(rows.map((r) => r.creator_id))];
    expect(ids(await q(nadia, 'SELECT creator_id FROM app.reminders'))).toEqual([nadia.personId]);
    expect(ids(await q(omar, 'SELECT creator_id FROM app.reminders'))).toEqual([omar.personId]);
    // Rafi is the target of one of Nadia's and Nadia is the target of one of Omar's, and neither reads it
    expect(await q(rafi, 'SELECT 1 FROM app.reminders')).toEqual([]);
    expect(await q(tariq, 'SELECT 1 FROM app.reminders')).toEqual([]);
    expect(await q(lena, 'SELECT 1 FROM app.reminders')).toEqual([]);
  });

  it('the system role reads every row', async () => {
    const rows = (await sys((tx) => tx.query<{ creator_id: string }>('SELECT DISTINCT creator_id FROM app.reminders'))).rows.map((r) => r.creator_id);
    expect(rows).toEqual(expect.arrayContaining([nadia.personId, omar.personId]));
  });

  it('the sender table is the system role\'s alone', async () => {
    expect(await code(q(nadia, 'SELECT 1 FROM app.reminder_senders'))).toBe('42501');
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.reminder_senders'))).rows).toEqual([]);
  });
});

describe('cancelling', () => {
  it('a person cancels their own waiting reminder, once, and never anybody else\'s', async () => {
    const [mine] = await make(rafi, { kind: 'me', text: 'to cancel' });
    const others = await as(nadia, (tx) => tx.query("UPDATE app.reminders SET state = 'cancelled', updated_at = now() WHERE id = $1 RETURNING id", [mine!.id]));
    expect(others.rows).toHaveLength(0);
    const own = await as(rafi, (tx) => tx.query("UPDATE app.reminders SET state = 'cancelled', updated_at = now() WHERE id = $1 RETURNING id", [mine!.id]));
    expect(own.rows).toHaveLength(1);
    const again = await as(rafi, (tx) => tx.query("UPDATE app.reminders SET state = 'cancelled', updated_at = now() WHERE id = $1 RETURNING id", [mine!.id]));
    expect(again.rows).toHaveLength(0); // no longer waiting
  });

  it('cancelling is all a person can do: no text, time, target or other state; no removal', async () => {
    const [mine] = await make(rafi, { kind: 'me', text: 'keep as it is' });
    const id = mine!.id;
    const sql = (set: string): Promise<unknown> => as(rafi, (tx) => tx.query(`UPDATE app.reminders SET ${set} WHERE id = $1`, [id]));
    expect(await code(sql("text = 'something else'"))).toBe('23514');
    expect(await code(sql("remind_at = now() + interval '2 hours'"))).toBe('23514');
    expect(await code(sql("state = 'sent', sent_at = now()"))).toBe('23514');
    expect(await code(sql("state = 'cancelled', text = 'changed while cancelling'"))).toBe('23514');
    expect(await code(sql('creator_id = ' + `'${nadia.personId}'`))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.reminders WHERE id = $1', [id])))).toBe('42501'); // no delete right at all
    expect((await q<{ state: string; text: string }>(rafi, 'SELECT state, text FROM app.reminders WHERE id = $1', [id]))[0]).toEqual({ state: 'pending', text: 'keep as it is' });
  });

  it('the system role sends, refuses and removes', async () => {
    const [mine] = await make(rafi, { kind: 'me', text: 'to deliver' });
    const sent = await sys((tx) =>
      tx.query("UPDATE app.reminders SET state = 'sent', sent_at = now(), sent_message_id = uuidv7(), updated_at = now() WHERE id = $1 RETURNING id", [mine!.id]),
    );
    expect(sent.rows).toHaveLength(1);
    const [other] = await make(rafi, { kind: 'me', text: 'to refuse' });
    expect(await code(sys((tx) => tx.query("UPDATE app.reminders SET state = 'refused' WHERE id = $1", [other!.id])))).toBe('23514'); // a refusal has its reason
    const refused = await sys((tx) => tx.query("UPDATE app.reminders SET state = 'refused', refused_reason = 'because' WHERE id = $1 RETURNING id", [other!.id]));
    expect(refused.rows).toHaveLength(1);
    expect((await sys((tx) => tx.query('DELETE FROM app.reminders WHERE id = ANY ($1::uuid[]) RETURNING id', [[mine!.id, other!.id]]))).rows).toHaveLength(2);
  });
});

describe('the sender and the Reminders conversation are made by the system role only', () => {
  it('a person cannot call the functions', async () => {
    expect(await code(q(nadia, 'SELECT app.reminders_act_as()'))).toBe('42501');
    expect(await code(q(nadia, 'SELECT app.reminders_inbox($1)', [nadia.personId]))).toBe('42501');
  });

  it('the system makes the sender once and a conversation per person, reused, with the person as its only member', async () => {
    const result = await sys(async (tx) => {
      const first = (await tx.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]!.id;
      const second = (await tx.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]!.id;
      const inbox = (await tx.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [nadia.personId])).rows[0]!.id;
      const again = (await tx.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [nadia.personId])).rows[0]!.id;
      const other = (await tx.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [rafi.personId])).rows[0]!.id;
      const members = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1', [inbox])).rows.map((r) => r.person_id);
      const channel = (await tx.query<{ kind: string; private: boolean; dm_key: string; created_by: string }>('SELECT kind, private, dm_key, created_by FROM app.channels WHERE id = $1', [inbox])).rows[0]!;
      return { first, second, inbox, again, other, members, channel };
    });
    expect(result.second).toBe(result.first);
    expect(result.again).toBe(result.inbox);
    expect(result.other).not.toBe(result.inbox);
    expect(result.members).toEqual([nadia.personId]);
    expect(result.channel).toEqual({ kind: 'dm', private: true, dm_key: `reminders:${nadia.personId}`, created_by: result.first });
    const sender = (await sys((tx) => tx.query<{ actor_id: string }>('SELECT actor_id FROM app.reminder_senders WHERE workspace_id = $1', [omar.workspaceId]))).rows;
    expect(sender).toEqual([{ actor_id: result.first }]);
  });

  it('the conversation is refused for a guest, and only the owner of it reads it', async () => {
    expect(await code(sys(async (tx) => {
      await tx.query('SELECT app.reminders_act_as()');
      await tx.query('SELECT app.reminders_inbox($1::uuid)', [lena.personId]);
    }))).toBe('22023');
    // the conversation is private: Nadia reads hers (she is its member); Rafi's is not hers. Both exist before the check, whatever ran earlier.
    await sys(async (tx) => {
      await tx.query('SELECT app.reminders_act_as()');
      await tx.query('SELECT app.reminders_inbox($1::uuid)', [nadia.personId]);
      await tx.query('SELECT app.reminders_inbox($1::uuid)', [rafi.personId]);
    });
    const mine = await q<{ dm_key: string }>(nadia, "SELECT dm_key FROM app.channels WHERE dm_key LIKE 'reminders:%'");
    expect(mine.map((r) => r.dm_key)).toEqual([`reminders:${nadia.personId}`]);
  });

  it('the sender is named Reminders in the message authors', async () => {
    const author = await sys(async (tx) => {
      const actor = (await tx.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]!.id;
      const inbox = (await tx.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [nadia.personId])).rows[0]!.id;
      const message = (
        await tx.query<{ id: string }>("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'Reminder: x', 'Reminder: x') RETURNING id", [
          omar.workspaceId,
          inbox,
          actor,
        ])
      ).rows[0]!.id;
      return { message, actor };
    });
    const rows = await q<{ actor_id: string; display_name: string; kind: string }>(nadia, 'SELECT actor_id, display_name, kind FROM app.message_authors($1::uuid[])', [[author.message]]);
    expect(rows).toEqual([{ actor_id: author.actor, display_name: 'Reminders', kind: 'system' }]);
  });
});

describe('the budget', () => {
  it('100 waiting reminders at most, with a sentence; somebody else is not affected', async () => {
    await fill(rafi, 100, 'me', null);
    const err = await failure(make(rafi, { kind: 'me' }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('100 reminders waiting');
    expect(await make(nadia, { kind: 'me' })).toHaveLength(1);
  });

  it('20 waiting for other people or channels at most, yet one for themself is still fine', async () => {
    await fill(priya, 20, 'channel', openChannel);
    const err = await failure(make(priya, { kind: 'channel', channel: openChannel }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('20 reminders waiting for other people or channels');
    expect(await make(priya, { kind: 'me' })).toHaveLength(1);
  });

  it('10 waiting for one person at most', async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, target_person_id, channel_id, text, remind_at)
         SELECT $1::uuid, $2::uuid, 'person', $3::uuid, $4::uuid, 'filler', now() + interval '2 hours' FROM generate_series(1, 10)`,
        [omar.workspaceId, omar.personId, nadia.personId, shared],
      ),
    );
    const err = await failure(make(omar, { kind: 'person', who: nadia, channel: shared }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('10 reminders waiting for that person');
    expect(await make(omar, { kind: 'person', who: rafi, channel: openChannel })).toHaveLength(1); // another person is fine
  });

  it('20 waiting for one person at most from all makers together, counted through a definer function that shows the number and no row', async () => {
    // a maker cannot read other makers' rows, but the count sees them all
    const before = (await q<{ n: number }>(nadia, 'SELECT app.reminders_pending_for($1::uuid) AS n', [rafi.personId]))[0]!.n;
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, target_person_id, channel_id, text, remind_at)
         SELECT $1::uuid, $2::uuid, 'person', $3::uuid, $4::uuid, 'filler', now() + interval '2 hours' FROM generate_series(1, $5::int)`,
        [tariq.workspaceId, tariq.personId, rafi.personId, openChannel, 20 - before],
      ),
    );
    expect((await q<{ n: number }>(nadia, 'SELECT app.reminders_pending_for($1::uuid) AS n', [rafi.personId]))[0]!.n).toBe(20);
    expect(await q(nadia, "SELECT 1 FROM app.reminders WHERE target_person_id = $1::uuid AND creator_id = $2::uuid", [rafi.personId, tariq.personId])).toEqual([]);
    const err = await failure(make(nadia, { kind: 'person', who: rafi, channel: openChannel }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('already has many reminders waiting');
    // another recipient is not affected, and neither is a reminder for the maker
    expect(await make(nadia, { kind: 'person', who: omar, channel: openChannel })).toHaveLength(1);
    expect(await make(nadia, { kind: 'me' })).toHaveLength(1);
    // cancelled and sent ones do not count
    await sys((tx) => tx.query("UPDATE app.reminders SET state = 'cancelled' WHERE target_person_id = $1::uuid AND creator_id = $2::uuid", [rafi.personId, tariq.personId]));
    expect((await q<{ n: number }>(nadia, 'SELECT app.reminders_pending_for($1::uuid) AS n', [rafi.personId]))[0]!.n).toBe(before);
  });

  it('30 for other people or channels in an hour at most, whether or not they are still waiting', async () => {
    await fill(tariq, 30, 'channel', marketingChannel, 'cancelled');
    const err = await failure(make(tariq, { kind: 'channel', channel: marketingChannel }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toContain('in the last hour');
    expect(await make(tariq, { kind: 'me' })).toHaveLength(1); // for themself the hour counts nothing
  });
});

describe('a deleted channel takes its reminders with it', () => {
  it('drops the reminders of the channel (the owner role deletes channels; nothing in the app does)', async () => {
    const ch = await newChannel('remind-short', false, []);
    await sys((tx) =>
      tx.query("INSERT INTO app.reminders (workspace_id, creator_id, target_kind, channel_id, text, remind_at) VALUES ($1, $2, 'channel', $3, 'x', now() + interval '1 hour')", [
        omar.workspaceId,
        nadia.personId,
        ch,
      ]),
    );
    const owner = testClient({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      expect((await owner.query('DELETE FROM app.channels WHERE id = $1', [ch])).rowCount).toBe(1);
    } finally {
      await owner.end();
    }
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.reminders WHERE channel_id = $1', [ch]))).rows).toEqual([]);
  });
});
