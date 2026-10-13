import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  answerMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  conversationsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-18: the asker's view of an answer. A bot's `answer.post` re-reads every cited source and everything its run reached AS THE PERSON WHO
// ASKED — the migration adds no policy of its own, it asks the platform's. Every assertion here runs through the app pool (what a request is),
// as a bot inside a run; the rows exist through the system role.

const { omar, nadia, rafi, priya } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const WS = omar.workspaceId;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>, runId?: string): Promise<T> =>
  withActor({ ...personaActor(p), ...(runId ? { runId } : {}) } as Actor, fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const asBot = <T>(actorId: string, runId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actorId, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: appPool });

interface Resolved {
  found: boolean;
  scope?: string;
  audience?: boolean;
  label?: string | null;
  channelId?: string;
  channelKind?: string;
  channelName?: string | null;
  threadRootId?: string | null;
  teamId?: string;
  botId?: string;
  botSlug?: string;
}
interface View {
  run: { runId: string; hasAsker: boolean; askerName: string | null; askerPersonId: string | null; private: boolean; alias: string | null; botSlug: string | null; channelId: string | null; replyRootId: string | null };
  citations: Resolved[];
  sources: Array<Resolved & { kind: string; ref: string; logScope: string }>;
  bots: Array<{ id: string; slug: string; name: string }>;
}
type Cite = { kind: string; ref: string; team?: string | null };

const viewAs = async (actorId: string, runId: string | undefined, cites: Cite[], slugs: string[] = []): Promise<View | { already: string } | null> =>
  asBot(actorId, runId, async (tx) => (await tx.query<{ v: View | { already: string } | null }>('SELECT app.answer_view($1::jsonb, $2::text[]) AS v', [JSON.stringify(cites), slugs])).rows[0]!.v);
const viewOf = async (actorId: string, runId: string, cites: Cite[], slugs: string[] = []): Promise<View> => {
  const v = await viewAs(actorId, runId, cites, slugs);
  if (v === null || 'already' in v) throw new Error(`no view: ${JSON.stringify(v)}`);
  return v;
};

let botId = '';
let botActor = '';
let otherBotId = '';
let otherBotActor = '';
// channels
let dev = '';
let leads = '';
let teamPrivate = '';
let dmOmarRafi = '';
let dmNadiaOmar = '';
let nadiaChat = '';
let rafiChat = '';
let omarChat = '';
// messages
let devMsg = '';
let leadsMsg = '';
let teamPrivateMsg = '';
let dmOmarRafiMsg = '';
let dmNadiaOmarMsg = '';
let nadiaRoot = '';
let nadiaChatMsg = '';
let rafiChatMsg = '';
let leadsFile = '';
let devFile = '';
let dmFile = '';
// runs
let nadiaConversation = '';
let omarConversation = '';
let rafiConversation = '';
let nadiaMention = '';
let teamRun = '';
let webhookRun = '';
let finishedRun = '';
let mentionRoot = '';

const message = (channel: string, author: string, text: string, root: string | null = null, meta: Record<string, unknown> = {}): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta) VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb) RETURNING id`,
          [WS, channel, author, text, root, JSON.stringify(meta)],
        )
      ).rows[0]!.id,
  );

const channel = (opts: { name: string; kind?: string; private?: boolean; team?: string | null; dmKey?: string | null; members?: Persona[] }): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [WS, opts.team === undefined ? ENG : opts.team, opts.name, opts.kind ?? 'channel', opts.private ?? false, opts.dmKey ?? null, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of opts.members ?? []) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });

const run = (opts: { trigger: string; asker: string | null; channel: string | null; root: string | null; status?: string }): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, reply_root_id, status, ended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, CASE WHEN $8::text = 'running' THEN NULL ELSE now() END) RETURNING id`,
          [WS, botId, ENG, opts.trigger, opts.asker, opts.channel, opts.root, opts.status ?? 'running'],
        )
      ).rows[0]!.id,
  );

const file = (channelId: string, name: string): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
           VALUES ($1, $2, '/docs/', $3, $4, 10, 'text/plain', repeat('a', 64), $5) RETURNING id`,
          [WS, channelId, name, randomUUID(), omar.actorId],
        )
      ).rows[0]!.id,
  );

const log = (runId: string, lines: Array<[string, string, string]>): Promise<void> =>
  sys(async (tx) => {
    let seq = 0;
    for (const [type, ref, scope] of lines) {
      await tx.query('INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, $2, $3, $4, $5)', [runId, seq, type, ref, scope]);
      seq += 1;
    }
  });

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      repoGitMigrationSource,
      botsMigrationSource,
      conversationsMigrationSource,
      answerMigrationSource,
    ],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  const makeBot = async (tx: Tx, slug: string, name: string): Promise<{ id: string; actor: string }> => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, $3, $4, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"conversation"},{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [WS, ENG, slug, name],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot.rows[0]!.id]);
    // a bot is a member of its team (as the loader makes it): it reads the team's public channels
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, actor.rows[0]!.id, WS]);
    return { id: bot.rows[0]!.id, actor: actor.rows[0]!.id };
  };
  await sys(async (tx) => {
    const brain = await makeBot(tx, 'brain', 'Brain');
    botId = brain.id;
    botActor = brain.actor;
    const other = await makeBot(tx, 'coder', 'Coder');
    otherBotId = other.id;
    otherBotActor = other.actor;
  });

  // places: a public channel, a private team channel only Omar sits in, a private one Nadia and Omar share, two DMs
  dev = await channel({ name: 'dev' });
  leads = await channel({ name: 'leads', private: true, members: [omar] });
  teamPrivate = await channel({ name: 'release-room', private: true, members: [omar, nadia] });
  dmOmarRafi = await channel({ name: '', kind: 'dm', private: true, team: null, dmKey: `${omar.personId}:${rafi.personId}`, members: [omar, rafi] });
  dmNadiaOmar = await channel({ name: '', kind: 'dm', private: true, team: null, dmKey: `${nadia.personId}:${omar.personId}`, members: [omar, nadia] });
  devMsg = await message(dev, omar.actorId, 'The deploy waits for the Monday window');
  leadsMsg = await message(leads, omar.actorId, 'Layoffs are planned for March');
  teamPrivateMsg = await message(teamPrivate, omar.actorId, 'Release room: cut the branch at noon');
  dmOmarRafiMsg = await message(dmOmarRafi, omar.actorId, 'A private word with Rafi');
  dmNadiaOmarMsg = await message(dmNadiaOmar, omar.actorId, 'A private word with Nadia');
  leadsFile = await file(leads, 'compensation.pdf');
  devFile = await file(dev, 'runbook.pdf');
  dmFile = await file(dmNadiaOmar, 'offer.pdf');

  // the conversations: each person's own channel with the bot (the one door), a first message and a run for the thread
  const open = async (p: Persona): Promise<string> =>
    as(p, async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [botId])).rows[0]!.channel_id);
  nadiaChat = await open(nadia);
  rafiChat = await open(rafi);
  omarChat = await open(omar);
  nadiaRoot = await message(nadiaChat, nadia.actorId, 'What is blocking the migration?');
  nadiaChatMsg = await message(nadiaChat, nadia.actorId, 'My private notes on the migration', nadiaRoot);
  const rafiRoot = await message(rafiChat, rafi.actorId, 'Rafi asks something private');
  rafiChatMsg = rafiRoot;
  const omarRoot = await message(omarChat, omar.actorId, 'Omar asks about the layoffs');
  nadiaConversation = await run({ trigger: 'conversation', asker: nadia.actorId, channel: nadiaChat, root: nadiaRoot });
  omarConversation = await run({ trigger: 'conversation', asker: omar.actorId, channel: omarChat, root: omarRoot });
  rafiConversation = await run({ trigger: 'conversation', asker: rafi.actorId, channel: rafiChat, root: rafiRoot, status: 'done' });
  mentionRoot = await message(dev, nadia.actorId, '@brain what is blocking the migration?');
  nadiaMention = await run({ trigger: 'mention', asker: nadia.actorId, channel: dev, root: mentionRoot });
  teamRun = await run({ trigger: 'mention', asker: rafi.actorId, channel: dev, root: mentionRoot, status: 'done' });
  webhookRun = await run({ trigger: 'webhook', asker: null, channel: dev, root: mentionRoot });
  finishedRun = await run({ trigger: 'conversation', asker: nadia.actorId, channel: nadiaChat, root: nadiaRoot, status: 'done' });

  // a page of Engineering's repo and one of Marketing's
  await sys(async (tx) => {
    for (const [team, path, sha] of [[ENG, 'pages/specs/schedule-migration.md', 'a'.repeat(40)], [MKT, 'pages/launch/plan.md', 'b'.repeat(40)]] as const) {
      await tx.query('INSERT INTO app.repo_commits (team_id, sha, message, committed_at, paths) VALUES ($1, $2, $3, $4, $5)', [team, sha, 'seed', '2026-09-29T08:00:00Z', [path]]);
      await tx.query('INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha) VALUES ($1, $2, $3, 10, $4)', [team, path, 'c'.repeat(40), sha]);
    }
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the view is the asker’s, not the bot’s and not anybody else’s', () => {
  it('reads a team channel, the person’s own conversation and nothing that is somebody else’s private place', async () => {
    const v = await viewOf(botActor, nadiaConversation, [
      { kind: 'message', ref: devMsg },
      { kind: 'message', ref: leadsMsg },
      { kind: 'message', ref: dmOmarRafiMsg },
      { kind: 'message', ref: rafiChatMsg },
      { kind: 'message', ref: nadiaChatMsg },
      { kind: 'message', ref: dmNadiaOmarMsg },
    ]);
    expect(v.citations.map((c) => c.found)).toEqual([true, false, false, false, true, true]);
    expect(v.citations[0]).toMatchObject({ scope: 'team', audience: true, channelKind: 'channel', channelName: 'dev', channelId: dev, label: 'The deploy waits for the Monday window' });
    // her own conversation and a DM she is in reach no further than the people of that place
    expect(v.citations[4]).toMatchObject({ scope: 'channel', channelKind: 'bot_conversation', channelName: null });
    expect(v.citations[5]).toMatchObject({ scope: 'channel', channelKind: 'dm', channelName: null });
    // the reply is her own conversation: everybody who reads it is her, so the reply's readers may see all she may
    expect(v.run).toMatchObject({ hasAsker: true, askerName: 'Nadia', askerPersonId: nadia.personId, private: true, alias: 'smart', botSlug: 'brain' });
    expect(v.citations.filter((c) => c.found).every((c) => c.audience === true)).toBe(true);
    // a source that is hidden carries no label, no channel, nothing
    expect(v.citations[1]).toEqual({ found: false });
    expect(JSON.stringify(v)).not.toContain('Layoffs');
  });

  it('is the same bot with a different asker and a different view: the lead’s run reads the lead’s private channel, the member’s does not', async () => {
    const forOmar = await viewOf(botActor, omarConversation, [{ kind: 'message', ref: leadsMsg }, { kind: 'file', ref: leadsFile }, { kind: 'message', ref: dmOmarRafiMsg }]);
    expect(forOmar.citations.map((c) => c.found)).toEqual([true, true, true]);
    expect(forOmar.run.askerName).toBe('Omar');
    const forNadia = await viewOf(botActor, nadiaConversation, [{ kind: 'message', ref: leadsMsg }, { kind: 'file', ref: leadsFile }, { kind: 'message', ref: dmOmarRafiMsg }]);
    expect(forNadia.citations.map((c) => c.found)).toEqual([false, false, false]);
  });

  it('goes back to the bot afterwards: the transaction’s actor is the bot again, and a second look is the same', async () => {
    const after = await asBot(botActor, nadiaConversation, async (tx) => {
      await tx.query('SELECT app.answer_view($1::jsonb, $2::text[])', [JSON.stringify([{ kind: 'message', ref: devMsg }]), []]);
      const me = (await tx.query<{ actor: string; kind: string }>("SELECT app.actor()::text AS actor, current_setting('app.actor_kind') AS kind")).rows[0]!;
      // and what a bot may read is still what a bot may read: the asker's private conversation is not in its visible set, only the run's own is
      const ids = (await tx.query<{ ids: string[] }>("SELECT app.visible_channel_ids('read') AS ids")).rows[0]!.ids;
      return { me, ids };
    });
    expect(after.me).toEqual({ actor: botActor, kind: 'bot' });
    expect(after.ids).toContain(nadiaChat);
    expect(after.ids).not.toContain(omarChat);
    expect(after.ids).not.toContain(rafiChat);
  });
});

describe('who may ask', () => {
  it('answers nobody but the live run’s own bot: not a person who carries the run id, not another bot, not a finished run, not no run', async () => {
    const cites = [{ kind: 'message', ref: devMsg }];
    expect(await as(nadia, async (tx) => (await tx.query('SELECT app.answer_view($1::jsonb, $2::text[]) AS v', [JSON.stringify(cites), []])).rows[0]!['v'], nadiaConversation)).toBeNull();
    expect(await viewAs(otherBotActor, nadiaConversation, cites)).toBeNull();
    expect(await viewAs(botActor, finishedRun, cites)).toBeNull();
    expect(await viewAs(botActor, undefined, cites)).toBeNull();
    // and the bot's own live run is answered
    expect(await viewAs(botActor, nadiaConversation, cites)).not.toBeNull();
    // there is no argument that names another run or another person: a run that is not live is nobody's to answer for, whoever asked it
    expect(await viewAs(botActor, rafiConversation, cites)).toBeNull();
  });

  it('answer_resolve is no way to read as someone else: it answers for whoever calls it', async () => {
    const asNadia = await as(nadia, async (tx) => (await tx.query<{ r: Resolved }>('SELECT app.answer_resolve($1, $2, NULL, $3::uuid, NULL, false) AS r', ['message', leadsMsg, ENG])).rows[0]!.r);
    expect(asNadia).toEqual({ found: false });
    const asOmar = await as(omar, async (tx) => (await tx.query<{ r: Resolved }>('SELECT app.answer_resolve($1, $2, NULL, $3::uuid, NULL, false) AS r', ['message', leadsMsg, ENG])).rows[0]!.r);
    expect(asOmar.found).toBe(true);
  });
});

describe('the people who will read the reply', () => {
  it('a reply in a team channel keeps what that channel may open and sets aside what only the asker can', async () => {
    const v = await viewOf(botActor, nadiaMention, [
      { kind: 'message', ref: devMsg },
      { kind: 'message', ref: dmNadiaOmarMsg },
      { kind: 'message', ref: teamPrivateMsg },
      { kind: 'message', ref: nadiaChatMsg },
      { kind: 'file', ref: devFile },
      { kind: 'file', ref: dmFile },
      { kind: 'message', ref: leadsMsg },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md' },
      { kind: 'page', ref: 'pages/launch/plan.md', team: MKT },
      { kind: 'run', ref: nadiaConversation },
      { kind: 'run', ref: rafiConversation },
      { kind: 'run', ref: teamRun },
    ]);
    expect(v.run).toMatchObject({ private: false, channelId: dev });
    const row = (i: number) => ({ found: v.citations[i]!.found, audience: v.citations[i]!.audience, scope: v.citations[i]!.scope });
    // readable by Nadia and by the channel
    expect(row(0)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(4)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(7)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(11)).toEqual({ found: true, audience: true, scope: 'team' });
    // readable by Nadia, not by the channel: a DM, a private room, her own conversation, a file in a DM, her own conversation run
    for (const i of [1, 2, 3, 5, 9]) expect(row(i), `citation ${i}`).toMatchObject({ found: true, audience: false });
    // not readable by Nadia at all: the lead's channel, Marketing's page, Rafi's conversation run
    for (const i of [6, 8, 10]) expect(row(i), `citation ${i}`).toEqual({ found: false });
    expect(v.citations[7]).toMatchObject({ teamId: ENG });
    expect(v.citations[11]).toMatchObject({ botSlug: 'brain' });
  });

  it('a run nobody asked reads as its bot: the team’s public channels, not the lead’s', async () => {
    const v = await viewOf(botActor, webhookRun, [{ kind: 'message', ref: devMsg }, { kind: 'message', ref: leadsMsg }, { kind: 'message', ref: nadiaChatMsg }]);
    expect(v.run).toMatchObject({ hasAsker: false, askerName: null, askerPersonId: null });
    expect(v.citations.map((c) => c.found)).toEqual([true, false, false]);
  });
});

describe('what the run reached', () => {
  it('is the run’s own source log, resolved as the asker, one entry per source; a source the asker may not read is not found', async () => {
    await log(nadiaConversation, [
      ['message', devMsg, 'channel'],
      ['message', devMsg, 'channel'],
      ['message', leadsMsg, 'channel'],
      ['memory', 'bank:team:engineering', 'team'],
      ['drive', 'doc-1', 'person'],
      ['file', devFile, 'channel'],
    ]);
    const v = await viewOf(botActor, nadiaConversation, []);
    expect(v.sources.map((s) => [s.kind, s.found, s.logScope])).toEqual([
      ['message', true, 'channel'],
      ['message', false, 'channel'],
      ['memory', true, 'team'],
      ['drive', true, 'person'],
      ['file', true, 'channel'],
    ]);
    // a source of no resolvable kind is judged by the line's own scope: a person's connection reaches the asker alone
    expect(v.sources.find((s) => s.kind === 'drive')).toMatchObject({ audience: true });
  });

  it('hands the lines to the run’s bot and its asker, and to no one else', async () => {
    const lines = (actor: Actor) => withActor(actor, async (tx) => (await tx.query('SELECT * FROM app.answer_run_sources()')).rows, { pool: appPool });
    const botActorRow = { kind: 'bot', id: botActor, workspaceId: WS, runId: nadiaConversation } as unknown as Actor;
    expect((await lines(botActorRow)).length).toBe(5 + 1);
    expect((await lines({ ...personaActor(nadia), runId: nadiaConversation } as Actor)).length).toBe(5 + 1);
    expect(await lines({ ...personaActor(rafi), runId: nadiaConversation } as Actor)).toEqual([]);
    expect(await lines({ ...personaActor(omar), runId: nadiaConversation } as Actor)).toEqual([]);
    expect(await lines({ kind: 'bot', id: otherBotActor, workspaceId: WS, runId: nadiaConversation } as unknown as Actor)).toEqual([]);
    expect(await lines(personaActor(nadia))).toEqual([]);
  });
});

describe('one answer per run, and what a hand-off may name', () => {
  it('says "already" once this run has posted its answer, and not for another run’s, or for a plain reply', async () => {
    // a plain reply of the bot in the thread, and an answer of another run: neither counts
    await message(nadiaChat, botActor, 'A plain reply', nadiaRoot);
    await message(nadiaChat, botActor, 'Another run’s answer', nadiaRoot, { answer: { version: 1 }, runId: randomUUID() });
    expect(await viewAs(botActor, nadiaConversation, [])).toMatchObject({ run: { runId: nadiaConversation } });
    const mine = await message(nadiaChat, botActor, 'This run’s answer', nadiaRoot, { answer: { version: 1 }, runId: nadiaConversation });
    expect(await viewAs(botActor, nadiaConversation, [])).toEqual({ already: mine });
  });

  it('finds the bots of the run’s team by slug, never the answering bot itself, and none of another team', async () => {
    const v = await viewOf(botActor, omarConversation, [], ['coder', 'brain', 'ghost']);
    expect(v.bots).toEqual([{ id: otherBotId, slug: 'coder', name: 'Coder' }]);
  });
});

describe('hostile input', () => {
  it('reads a reference that is not an id, a path that is a hundred thousand characters and a kind it does not know as "not found", and never raises', async () => {
    const v = await viewOf(botActor, omarConversation, [
      { kind: 'message', ref: "'; DROP TABLE app.messages; --" },
      { kind: 'message', ref: 'x'.repeat(100_000) },
      { kind: 'page', ref: 'p'.repeat(100_000) },
      { kind: 'page', ref: '../../etc/passwd', team: 'not-a-uuid' },
      { kind: 'memory', ref: 'concept' },
      { kind: 'thread', ref: randomUUID() },
      { kind: 'run', ref: randomUUID() },
      { kind: 'file', ref: randomUUID() },
    ]);
    expect(v.citations).toEqual(Array.from({ length: 8 }, () => ({ found: false })));
  });

  it('looks at no more than forty citations, however many are sent', async () => {
    const cites = Array.from({ length: 5_000 }, () => ({ kind: 'message', ref: devMsg }));
    const started = Date.now();
    const v = await viewOf(botActor, omarConversation, cites);
    expect(v.citations).toHaveLength(40);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('is not a way into another workspace or another team’s page: a team the asker is not on has no page for them', async () => {
    const v = await viewOf(botActor, nadiaConversation, [{ kind: 'page', ref: 'pages/launch/plan.md', team: MKT }]);
    expect(v.citations[0]).toEqual({ found: false });
    // Priya is on both teams: asked by her, the same page is found, and it is not the run's team's, so it does not reach a team channel
    const priyaRun = await run({ trigger: 'mention', asker: priya.actorId, channel: dev, root: mentionRoot });
    const forPriya = await viewOf(botActor, priyaRun, [{ kind: 'page', ref: 'pages/launch/plan.md', team: MKT }]);
    expect(forPriya.citations[0]).toMatchObject({ found: true, scope: 'channel', audience: false, teamId: MKT });
  });
});
