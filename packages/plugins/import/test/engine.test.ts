import { createHash, randomUUID } from 'node:crypto';
import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import type { MessageProvider, PluginTx } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channelBaseName, runImport, type RunInput } from '../src/engine.ts';
import type { ArchiveChannel, ArchiveMessage, ArchivePerson, ArchiveReader } from '../src/model.ts';
import { createWorld, personas, type World } from './world.ts';

const { omar } = personas;

// The engine against a real database with a reader made in the test, so a run can be cut off, cancelled or interrupted by a sign-in at an exact moment.
// (The whole path through an upload is in import-api.test.ts and import-run.test.ts.)

let w: World;
let sysPool: pg.Pool;
let provider: MessageProvider;
beforeAll(async () => {
  w = await createWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 3);
  const found = w.server.host.registries.providers.messages.values()[0];
  if (!found) throw new Error('the channels plugin did not register the messages provider');
  provider = found as MessageProvider;
}, 120_000);
afterAll(async () => {
  await sysPool.end();
  await w.close();
});

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => sys(async (tx) => (await tx.query<Record<string, T>>(sql, values)).rows[0]!['n'] as T);

/** A run row for the map to point at (import_map.run_id is a foreign key). */
const makeRun = (source: 'slack' | 'mattermost' = 'slack'): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.import_runs (workspace_id, source, team_id, file_name, size_bytes, sha256, created_by) VALUES ($1, $2, $3, 'x.zip', 1, $4, $5) RETURNING id`,
          [omar.workspaceId, source, TEAM_IDS.Engineering, createHash('sha256').update(randomUUID()).digest('hex'), omar.actorId],
        )
      ).rows[0]!.id,
  );

const BASE = Date.UTC(2024, 2, 4, 10, 0, 0);
const message = (channelKey: string, i: number, authorKey: string, over: Partial<ArchiveMessage> = {}): ArchiveMessage => ({
  channelKey,
  key: `${channelKey}:${i}`,
  at: BASE + i * 60_000,
  authorKey,
  text: `message ${i}`,
  rootKey: null,
  startsThread: false,
  reactions: [],
  files: [],
  skip: null,
  mentions: 0,
  shortened: false,
  ...over,
});

interface FakeOptions {
  people: ArchivePerson[];
  channels: ArchiveChannel[];
  messages: ArchiveMessage[];
  /** Runs when the importer asks for message number `at` (so everything before it has been handed on, and the batches before it are written). */
  before?: (at: number) => Promise<void>;
  nameOf?: (key: string) => string;
}
class FakeReader implements ArchiveReader {
  readonly source = 'slack' as const;
  readonly notes = new Map();
  constructor(private readonly o: FakeOptions) {
    if (o.nameOf) this.nameOf = o.nameOf;
  }
  nameOf?: (key: string) => string;
  people = (): Promise<ArchivePerson[]> => Promise.resolve(this.o.people);
  channels = (): Promise<ArchiveChannel[]> => Promise.resolve(this.o.channels);
  async *messages(): AsyncGenerator<ArchiveMessage> {
    for (let i = 0; i < this.o.messages.length; i += 1) {
      await this.o.before?.(i);
      yield this.o.messages[i]!;
    }
  }
  close = (): Promise<void> => Promise.resolve();
}

const input = (reader: ArchiveReader, runId: string, over: Partial<RunInput> = {}): RunInput => ({
  mode: 'real',
  transaction: (fn) => sys((tx) => fn(tx as unknown as PluginTx)),
  provider,
  reader,
  runId,
  workspaceId: omar.workspaceId,
  source: 'slack',
  teamId: TEAM_IDS.Engineering,
  startedBy: omar.actorId,
  ...over,
});

const omarPerson: ArchivePerson = { key: 'U-OMAR', name: 'Omar', email: 'omar@kahf.example', isBot: false };
const channel = (key: string, name: string, over: Partial<ArchiveChannel> = {}): ArchiveChannel => ({ key, name, kind: 'public', purpose: '', memberKeys: null, ...over });

describe('an author the archive does not describe', () => {
  it('is written under one stand-in, also when the run is cut off between batches and tried again', async () => {
    const msgs = Array.from({ length: 250 }, (_, i) => message('CRETRY', i, i % 2 === 0 ? 'U-OMAR' : 'U-GHOST'));
    const cutOff = new FakeReader({
      people: [omarPerson],
      channels: [channel('CRETRY', 'retry-room')],
      messages: msgs,
      before: (at) => (at === 150 ? Promise.reject(new Error('the server was killed')) : Promise.resolve()),
    });
    await expect(runImport(input(cutOff, await makeRun()))).rejects.toThrow('killed');
    // the first batch of 100 is written, with its stand-in
    expect(await one<number>("SELECT count(*)::int AS n FROM app.import_people WHERE source_id = 'U-GHOST'")).toBe(1);
    const whole = new FakeReader({ people: [omarPerson], channels: [channel('CRETRY', 'retry-room')], messages: msgs });
    const out = await runImport(input(whole, await makeRun()));
    expect(out.cancelled).toBe(false);
    expect(out.report.messages.alreadyImported).toBe(100);
    expect(out.report.messages.imported).toBe(150);
    expect(await one<number>("SELECT count(*)::int AS n FROM app.import_people WHERE source_id = 'U-GHOST'")).toBe(1);
    expect(await one<number>("SELECT count(*)::int AS n FROM app.import_map WHERE kind = 'message' AND source_id LIKE '%CRETRY:%'")).toBe(250);
    // and a longer archive that names the same stranger again does not trip over the stand-in either
    const longer = new FakeReader({ people: [omarPerson], channels: [channel('CRETRY', 'retry-room')], messages: [...msgs, message('CRETRY', 250, 'U-GHOST')] });
    const third = await runImport(input(longer, await makeRun()));
    expect(third.report.messages.imported).toBe(1);
    expect(third.report.messages.alreadyImported).toBe(250);
  });

  it('is named from the reader, not from the key it was filed under', async () => {
    const reader = new FakeReader({
      people: [omarPerson],
      channels: [channel('CNAME', 'name-room')],
      messages: [message('CNAME', 0, 'abc123def:stranger')],
      nameOf: (k) => k.slice(k.indexOf(':') + 1),
    });
    await runImport(input(reader, await makeRun()));
    expect(await one<string>("SELECT name AS n FROM app.import_people WHERE source_id = 'abc123def:stranger'")).toBe('Unknown (stranger)');
  });
});

describe('a cancel that came before anything was written', () => {
  it('makes no stand-in, no channel and no message', async () => {
    const before = {
      people: await one<number>('SELECT count(*)::int AS n FROM app.import_people'),
      channels: await one<number>('SELECT count(*)::int AS n FROM app.channels'),
      messages: await one<number>('SELECT count(*)::int AS n FROM app.messages'),
    };
    const reader = new FakeReader({
      people: [omarPerson, { key: 'U-NEW', name: 'New Person', email: 'new.person@kahf.example', isBot: false }],
      channels: [channel('CCANCEL', 'cancel-engine-room')],
      messages: [message('CCANCEL', 0, 'U-NEW')],
    });
    const out = await runImport(input(reader, await makeRun(), { shouldStop: () => Promise.resolve(true) }));
    expect(out.cancelled).toBe(true);
    expect(await one<number>('SELECT count(*)::int AS n FROM app.import_people')).toBe(before.people);
    expect(await one<number>('SELECT count(*)::int AS n FROM app.channels')).toBe(before.channels);
    expect(await one<number>('SELECT count(*)::int AS n FROM app.messages')).toBe(before.messages);
  });
});

describe('a person who signs in while a run is going', () => {
  /** An account with a verified address: the database moves everything the stand-in has written until now. */
  const signIn = async (email: string): Promise<{ person: string; actor: string }> =>
    sys(async (tx) => {
      const person = (await tx.query<{ id: string }>('INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, $2, $2) RETURNING id', [omar.workspaceId, email])).rows[0]!.id;
      await tx.query('INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now())', [omar.workspaceId, person, email]);
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id", [omar.workspaceId, person])).rows[0]!.id;
      return { person, actor };
    });
  const ownedBy = (actor: string): Promise<number> => one<number>('SELECT count(*)::int AS n FROM app.messages WHERE author_id = $1', [actor]);
  const reactionsBy = (actor: string): Promise<number> => one<number>('SELECT count(*)::int AS n FROM app.message_reactions WHERE actor_id = $1', [actor]);

  const archive = (room: string, email: string, count: number, before?: FakeOptions['before']): FakeReader =>
    new FakeReader({
      people: [omarPerson, { key: `U-${room}`, name: `Late ${room}`, email, isBot: false }],
      channels: [channel(room, `${room.toLowerCase()}-room`)],
      messages: Array.from({ length: count }, (_, i) => message(room, i, `U-${room}`, { reactions: [{ emoji: '🎉', userKeys: [`U-${room}`, 'U-OMAR'] }] })),
      ...(before ? { before } : {}),
    });
  const placeholderOf = (room: string): Promise<string> => one<string>('SELECT actor_id AS n FROM app.import_people WHERE source_id = $1', [`U-${room}`]);

  it('has the messages the run writes afterwards written as that person, not as the stand-in', async () => {
    let account: { person: string; actor: string } | undefined;
    const reader = archive('CLATE', 'late.one@kahf.example', 250, async (at) => {
      if (at === 100) account = await signIn('late.one@kahf.example');
    });
    const out = await runImport(input(reader, await makeRun()));
    expect(out.report.messages.imported).toBe(250);
    expect(account).toBeDefined();
    expect(await ownedBy(account!.actor)).toBe(250);
    expect(await ownedBy(await placeholderOf('CLATE'))).toBe(0);
    expect(await reactionsBy(await placeholderOf('CLATE'))).toBe(0);
    // each message has the person's reaction once, and the other reactor's
    expect(await one<number>('SELECT count(*)::int AS n FROM app.message_reactions WHERE actor_id = $1', [account!.actor])).toBe(250);
    expect(await one<number>('SELECT count(*)::int AS n FROM app.message_reactions r JOIN app.messages m ON m.id = r.message_id WHERE m.author_id = $1', [account!.actor])).toBe(500);
  });

  it('moves what was written in the batch that was open when the person signed in, when the run ends', async () => {
    let account: { person: string; actor: string } | undefined;
    const reader = archive('CLAST', 'late.two@kahf.example', 120);
    const out = await runImport(
      input(reader, await makeRun(), {
        // called inside the batch's own transaction, after its messages are written: the sign-in commits first, so it cannot see them
        onProgress: async (_tx, progress) => {
          if (progress.messagesDone === 120 && !account) account = await signIn('late.two@kahf.example');
        },
      }),
    );
    expect(out.report.messages.imported).toBe(120);
    expect(account).toBeDefined();
    expect(await ownedBy(await placeholderOf('CLAST'))).toBe(0);
    expect(await ownedBy(account!.actor)).toBe(120);
    expect(await reactionsBy(await placeholderOf('CLAST'))).toBe(0);
  });
});

describe('channel names', () => {
  it('fall back to the short name or id when the name has no letter or digit', () => {
    expect(channelBaseName(channel('C1', 'general', { slug: 'x' }))).toBe('general');
    expect(channelBaseName(channel('C1', 'قناة عامة', { slug: 'general-ar' }))).toBe('general-ar');
    expect(channelBaseName(channel('C0ARAB', '频道', { slug: 'C0ARAB' }))).toBe('C0ARAB');
    expect(channelBaseName(channel('C1', 'قناة'))).toBe('قناة');
    expect(channelBaseName(channel('C1', 'Café', { slug: 'x' }))).toBe('Café');
  });

  it('make a channel named from the slug instead of "channel", "channel-2"', async () => {
    const reader = new FakeReader({
      people: [omarPerson],
      channels: [channel('CAR1', 'قناة أولى', { slug: 'first-ar' }), channel('CAR2', '频道', { slug: 'second-cn' })],
      messages: [message('CAR1', 0, 'U-OMAR'), message('CAR2', 0, 'U-OMAR')],
    });
    const out = await runImport(input(reader, await makeRun()));
    expect(out.report.channelLines.map((c) => c.becomes).sort()).toEqual(['first-ar', 'second-cn']);
    const names = await sys(async (tx) => (await tx.query<{ name: string }>("SELECT name FROM app.channels WHERE name IN ('first-ar', 'second-cn') ORDER BY name")).rows.map((r) => r.name));
    expect(names).toEqual(['first-ar', 'second-cn']);
  });
});

describe('the same archive in another team', () => {
  it('makes its channels and messages there instead of finding the first team\'s, and stays the same when run again in either', async () => {
    const reader = (): FakeReader =>
      new FakeReader({ people: [omarPerson], channels: [channel('CTEAMS', 'both-teams')], messages: Array.from({ length: 5 }, (_, i) => message('CTEAMS', i, 'U-OMAR')) });
    const a = await runImport(input(reader(), await makeRun(), { teamId: TEAM_IDS.Engineering }));
    expect(a.report.channelLines[0]!.outcome).toBe('create');
    const b = await runImport(input(reader(), await makeRun(), { teamId: TEAM_IDS.Marketing }));
    expect(b.report.channelLines[0]!.outcome).toBe('create');
    expect(b.report.messages.imported).toBe(5);
    expect(b.report.messages.alreadyImported).toBe(0);
    const again = await runImport(input(reader(), await makeRun(), { teamId: TEAM_IDS.Engineering }));
    expect(again.report.channelLines[0]!.outcome).toBe('exists');
    expect(again.report.messages.alreadyImported).toBe(5);
    const placed = await sys(async (tx) => (await tx.query<{ team_id: string; n: number }>("SELECT c.team_id, count(*)::int AS n FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE c.name LIKE 'both-teams%' GROUP BY c.team_id")).rows);
    expect(placed.map((r) => r.n)).toEqual([5, 5]);
  });
});
