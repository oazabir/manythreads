import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool, emit } from '@manythreads/kernel';
import type { PluginRuns } from '@manythreads/sdk';
import { ListMemoryRetainLogResponse } from '@manythreads/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHindsight, type FakeHindsight, type FakeHindsightFact } from '../../../../tools/fake-hindsight/src/server.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// The whole feed, through the real server: events from real API calls, the outbox consumer, the job worker, the real memory-hindsight provider
// and tools/fake-hindsight as the engine. The reconcile table (what each source becomes) is test/feed-drain.test.ts; this file proves the wiring.

const { omar, nadia, rafi, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let fake: FakeHindsight;
let BANK = '';
let appPool: pg.Pool;
let systemPool: pg.Pool;
let runs: PluginRuns;
let devChannel = '';
let botId = '';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      // what the server said meanwhile: a drain that throws is otherwise invisible from here
      const said = w.server.logs.filter((l) => /memory|"level":(40|50)/.test(l)).slice(-12).map((l) => l.slice(0, 400));
      throw new Error(`timed out waiting for ${what}\n${said.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const facts = (bank = BANK): FakeHindsightFact[] => fake.state.banks.get(bank) ?? [];
const factWith = (text: string): FakeHindsightFact | undefined => facts().find((f) => f.text.includes(text));
const retainCalls = () => fake.state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
const logOf = (kind: string, id: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ outcome: string; reason: string; document_id: string | null; content_hash: string | null; channel_id: string | null; run_id: string | null; source_scopes: string[] }>(
          'SELECT outcome, reason, document_id, content_hash, channel_id, run_id, source_scopes FROM app.memory_retain_log WHERE source_kind = $1 AND source_id = $2 ORDER BY id',
          [kind, id],
        )
      ).rows,
  );
const pendingCount = () => w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_feed_pending')).rows[0]!.n);
const idle = () => until(async () => ((await pendingCount()) === 0 ? true : null), 'the feed work list to empty');

async function post(who: typeof nadia, channelId: string, body: string, threadRootId: string | null = null): Promise<string> {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function createChannel(name: string, priv: boolean): Promise<string> {
  const res = await w.call(omar, 'POST', '/api/teams/engineering/channels', { name, private: priv });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { channel: { id: string } }).channel.id;
}

async function enqueue(queue: string): Promise<void> {
  await w.system(async (tx) => {
    const job = (await tx.query<{ id: string }>("SELECT (app.enqueue_job($1, '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id", [queue])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
    await tx.query("SELECT pg_notify('manythreads_jobs', $1)", [queue]);
  });
}

async function openRun(trigger: string, options: { channelId?: string; lines?: Array<[string, string, string]>; bot?: string } = {}): Promise<string> {
  const { run } = await runs.open({
    botId: options.bot ?? botId,
    teamId: ENG,
    workspaceId: omar.workspaceId,
    trigger,
    askerActorId: nadia.actorId,
    ...(options.channelId ? { channelId: options.channelId } : {}),
  });
  for (const [i, [type, ref, scope]] of (options.lines ?? []).entries()) {
    await w.system((tx) => tx.query('INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, $2, $3, $4, $5)', [run.runId, i, type, ref, scope]));
  }
  return run.runId;
}

beforeAll(async () => {
  fake = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
  // The debounce, the wait for a run and the first back-off are minutes in production; here they are a fraction of a second.
  process.env['MANYTHREADS_MEMORY_DEBOUNCE_MS'] = '0';
  process.env['MANYTHREADS_MEMORY_DEFER_MS'] = '300';
  process.env['MANYTHREADS_MEMORY_BACKOFF_MS'] = '300';
  w = await createRepoWorld();
  const slug = await w.system(async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.workspaces LIMIT 1')).rows[0]!.slug);
  BANK = `team:${slug}:engineering`;
  await w.call(omar, 'GET', '/api/teams/engineering/channels'); // template channels exist once the directory is first asked for
  devChannel = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.channels WHERE team_id = $1 AND name = 'dev'", [ENG])).rows[0]!.id);

  appPool = createAppPool(w.server.db.appUrl, 4);
  systemPool = createSystemPool(w.server.db.systemUrl, 4);
  const registry = new CapabilityRegistry();
  runs = createRunService({ pool: appPool, systemPool, registry, broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });

  // a bot on the roster of Engineering (a real bots row, so its runs and its messages can be told together)
  await w.system(async (tx) => {
    botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'scribe', 'Scribe', '', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actor, omar.workspaceId]);
  });
}, 240_000);

afterAll(async () => {
  for (const name of ['MANYTHREADS_HINDSIGHT_URL', 'MANYTHREADS_MEMORY_DEBOUNCE_MS', 'MANYTHREADS_MEMORY_DEFER_MS', 'MANYTHREADS_MEMORY_BACKOFF_MS']) delete process.env[name];
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
  await fake?.close();
});

describe('a message in a public channel', () => {
  let messageId = '';
  let documentId = '';

  it('is retained to its team’s bank with source, actor, time and link, and nothing names another bank', async () => {
    messageId = await post(nadia, devChannel, 'The Basilisk migration freezes writes on Friday evening.');
    const fact = await until(async () => factWith('Basilisk'), 'the message to be retained');
    expect(fact.text).toBe(`Nadia wrote in #dev on ${fact.metadata['occurred_at']!.slice(0, 16).replace('T', ' ')}:\nThe Basilisk migration freezes writes on Friday evening.`);
    expect(fact.metadata).toMatchObject({
      source: 'platform',
      team: 'engineering',
      feed_kind: 'message',
      feed_id: messageId,
      actor: nadia.actorId,
      actor_name: 'Nadia',
      link: `/t/engineering/c/dev?message=${messageId}`,
      channel: 'dev',
    });
    expect(fact.tags).toEqual(['feed', 'kind:message', 'channel:dev']);
    documentId = fact.documentId;
    expect(documentId).toMatch(new RegExp(`^feed:message:${messageId}:[0-9a-f]{16}$`));
    expect(fake.banksTouched()).toEqual([BANK]);
    await idle(); // the log line commits with the work row's removal, a moment after the engine has the text
    expect(await logOf('message', messageId)).toMatchObject([{ outcome: 'retained', document_id: documentId, channel_id: devChannel }]);
  });

  it('is retained once however often the event arrives again', async () => {
    const before = retainCalls().length;
    for (let i = 0; i < 3; i += 1) {
      await w.system((tx) =>
        emit(tx, { type: 'channel.message.posted', schemaVersion: 1, workspaceId: omar.workspaceId, channelId: devChannel, teamId: ENG, messageId, authorId: nadia.actorId, threadRootId: null }),
      );
    }
    await idle();
    // a marker message behind the three events: when it is retained, they have all been handled
    const marker = await post(nadia, devChannel, 'Marker behind the repeated events.');
    await until(async () => factWith('Marker behind'), 'the marker');
    await idle();
    expect(retainCalls().length - before).toBe(1); // only the marker's call
    expect(await logOf('message', messageId)).toHaveLength(1);
    expect(facts().filter((f) => f.documentId === documentId)).toHaveLength(1);
    expect(await logOf('message', marker)).toHaveLength(1);
  });

  it('an edit replaces it: the old text is gone and the new one is there, under a new document', async () => {
    const res = await w.call(nadia, 'PATCH', `/api/channels/${devChannel}/messages/${messageId}`, { body: 'The Basilisk migration now freezes writes on Thursday night.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await until(async () => factWith('Thursday night'), 'the edited text');
    await idle();
    expect(factWith('Friday evening')).toBeUndefined();
    const lines = await logOf('message', messageId);
    expect(lines.map((l) => [l.outcome, l.reason])).toEqual([['retained', ''], ['forgotten', 'replaced'], ['retained', '']]);
    expect(lines[0]!.document_id).toBe(documentId);
    expect(lines[2]!.document_id).not.toBe(documentId);
    expect(facts().filter((f) => f.metadata['feed_id'] === messageId)).toHaveLength(1);
  });

  it('is forgotten when it is deleted', async () => {
    const res = await w.call(nadia, 'DELETE', `/api/channels/${devChannel}/messages/${messageId}`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => (factWith('Thursday night') ? null : true), 'the message to be forgotten');
    await idle();
    expect((await logOf('message', messageId)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'deleted' });
  });
});

describe('what is never retained', () => {
  it('a private channel, a DM and a bot conversation leave the bank, the work list and the log untouched', async () => {
    const priv = await createChannel('war-room', true);
    const secret = await post(omar, priv, 'Layoffs are planned for June, tell nobody.');
    const dm = await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect(dm.status, JSON.stringify(dm.body)).toBeLessThan(300);
    const dmChannel = (dm.body as { dm: { channel: { id: string } } }).dm.channel.id;
    const whisper = await post(nadia, dmChannel, 'Keep this between us: I am interviewing elsewhere.');

    // a public message behind them: once it is retained the two before it have been handled
    await post(nadia, devChannel, 'Control note: standup moves to ten.');
    await until(async () => factWith('Control note'), 'the control message');
    await idle();
    const everything = JSON.stringify(fake.state.calls);
    expect(everything).not.toMatch(/Layoffs|interviewing|between us/);
    for (const id of [secret, whisper]) expect(await logOf('message', id)).toEqual([]);
  });

  it('a channel made private takes its messages out of the bank: by its event, and by the sweep when there was no event', async () => {
    const byEvent = await createChannel('soon-private', false);
    const sweep = await createChannel('soon-private-too', false);
    const a = await post(omar, byEvent, 'Roadmap draft: the Osprey rewrite is Q4.');
    const b = await post(omar, sweep, 'Roadmap draft: the Heron rewrite is Q1.');
    await until(async () => (factWith('Osprey') && factWith('Heron') ? true : null), 'both messages to be retained');

    await w.system(async (tx) => {
      await tx.query('UPDATE app.channels SET private = true WHERE id = $1', [byEvent]);
      await emit(tx, { type: 'channel.channel.updated', schemaVersion: 1, workspaceId: omar.workspaceId, channelId: byEvent, teamId: ENG, changes: {} });
    });
    await until(async () => (factWith('Osprey') ? null : true), 'the privatised channel to be forgotten');
    await idle();
    expect((await logOf('message', a)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'not_team_visible' });
    expect(factWith('Heron')).toBeDefined(); // the other channel was not touched

    // an operator's change leaves no event: the hourly sweep finds it
    await w.system((tx) => tx.query('UPDATE app.channels SET private = true WHERE id = $1', [sweep]));
    await enqueue('memory.reconcile');
    await until(async () => (factWith('Heron') ? null : true), 'the sweep to forget the second channel');
    await idle();
    expect((await logOf('message', b)).at(-1)).toMatchObject({ outcome: 'forgotten', reason: 'not_team_visible' });
  });
});

describe('a thread', () => {
  it('is one document that follows its replies', async () => {
    const root = await post(nadia, devChannel, 'Can we ship the gateway on Friday?');
    await until(async () => factWith('ship the gateway'), 'the root');
    await post(rafi, devChannel, 'Only after the Kestrel review is done.', root);
    const thread = await until(async () => facts().find((f) => f.metadata['feed_kind'] === 'thread' && f.metadata['feed_id'] === root), 'the thread document');
    expect(thread.text).toContain('Nadia: Can we ship the gateway on Friday?');
    expect(thread.text).toContain('Rafi: Only after the Kestrel review is done.');
    await until(async () => (facts().some((f) => f.metadata['feed_kind'] === 'message' && f.metadata['feed_id'] === root) ? null : true), "the root's own document to go");
    expect(facts().filter((f) => f.text.includes('ship the gateway'))).toHaveLength(1);
  });
});

describe('a run', () => {
  it('that read only team-visible sources is summarised into the bank when it closes', async () => {
    const pub = await post(nadia, devChannel, 'Public note for the run to read.');
    const id = await openRun('mention', { channelId: devChannel, lines: [['memory', `bank:${BANK}`, 'team'], ['message', pub, 'channel']] });
    expect(await runs.close(id, 'done')).toBe(true);
    const fact = await until(async () => facts().find((f) => f.metadata['feed_kind'] === 'run' && f.metadata['feed_id'] === id), 'the run summary');
    expect(fact.text).toContain('The bot Scribe of team engineering ran for a mention in #dev, asked by Nadia.');
    expect(fact.text).toContain('It read 2 sources: 1 memory, 1 message.');
    expect(fact.metadata).toMatchObject({ actor: nadia.actorId, link: '/t/engineering/bots/scribe', status: 'done' });
    await idle();
    expect(await logOf('run', id)).toMatchObject([{ outcome: 'retained', run_id: id, source_scopes: ['channel', 'team'] }]);
  });

  it('closed twice is one event: the second close writes nothing', async () => {
    const id = await openRun('routine');
    expect(await runs.close(id, 'done')).toBe(true);
    expect(await runs.close(id, 'failed')).toBe(false);
    const events = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'bots.run.closed' AND payload ->> 'runId' = $1", [id])).rows[0]!.n);
    expect(events).toBe(1);
  });

  it('that read a person-scoped source is withheld, and the log says why; nothing of it reaches the engine', async () => {
    const before = JSON.stringify(fake.state.calls).length;
    const id = await openRun('mention', { lines: [['drive', 'x', 'person']] });
    await runs.close(id, 'done');
    await until(async () => ((await logOf('run', id)).length > 0 ? true : null), 'the withheld line');
    expect(await logOf('run', id)).toMatchObject([{ outcome: 'withheld', reason: 'person_source', run_id: id, document_id: null }]);
    expect(facts().some((f) => f.metadata['feed_id'] === id)).toBe(false);
    expect(JSON.stringify(fake.state.calls).slice(before)).not.toContain(id);
  });

  it('of a private conversation leaves nothing: no document, no line, no work left over', async () => {
    const id = await openRun('conversation');
    await runs.close(id, 'done');
    // a public message behind the close: once it is in the bank the run's event has been handled
    await post(nadia, devChannel, 'Control note behind the conversation run: Plover.');
    await until(async () => factWith('Plover'), 'the control message');
    await idle();
    expect(await logOf('run', id)).toEqual([]);
    expect(JSON.stringify(fake.state.calls)).not.toContain(id);
  });
});

describe('what a bot wrote', () => {
  it('is held back while its run is open and judged by what that run read once it closes', async () => {
    // a bot of its own: the runs of the tests above ended a moment ago and would cover the instant of this message too
    const writer = await w.system(async (tx) => {
      const bot = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
           VALUES ($1, $2, 'ghost', 'Ghost', '', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot])).rows[0]!.id;
      await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actor, omar.workspaceId]);
      return { bot, actor };
    });
    const id = await openRun('mention', { channelId: devChannel, bot: writer.bot, lines: [['drive', 'finance/q3.xlsx', 'person']] });
    const res = await w.call({ kind: 'bot', actorId: writer.actor, workspaceId: omar.workspaceId }, 'POST', `/api/channels/${devChannel}/messages`, {
      channelId: devChannel,
      body: 'Zanzibar quarterly numbers: revenue is 4.2 million.',
      threadRootId: null,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const messageId = (res.body as { id: string }).id;
    // open: deferred, and visibly so
    await until(async () => w.system(async (tx) => ((await tx.query("SELECT 1 FROM app.memory_feed_pending WHERE source_id = $1 AND deferred_since IS NOT NULL", [messageId])).rows.length > 0 ? true : null)), 'the message to be deferred');
    expect(factWith('Zanzibar')).toBeUndefined();
    await runs.close(id, 'done');
    await until(async () => ((await logOf('message', messageId)).length > 0 ? true : null), 'the verdict');
    expect(await logOf('message', messageId)).toMatchObject([{ outcome: 'withheld', reason: 'authoring run: person_source' }]);
    expect(factWith('Zanzibar')).toBeUndefined();
  });
});

describe('an approval and a page', () => {
  it('a decided approval is retained from its event, without its arguments', async () => {
    const approvalId = await w.system(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, requester_name, bot_id, decided_at)
           VALUES ($1, $2, 'grant', 'approved', 'ran', 'pages.write', 'Write pages/reports/q3.md', '{"path":"pages/reports/q3.md"}',
                   '{"kind":"handoff","payload":{"secret":"hunter2"}}', '{"roles":[],"people":[],"leads":true}', $3, 'Nadia', $4, now()) RETURNING id`,
          [omar.workspaceId, ENG, nadia.actorId, botId],
        )
      ).rows[0]!.id;
      await tx.query(
        "INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision) VALUES ($1, $2, $3, $4, 'Omar', 'approved')",
        [id, omar.workspaceId, ENG, omar.actorId],
      );
      await emit(tx, { type: 'approvals.approval.decided', schemaVersion: 1, workspaceId: omar.workspaceId, teamId: ENG, approvalId: id, source: 'grant', tool: 'pages.write', botId, requesterId: nadia.actorId, deciderId: omar.actorId, decision: 'approved' });
      return id;
    });
    const fact = await until(async () => facts().find((f) => f.metadata['feed_id'] === approvalId), 'the approval');
    expect(fact.text).toContain('Approval requested by Scribe (for Nadia): Write pages/reports/q3.md');
    expect(fact.text).toContain('Approved by Omar');
    expect(JSON.stringify(fact)).not.toContain('hunter2');
  });

  it('a page written through the API is retained, replaced by a rewrite and forgotten when it is deleted', async () => {
    const path = 'pages/memory-feed.md';
    const created = await w.call(omar, 'POST', '/api/teams/engineering/pages/write', { mode: 'create', path, content: '# Feed notes\n\nThe Peregrine plan is approved.\n' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const fact = await until(async () => factWith('Peregrine'), 'the page');
    expect(fact.metadata).toMatchObject({ feed_kind: 'page', path, actor: omar.actorId, link: `/t/engineering/files?open=${encodeURIComponent(path)}` });

    const replaced = await w.call(omar, 'POST', '/api/teams/engineering/pages/write', { mode: 'replace', path, content: '# Feed notes\n\nThe Peregrine plan is postponed to spring.\n' });
    expect(replaced.status, JSON.stringify(replaced.body)).toBeLessThan(300);
    await until(async () => factWith('postponed to spring'), 'the rewritten page');
    await idle();
    expect(factWith('is approved')).toBeUndefined();

    const deleted = await w.commit(omar, 'engineering', [{ op: 'delete', path }], 'Remove the notes');
    expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
    await until(async () => (factWith('Peregrine') ? null : true), 'the page to be forgotten');
  });
});

describe('what people do to pages and channels outside the feed’s own routes', () => {
  it('a page saved from the Files screen (a plain repo commit) is fed, replaced by the next save, and forgotten when deleted', async () => {
    const path = 'pages/from-files-screen.md';
    const created = await w.commit(omar, 'engineering', [{ op: 'put', path, content: '# Notes\n\nThe API key is sk-live-Tanager-1234.\n' }], 'Add notes from the Files screen');
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    await until(async () => factWith('Tanager'), 'a page that no pages.write made');
    // the person notices the pasted secret and saves again without it: the old document must go
    const saved = await w.commit(omar, 'engineering', [{ op: 'put', path, content: '# Notes\n\nThe API key lives in the vault.\n' }], 'Remove the pasted key');
    expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
    await until(async () => factWith('lives in the vault'), 'the saved page');
    await idle();
    expect(factWith('Tanager')).toBeUndefined();
    const gone = await w.commit(omar, 'engineering', [{ op: 'delete', path }], 'Remove the notes');
    expect(gone.status, JSON.stringify(gone.body)).toBeLessThan(300);
    await until(async () => (factWith('lives in the vault') ? null : true), 'the page to be forgotten');
  });

  it('a channel rename re-reads its documents: they say the new name', async () => {
    const channel = await createChannel('old-name', false);
    await post(omar, channel, 'Rename test note about the Skylark rollout.');
    const before = await until(async () => factWith('Skylark'), 'the note');
    expect(before.text).toContain('in #old-name');
    const renamed = await w.call(omar, 'PATCH', `/api/channels/${channel}`, { name: 'new-name' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    await until(async () => (factWith('Skylark')?.text.includes('in #new-name') ? true : null), 'the document to say the new name');
    await idle();
    expect(facts().filter((f) => f.text.includes('Skylark'))).toHaveLength(1);
  });
});

describe('the engine', () => {
  it('a burst of messages is a few batched calls of at most 25 items, and all of it arrives', async () => {
    const before = retainCalls().length;
    const bodies = Array.from({ length: 30 }, (_, i) => `Burst note ${i} about the Merlin deployment.`);
    for (const body of bodies) await post(nadia, devChannel, body);
    await until(async () => (facts().filter((f) => f.text.includes('Merlin deployment')).length === 30 ? true : null), 'all thirty notes');
    const calls = retainCalls().slice(before);
    expect(calls.length).toBeLessThan(30);
    for (const c of calls) expect((c.body as { items: unknown[] }).items.length).toBeLessThanOrEqual(25);
    expect(calls.every((c) => (c.body as { async?: boolean }).async === true)).toBe(true);
  });

  it('being switched off does not lose a delete: the document leaves the bank when the engine is back', async () => {
    const id = await post(nadia, devChannel, 'Written while the engine was on: the Bunting codename is Orchid.');
    await until(async () => factWith('Bunting'), 'the message');
    await idle();
    delete process.env['MANYTHREADS_HINDSIGHT_URL'];
    const res = await w.call(nadia, 'DELETE', `/api/channels/${devChannel}/messages/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    // the engine is off: nothing can be forgotten yet, but the delete is not dropped — its work row waits
    await until(async () => w.system(async (tx) => ((await tx.query('SELECT 1 FROM app.memory_feed_pending WHERE source_id = $1', [id])).rows.length > 0 ? true : null)), 'the delete to be remembered');
    expect(factWith('Bunting')).toBeDefined();
    process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
    await until(async () => (factWith('Bunting') ? null : true), 'the document to be forgotten once the engine is back', 60_000);
    await idle();
    expect((await logOf('message', id)).map((l) => l.outcome).filter((o) => o !== 'not_configured')).toEqual(['retained', 'forgotten']);
  });

  it('being down delays the feed and never blocks an event; when it is back the message arrives', async () => {
    process.env['MANYTHREADS_HINDSIGHT_URL'] = 'http://127.0.0.1:1'; // nothing listens there
    const id = await post(nadia, devChannel, 'Written while the engine was down: the Condor cutover is Monday.');
    // the message itself and every other plugin's handling of its event are unaffected; the feed keeps it in its work list and backs off
    await until(async () => w.system(async (tx) => ((await tx.query("SELECT 1 FROM app.memory_feed_pending WHERE source_id = $1 AND attempts > 0 AND last_error <> ''", [id])).rows.length > 0 ? true : null)), 'a failed attempt');
    expect(factWith('Condor')).toBeUndefined();
    const dead = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.outbox WHERE dead_at IS NOT NULL')).rows[0]!.n);
    expect(dead).toBe(0);
    process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
    await until(async () => factWith('Condor'), 'the message once the engine is back');
    await idle();
    expect((await logOf('message', id)).map((l) => l.outcome)).toEqual(['retained']);
  });
});

describe('GET /api/teams/:slug/memory/retain-log', () => {
  it('is read by the team’s lead, newest first, filterable, and carries no retained text', async () => {
    const all = await w.call(omar, 'GET', '/api/teams/engineering/memory/retain-log?limit=200');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const parsed = ListMemoryRetainLogResponse.parse(all.body);
    expect(parsed.items.length).toBeGreaterThan(10);
    const ids = parsed.items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(parsed.items.map((i) => i.bank))).toEqual(new Set([BANK]));
    expect(JSON.stringify(all.body)).not.toMatch(/Basilisk|Zanzibar|Peregrine|Merlin|hunter2/);

    const withheld = ListMemoryRetainLogResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/memory/retain-log?outcome=withheld')).body);
    expect(withheld.items.length).toBeGreaterThanOrEqual(2);
    expect(withheld.items.every((i) => i.outcome === 'withheld')).toBe(true);
    expect(withheld.items.map((i) => i.reason)).toEqual(expect.arrayContaining(['person_source', 'authoring run: person_source']));

    const page = ListMemoryRetainLogResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/memory/retain-log?limit=5')).body);
    expect(page.items).toHaveLength(5);
    expect(page.next).toBe(page.items[4]!.id);
    const second = ListMemoryRetainLogResponse.parse((await w.call(omar, 'GET', `/api/teams/engineering/memory/retain-log?limit=5&before=${page.next}`)).body);
    expect(second.items[0]!.id < page.items[4]!.id).toBe(true);
  });

  it('is refused to a member of the team, to the lead of another team and to someone with no session', async () => {
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/memory/retain-log')).status).toBe(403);
    expect((await w.call(tariq, 'GET', '/api/teams/engineering/memory/retain-log')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/teams/engineering/memory/retain-log')).status).toBe(401);
  });
});
