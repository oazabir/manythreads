import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  TEAM_IDS,
  type Persona,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P14-07: row-level security of polls and ballots. DB-backed (a throwaway database), so it runs on the devbox when no CI run shares Postgres.
// The point of the file: the ballots of an ANONYMOUS poll are unreadable to everybody but their voter, workspace admins and the system role included,
// while the totals (kept on the poll row) are readable by whoever reads the channel.

const { omar, nadia, rafi, priya, tariq, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const ch: Record<string, string> = {};
const poll: Record<string, string> = {};

async function channel(name: string, opts: { private?: boolean } = {}): Promise<string> {
  return sys(async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, $3, 'channel', $4) RETURNING id`,
    [omar.workspaceId, TEAM_IDS.Engineering, name, opts.private ?? false],
  )).rows[0]!.id);
}

/** A poll by `author` in `channelId`: the message first, then the poll row pointing at it. */
async function makePoll(key: string, channelId: string, author: Persona, over: { anonymous?: boolean; multiple?: boolean; closesAt?: string | null } = {}): Promise<void> {
  poll[key] = await sys(async (tx) => {
    const m = (await tx.query<{ id: string }>(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'Poll: Q', 'Poll: Q') RETURNING id`,
      [omar.workspaceId, channelId, author.actorId],
    )).rows[0]!.id;
    return (await tx.query<{ id: string }>(
      `INSERT INTO app.polls (workspace_id, channel_id, message_id, author_id, question, options, multiple, anonymous, closes_at, vote_counts)
       VALUES ($1, $2, $3, $4, 'Q', ARRAY['A','B','C'], $5, $6, $7, ARRAY[0,0,0]) RETURNING id`,
      [omar.workspaceId, channelId, m, author.actorId, over.multiple ?? false, over.anonymous ?? false, over.closesAt ?? null],
    )).rows[0]!.id;
  });
}
const vote = (p: Persona, pollId: string, choices: number[]): Promise<unknown> =>
  as(p, (tx) => tx.query('INSERT INTO app.poll_votes (poll_id, voter_id, choices) VALUES ($1, $2, $3::smallint[])', [pollId, p.actorId, choices]));
const ballots = (p: Persona, pollId: string): Promise<Array<{ voter_id: string; choices: number[] }>> =>
  q(p, 'SELECT voter_id, choices FROM app.poll_votes WHERE poll_id = $1 ORDER BY voter_id', [pollId]) as never;
const totals = async (p: Persona, pollId: string): Promise<{ vote_counts: number[]; voter_count: number } | undefined> =>
  (await q<{ vote_counts: number[]; voter_count: number }>(p, 'SELECT vote_counts, voter_count FROM app.polls WHERE id = $1', [pollId]))[0];

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  ch['general'] = await channel('poll-general');
  ch['leads'] = await channel('poll-leads', { private: true });
  await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2), ($1, $3)', [ch['leads'], omar.personId, rafi.personId]));
  await makePoll('named', ch['general']!, nadia);
  await makePoll('anon', ch['general']!, nadia, { anonymous: true });
  await makePoll('multi', ch['general']!, nadia, { multiple: true, anonymous: true });
  await makePoll('leads', ch['leads']!, omar);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the poll tables pass the RLS harness', () => {
  it('RLS is enabled and forced with a policy and a comment, and no policy calls app.can per row', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['polls', 'poll_votes']) expect(await findPerRowPolicyCalls(admin, table), `${table} calls a function per row`).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('polls follow the channel', () => {
  it('whoever reads the channel reads the poll; a person outside a private channel does not', async () => {
    for (const p of [omar, nadia, rafi, priya]) expect((await q(p, 'SELECT id FROM app.polls WHERE id = $1', [poll['named']])).length, p.key).toBe(1);
    expect((await q(omar, 'SELECT id FROM app.polls WHERE id = $1', [poll['leads']])).length).toBe(1);
    expect((await q(nadia, 'SELECT id FROM app.polls WHERE id = $1', [poll['leads']])).length).toBe(0);
    expect((await q(priya, 'SELECT id FROM app.polls WHERE id = $1', [poll['leads']])).length).toBe(0);
    // Tariq is not on the Engineering team: he does not read its channels, so he sees no poll and may not vote
    expect((await q(tariq, 'SELECT id FROM app.polls WHERE id = $1', [poll['named']])).length).toBe(0);
    expect(await code(vote(tariq, poll['named']!, [0]))).toBeDefined();
  });

  it('a reader cannot vote in a private channel they cannot read', async () => {
    expect(await code(vote(nadia, poll['leads']!, [0]))).toBeDefined();
    expect(await totals(omar, poll['leads']!)).toMatchObject({ voter_count: 0 });
  });

  it('only the author changes a poll, and only by closing it; the question, the options and the totals cannot be edited', async () => {
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.polls SET closed_at = now(), closed_by = $2 WHERE id = $1', [poll['named'], rafi.actorId])))).toBeUndefined(); // row not visible to update: 0 rows
    expect((await totals(nadia, poll['named']!))?.voter_count).toBe(0);
    expect((await q<{ closed_at: string | null }>(nadia, 'SELECT closed_at FROM app.polls WHERE id = $1', [poll['named']]))[0]!.closed_at).toBeNull();
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.polls SET question = 'Other' WHERE id = $1`, [poll['named']])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.polls SET vote_counts = ARRAY[9,9,9] WHERE id = $1', [poll['named']])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.polls SET closed_at = now(), closed_by = $2 WHERE id = $1', [poll['named'], rafi.actorId])))).toBe('23514');
  });
});

describe('a named poll', () => {
  it('counts follow the ballots (insert, change, withdraw) and every reader of the channel sees the ballots', async () => {
    await vote(nadia, poll['named']!, [0]);
    await vote(rafi, poll['named']!, [2]);
    expect(await totals(priya, poll['named']!)).toEqual({ vote_counts: [1, 0, 1], voter_count: 2 });
    expect((await ballots(priya, poll['named']!)).map((b) => b.choices)).toEqual(expect.arrayContaining([[0], [2]]));
    await as(rafi, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[1]::smallint[] WHERE poll_id = $1 AND voter_id = $2', [poll['named'], rafi.actorId]));
    expect(await totals(nadia, poll['named']!)).toEqual({ vote_counts: [1, 1, 0], voter_count: 2 });
    await as(nadia, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['named'], nadia.actorId]));
    expect(await totals(nadia, poll['named']!)).toEqual({ vote_counts: [0, 1, 0], voter_count: 1 });
  });

  it('refuses a second ballot of the same person, a second choice in a single-choice poll, an unknown option, and a ballot in someone else’s name', async () => {
    expect(await code(vote(rafi, poll['named']!, [0]))).toBe('23505');
    expect(await code(vote(priya, poll['named']!, [0, 1]))).toBe('23514');
    expect(await code(vote(priya, poll['named']!, [3]))).toBe('23514');
    expect(await code(as(priya, (tx) => tx.query('INSERT INTO app.poll_votes (poll_id, voter_id, choices) VALUES ($1, $2, ARRAY[0]::smallint[])', [poll['named'], rafi.actorId])))).toBeDefined();
  });

  it('nobody can change or withdraw another person’s ballot', async () => {
    await as(priya, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[2]::smallint[] WHERE poll_id = $1 AND voter_id = $2', [poll['named'], rafi.actorId]));
    await as(omar, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['named'], rafi.actorId]));
    expect((await ballots(rafi, poll['named']!)).map((b) => b.choices)).toEqual([[1]]);
  });

  it('app.poll_voters names the voters of a named poll for a reader of the channel, and nobody for a reader outside it', async () => {
    const rows = await q<{ display_name: string; choices: number[] }>(priya, 'SELECT display_name, choices FROM app.poll_voters($1)', [poll['named']]);
    expect(rows).toEqual([{ display_name: rafi.name, choices: [1] }]);
    expect(await q(nadia, 'SELECT * FROM app.poll_voters($1)', [poll['leads']])).toEqual([]);
  });
});

describe('an anonymous poll', () => {
  it('shows every reader of the channel the totals', async () => {
    await vote(nadia, poll['anon']!, [0]);
    await vote(rafi, poll['anon']!, [0]);
    await vote(priya, poll['anon']!, [2]);
    for (const p of [omar, nadia, rafi, priya]) expect(await totals(p, poll['anon']!), p.key).toEqual({ vote_counts: [2, 0, 1], voter_count: 3 });
  });

  it('shows each voter their own ballot and nobody else’s: not another member, not the author, not a workspace admin', async () => {
    expect((await ballots(nadia, poll['anon']!)).map((b) => [b.voter_id, b.choices])).toEqual([[nadia.actorId, [0]]]);
    expect((await ballots(rafi, poll['anon']!)).map((b) => b.voter_id)).toEqual([rafi.actorId]);
    expect((await ballots(priya, poll['anon']!)).map((b) => b.voter_id)).toEqual([priya.actorId]);
    // omar is a workspace owner and admin and has not voted: nothing
    expect(await ballots(omar, poll['anon']!)).toEqual([]);
    // a person with no vote of their own, in the channel: nothing
    expect(await ballots(lena, poll['anon']!)).toEqual([]);
  });

  it('is unreadable to the system role too, and to a count over the table', async () => {
    const rows = await sys(async (tx) => (await tx.query('SELECT voter_id FROM app.poll_votes WHERE poll_id = $1', [poll['anon']])).rows);
    expect(rows).toEqual([]);
    expect(await sys(async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.poll_votes WHERE poll_id = $1', [poll['anon']])).rows[0]!.n)).toBe('0');
    expect(await q<{ n: string }>(omar, 'SELECT count(*) AS n FROM app.poll_votes WHERE poll_id = $1', [poll['anon']])).toEqual([{ n: '0' }]);
  });

  it('app.poll_voters returns nothing, to anyone', async () => {
    for (const p of [omar, nadia, rafi, priya]) expect(await q(p, 'SELECT * FROM app.poll_voters($1)', [poll['anon']]), p.key).toEqual([]);
  });

  it('a voter changes and withdraws their own ballot; the totals follow; others cannot touch it', async () => {
    await as(omar, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[1]::smallint[] WHERE poll_id = $1', [poll['anon']]));
    expect(await totals(omar, poll['anon']!)).toEqual({ vote_counts: [2, 0, 1], voter_count: 3 });
    await as(nadia, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[1]::smallint[] WHERE poll_id = $1 AND voter_id = $2', [poll['anon'], nadia.actorId]));
    expect(await totals(omar, poll['anon']!)).toEqual({ vote_counts: [1, 1, 1], voter_count: 3 });
    await as(nadia, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['anon'], nadia.actorId]));
    expect(await totals(omar, poll['anon']!)).toEqual({ vote_counts: [1, 0, 1], voter_count: 2 });
  });

  it('a several-choice poll counts each option once per voter and the voter once', async () => {
    await vote(nadia, poll['multi']!, [0, 2]);
    await vote(rafi, poll['multi']!, [2]);
    expect(await totals(priya, poll['multi']!)).toEqual({ vote_counts: [1, 0, 2], voter_count: 2 });
    expect(await code(vote(priya, poll['multi']!, [1, 1]))).toBe('23514');
  });

  it('the ballot rows of an anonymous poll are not returned through the poll either (no join exposes them)', async () => {
    const rows = await q(omar, 'SELECT p.id, v.voter_id FROM app.polls p JOIN app.poll_votes v ON v.poll_id = p.id WHERE p.id = $1', [poll['anon']]);
    expect(rows).toEqual([]);
  });
});

describe('closing', () => {
  it('a closed poll takes no vote and no withdrawal; a poll whose time has passed takes none either, before anything has recorded the closing', async () => {
    await makePoll('closing', ch['general']!, nadia);
    await vote(rafi, poll['closing']!, [0]);
    await as(nadia, (tx) => tx.query('UPDATE app.polls SET closed_at = now(), closed_by = $2 WHERE id = $1', [poll['closing'], nadia.actorId]));
    expect(await code(vote(priya, poll['closing']!, [0]))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['closing'], rafi.actorId])))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[1]::smallint[] WHERE poll_id = $1 AND voter_id = $2', [poll['closing'], rafi.actorId])))).toBe('23514');
    expect(await totals(priya, poll['closing']!)).toEqual({ vote_counts: [1, 0, 0], voter_count: 1 });

    await makePoll('late', ch['general']!, nadia, { closesAt: new Date(Date.now() + 3_600_000).toISOString() });
    await vote(rafi, poll['late']!, [0]);
    // the closing time passes without the minute job having run (the owner moves it into the past; triggers are off for this one statement)
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      await admin.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE app.polls SET closes_at = now() - interval '1 minute' WHERE id = '${poll['late']}'; COMMIT;`);
    } finally {
      await admin.end();
    }
    expect(await code(vote(priya, poll['late']!, [1]))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['late'], rafi.actorId])))).toBe('23514');
  });
});

describe('bots do not vote', () => {
  it('a bot actor cannot cast a ballot, even in a channel it can read', async () => {
    const botActor = await sys(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, uuidv7()) RETURNING id`,
      [omar.workspaceId],
    )).rows[0]!.id);
    const denied = await code(
      withActor({ kind: 'bot', id: botActor, workspaceId: omar.workspaceId } as never, (tx) => tx.query('INSERT INTO app.poll_votes (poll_id, voter_id, choices) VALUES ($1, $2, ARRAY[0]::smallint[])', [poll['named'], botActor]), { pool: appPool }),
    );
    expect(denied).toBeDefined();
    expect(await totals(omar, poll['named']!)).toMatchObject({ voter_count: 1 });
  });
});

describe('closing early (app.polls_close)', () => {
  const closeAs = (p: Persona, key: string): Promise<boolean> =>
    as(p, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.polls_close($1, NULL) AS ok', [poll[key]])).rows[0]!.ok);
  const closer = async (key: string): Promise<string | null> =>
    (await sys(async (tx) => (await tx.query<{ closed_by: string | null }>('SELECT closed_by FROM app.polls WHERE id = $1', [poll[key]])).rows[0]!)).closed_by;

  it('an ordinary reader and an outsider are refused; the author, an admin who leads the team, and the system role may close', async () => {
    await makePoll('c1', ch['general']!, nadia);
    await makePoll('c2', ch['general']!, nadia);
    await makePoll('c3', ch['general']!, nadia);
    expect(await code(closeAs(rafi, 'c1'))).toBe('42501');
    expect(await code(closeAs(tariq, 'c1'))).toBe('42501');
    expect(await closer('c1')).toBeNull();
    expect(await closeAs(nadia, 'c1')).toBe(true);
    expect(await closer('c1')).toBe(nadia.actorId);
    expect(await closeAs(omar, 'c2')).toBe(true); // owner, admin and lead of Engineering
    expect(await closer('c2')).toBe(omar.actorId);
    expect(await sys(async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.polls_close($1, NULL) AS ok', [poll['c3']])).rows[0]!.ok)).toBe(true);
    expect(await closer('c3')).toBeNull();
  });

  it('closing a closed poll changes nothing; a poll in a private channel is closed by nobody who cannot read it', async () => {
    expect(await closeAs(nadia, 'c1')).toBe(false);
    expect(await code(closeAs(nadia, 'leads'))).toBe('42501');
    expect(await closer('leads')).toBeNull();
  });
});

describe('locking a poll to close it (app.polls_lock)', () => {
  const lockAs = (p: Persona, key: string): Promise<void> => as(p, async (tx) => void (await tx.query('SELECT app.polls_lock($1)', [poll[key]])));

  it('works for whoever may close (an admin who is not the author finds the row although FOR UPDATE cannot see it), and refuses a reader and an outsider', async () => {
    await makePoll('l1', ch['general']!, nadia);
    const forUpdate = await as(omar, async (tx) => (await tx.query('SELECT id FROM app.polls WHERE id = $1 FOR UPDATE', [poll['l1']])).rows.length);
    expect(forUpdate).toBe(0); // the update policy is the author's alone: this is why the lock is a definer function
    await lockAs(omar, 'l1');
    await lockAs(nadia, 'l1');
    expect(await code(lockAs(rafi, 'l1'))).toBe('42501');
    expect(await code(lockAs(tariq, 'l1'))).toBe('42501');
  });
});

describe('the version', () => {
  it('goes up with every vote, withdrawal and close, by the database, whatever a caller writes', async () => {
    await makePoll('ver', ch['general']!, nadia);
    const version = async (): Promise<number> => (await q<{ version: number }>(omar, 'SELECT version FROM app.polls WHERE id = $1', [poll['ver']]))[0]!.version;
    expect(await version()).toBe(0);
    await vote(rafi, poll['ver']!, [0]);
    expect(await version()).toBe(1);
    await as(rafi, (tx) => tx.query('UPDATE app.poll_votes SET choices = ARRAY[2]::smallint[] WHERE poll_id = $1 AND voter_id = $2', [poll['ver'], rafi.actorId]));
    expect(await version()).toBe(2);
    await as(rafi, (tx) => tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = $2', [poll['ver'], rafi.actorId]));
    expect(await version()).toBe(3);
    await as(nadia, (tx) => tx.query('UPDATE app.polls SET closed_at = now(), closed_by = $2, version = 99 WHERE id = $1', [poll['ver'], nadia.actorId]));
    expect(await version()).toBe(4);
  });
});

describe('what a poll may say', () => {
  it('a line break or a control character in the question or an option, and two options alike once spaces and capitals are ignored, are refused', async () => {
    const insert = async (question: string, options: string[]): Promise<string | undefined> =>
      code(
        sys(async (tx) => {
          const m = (await tx.query<{ id: string }>(
            `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'Poll: Q', 'Poll: Q') RETURNING id`,
            [omar.workspaceId, ch['general'], nadia.actorId],
          )).rows[0]!.id;
          await tx.query(
            `INSERT INTO app.polls (workspace_id, channel_id, message_id, author_id, question, options, vote_counts) VALUES ($1, $2, $3, $4, $5, $6::text[], ARRAY[0,0])`,
            [omar.workspaceId, ch['general'], m, nadia.actorId, question, options],
          );
        }),
      );
    expect(await insert('Fine?', ['A', 'B'])).toBeUndefined();
    expect(await insert('Two\nlines', ['A', 'B'])).toBe('23514');
    expect(await insert('Q', ['A\nforged: 9 votes', 'B'])).toBe('23514');
    expect(await insert('Q', ['A\u2028B', 'C'])).toBe('23514');
    expect(await insert('Q', ['Bell\u0007', 'C'])).toBe('23514');
    expect(await insert('Q', ['Pizza  slice', ' pizza slice'])).toBe('23514');
  });
});

describe('a poll whose message was deleted', () => {
  it('takes no ballot', async () => {
    await makePoll('gone', ch['general']!, nadia);
    await sys((tx) => tx.query(`UPDATE app.messages SET deleted_at = now() WHERE id = (SELECT message_id FROM app.polls WHERE id = $1)`, [poll['gone']]));
    expect(await code(vote(rafi, poll['gone']!, [0]))).toBe('23514');
  });
});
