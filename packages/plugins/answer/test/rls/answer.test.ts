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
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-18: the asker's view of an answer. A bot's `answer.post` re-reads every cited source and everything its run reached AS THE PERSON WHO
// ASKED — the migration adds no policy of its own, it asks the platform's. Every assertion here runs through the app pool (what a request is),
// as a bot inside a run; the rows exist through the system role.

const { omar, nadia, rafi, priya, lena, sameera } = personas;
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
  reached?: boolean;
  channelId?: string;
  channelKind?: string;
  channelName?: string | null;
  threadRootId?: string | null;
  teamId?: string;
  botId?: string;
  botSlug?: string;
}
interface View {
  run: { reach?: string; runId: string; hasAsker: boolean; askerName: string | null; askerPersonId: string | null; private: boolean; alias: string | null; botSlug: string | null; channelId: string | null; replyRootId: string | null; logTruncated?: boolean };
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
let teamRun = '';
let finishedRun = '';
let mentionRoot = '';
// more places and messages
let devMsg2 = '';
let devReply = '';
let guestOpen = '';
let guestOpenMsg = '';
let otherTeamOpen = '';
let otherTeamOpenMsg = '';
let teamAclOpen = '';
let staleMember = '';
let omarConversationRoot = '';

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

/** SQL as the database owner (what a migration or an operator can do): a way to arrange a state the guards of the app refuse to produce. */
const asOwner = async (sql: string): Promise<void> => {
  const owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query(sql);
  } finally {
    await owner.end();
  }
};

const acl = (channelId: string, subject: 'person' | 'team', subjectId: string): Promise<void> =>
  sys(async (tx) => {
    await tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, $3, $4, 'read')`,
      [WS, channelId, subject, subjectId],
    );
  });

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
  omarConversationRoot = omarRoot;
  nadiaConversation = await run({ trigger: 'conversation', asker: nadia.actorId, channel: nadiaChat, root: nadiaRoot });
  omarConversation = await run({ trigger: 'conversation', asker: omar.actorId, channel: omarChat, root: omarRoot });
  rafiConversation = await run({ trigger: 'conversation', asker: rafi.actorId, channel: rafiChat, root: rafiRoot, status: 'done' });
  mentionRoot = await message(dev, nadia.actorId, '@brain what is blocking the migration?');
  teamRun = await run({ trigger: 'mention', asker: rafi.actorId, channel: dev, root: mentionRoot, status: 'done' });
  finishedRun = await run({ trigger: 'conversation', asker: nadia.actorId, channel: nadiaChat, root: nadiaRoot, status: 'done' });

  // a second readable message in #dev, and a reply in the thread of the first (a search can hit a reply)
  devMsg2 = await message(dev, omar.actorId, 'Nobody searched for this one');
  devReply = await message(dev, rafi.actorId, 'The window opens at nine', devMsg);

  // channels whose readers are not all on Engineering: a guest with a grant, a person of another team with one; and ones whose are
  guestOpen = await channel({ name: 'guest-open' });
  guestOpenMsg = await message(guestOpen, omar.actorId, 'A note a guest may also read');
  await acl(guestOpen, 'person', lena.personId);
  otherTeamOpen = await channel({ name: 'support-liaison' });
  otherTeamOpenMsg = await message(otherTeamOpen, omar.actorId, 'A note Customer support may also read');
  await acl(otherTeamOpen, 'person', sameera.personId);
  teamAclOpen = await channel({ name: 'eng-by-grant' });
  await acl(teamAclOpen, 'team', ENG);
  // a membership row of somebody who is not on the team: it gives no access (channels 0004), so it makes nobody a reader
  staleMember = await channel({ name: 'stale-member', members: [sameera] });

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

type Line = [string, string, string];

/** A run of the bot with some lines already in its source log: what it "reached". */
const reachedRun = async (opts: { trigger: string; asker: string | null; channel: string | null; root: string | null; status?: string }, lines: Line[]): Promise<string> => {
  const id = await run(opts);
  if (lines.length > 0) await log(id, lines);
  return id;
};
const inNadiaChat = (lines: Line[]): Promise<string> => reachedRun({ trigger: 'conversation', asker: nadia.actorId, channel: nadiaChat, root: nadiaRoot }, lines);
const inDev = (asker: string | null, lines: Line[], trigger = 'mention'): Promise<string> => reachedRun({ trigger, asker, channel: dev, root: mentionRoot }, lines);

describe('the view is the asker’s, not the bot’s and not anybody else’s', () => {
  it('reads a team channel, the person’s own conversation and nothing that is somebody else’s private place', async () => {
    const cites = [
      { kind: 'message', ref: devMsg },
      { kind: 'message', ref: leadsMsg },
      { kind: 'message', ref: dmOmarRafiMsg },
      { kind: 'message', ref: rafiChatMsg },
      { kind: 'message', ref: nadiaChatMsg },
      { kind: 'message', ref: dmNadiaOmarMsg },
    ];
    // everything the bot cites was reached by this run (the thread it answers in needs no line)
    const r = await inNadiaChat(cites.filter((c) => c.ref !== nadiaChatMsg).map((c): Line => ['message', c.ref, 'channel']));
    const v = await viewOf(botActor, r, cites);
    expect(v.citations.map((c) => c.found)).toEqual([true, false, false, false, true, true]);
    expect(v.citations.every((c) => c.reached === true)).toBe(true);
    expect(v.citations[0]).toMatchObject({ scope: 'team', audience: true, channelKind: 'channel', channelName: 'dev', channelId: dev, teamId: ENG, label: 'The deploy waits for the Monday window' });
    // her own conversation and a DM she is in reach no further than the people of that place
    expect(v.citations[4]).toMatchObject({ scope: 'channel', channelKind: 'bot_conversation', channelName: null });
    expect(v.citations[5]).toMatchObject({ scope: 'channel', channelKind: 'dm', channelName: null, teamId: null });
    // the reply is her own conversation: everybody who reads it is her, so the reply's readers may see all she may
    expect(v.run).toMatchObject({ hasAsker: true, askerName: 'Nadia', askerPersonId: nadia.personId, private: true, reach: 'asker', alias: 'smart', botSlug: 'brain' });
    expect(v.citations.filter((c) => c.found).every((c) => c.audience === true)).toBe(true);
    // a source that is hidden carries no label, no channel, nothing
    expect(v.citations[1]).toEqual({ found: false, reached: true });
    expect(JSON.stringify(v)).not.toContain('Layoffs');
  });

  it('is the same bot with a different asker and a different view: the lead’s run reads the lead’s private channel, the member’s does not', async () => {
    const lines: Line[] = [['message', leadsMsg, 'channel'], ['file', leadsFile, 'channel'], ['message', dmOmarRafiMsg, 'channel']];
    const cites = [{ kind: 'message', ref: leadsMsg }, { kind: 'file', ref: leadsFile }, { kind: 'message', ref: dmOmarRafiMsg }];
    const omarRun = await reachedRun({ trigger: 'conversation', asker: omar.actorId, channel: omarChat, root: omarConversationRoot }, lines);
    const forOmar = await viewOf(botActor, omarRun, cites);
    expect(forOmar.citations.map((c) => c.found)).toEqual([true, true, true]);
    expect(forOmar.run.askerName).toBe('Omar');
    const forNadia = await viewOf(botActor, await inNadiaChat(lines), cites);
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

  it('goes back to the bot after an error in the middle of the switched part, too (inside a savepoint, the way a caller would survive one)', async () => {
    const out = await asBot(botActor, nadiaConversation, async (tx) => {
      await tx.query('SAVEPOINT answer_probe');
      let failed = false;
      try {
        // an object is not a list of citations: `jsonb_array_elements` raises after the identity was switched to the asker
        await tx.query('SELECT app.answer_view($1::jsonb, $2::text[])', [JSON.stringify({ not: 'a list' }), []]);
      } catch {
        failed = true;
      }
      await tx.query('ROLLBACK TO SAVEPOINT answer_probe');
      const me = (await tx.query<{ actor: string; kind: string }>("SELECT app.actor()::text AS actor, current_setting('app.actor_kind') AS kind")).rows[0]!;
      return { failed, me };
    });
    expect(out.failed).toBe(true);
    expect(out.me).toEqual({ actor: botActor, kind: 'bot' });
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
    const asNadia = await as(nadia, async (tx) => (await tx.query<{ r: Resolved }>("SELECT app.answer_resolve($1, $2, NULL, $3::uuid, NULL, 'none') AS r", ['message', leadsMsg, ENG])).rows[0]!.r);
    expect(asNadia).toEqual({ found: false });
    const asOmar = await as(omar, async (tx) => (await tx.query<{ r: Resolved }>("SELECT app.answer_resolve($1, $2, NULL, $3::uuid, NULL, 'none') AS r", ['message', leadsMsg, ENG])).rows[0]!.r);
    expect(asOmar.found).toBe(true);
  });

  it('answer_reply_reach is for the live run’s own bot as well: nobody else learns who reads a channel from it', async () => {
    const ask = (actor: Actor) => withActor(actor, async (tx) => (await tx.query<{ v: string | null }>('SELECT app.answer_reply_reach() AS v')).rows[0]!.v, { pool: appPool });
    const r = await inDev(nadia.actorId, []);
    expect(await ask({ kind: 'bot', id: botActor, workspaceId: WS, runId: r } as unknown as Actor)).toBe('team');
    expect(await ask({ kind: 'bot', id: botActor, workspaceId: WS, runId: nadiaConversation } as unknown as Actor)).toBe('asker');
    expect(await ask({ kind: 'bot', id: otherBotActor, workspaceId: WS, runId: r } as unknown as Actor)).toBe('none');
    expect(await ask({ ...personaActor(nadia), runId: r } as Actor)).toBe('none');
    expect(await ask({ kind: 'bot', id: botActor, workspaceId: WS } as unknown as Actor)).toBe('none');
  });
});

describe('the people who will read the reply', () => {
  // a function: the ids exist only once the file's beforeAll has made them
  const sharedCites = (): Array<{ kind: string; ref: string; team?: string }> => [
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
  ];
  const sharedLines = (): Line[] => [
    ['message', devMsg, 'channel'],
    ['message', dmNadiaOmarMsg, 'channel'],
    ['message', teamPrivateMsg, 'channel'],
    ['message', nadiaChatMsg, 'channel'],
    ['file', devFile, 'channel'],
    ['file', dmFile, 'channel'],
    ['message', leadsMsg, 'channel'],
    ['page', 'pages/specs/schedule-migration.md', 'team'],
    ['page', `${MKT}:pages/launch/plan.md`, 'team'],
    ['run', nadiaConversation, 'team'],
    ['run', rafiConversation, 'team'],
    ['run', teamRun, 'team'],
  ];

  it('a reply in a team channel keeps what that channel may open and sets aside what only the asker can', async () => {
    const v = await viewOf(botActor, await inDev(nadia.actorId, sharedLines()), sharedCites());
    expect(v.run).toMatchObject({ private: false, reach: 'team', channelId: dev });
    const row = (i: number) => ({ found: v.citations[i]!.found, audience: v.citations[i]!.audience, scope: v.citations[i]!.scope });
    // readable by Nadia and by the channel
    expect(row(0)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(4)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(7)).toEqual({ found: true, audience: true, scope: 'team' });
    expect(row(11)).toEqual({ found: true, audience: true, scope: 'team' });
    // readable by Nadia, not by the channel: a DM, a private room, her own conversation, a file in a DM, her own conversation run
    for (const i of [1, 2, 3, 5, 9]) expect(row(i), `citation ${i}`).toMatchObject({ found: true, audience: false });
    // not readable by Nadia at all: the lead's channel, Marketing's page, Rafi's conversation run
    for (const i of [6, 8, 10]) expect(row(i), `citation ${i}`).toMatchObject({ found: false });
    expect(v.citations[7]).toMatchObject({ teamId: ENG });
    expect(v.citations[11]).toMatchObject({ botSlug: 'brain' });
  });

  it('a run nobody asked reads as its bot: the team’s public channels, not the lead’s, and its reply is the team’s to read', async () => {
    const lines: Line[] = [['message', devMsg, 'channel'], ['message', leadsMsg, 'channel'], ['message', nadiaChatMsg, 'channel'], ['page', 'pages/specs/schedule-migration.md', 'team']];
    const v = await viewOf(botActor, await inDev(null, lines, 'webhook'), [
      { kind: 'message', ref: devMsg },
      { kind: 'message', ref: leadsMsg },
      { kind: 'message', ref: nadiaChatMsg },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md' },
    ]);
    expect(v.run).toMatchObject({ hasAsker: false, askerName: null, askerPersonId: null, reach: 'team' });
    expect(v.citations.map((c) => c.found)).toEqual([true, false, false, true]);
    expect(v.citations[0]).toMatchObject({ audience: true, scope: 'team' });
    expect(v.citations[3]).toMatchObject({ audience: true, scope: 'team', teamId: ENG });
  });

  it('a channel a guest may also read shares nothing beyond itself: a team source is not shown there, what is in the channel is', async () => {
    const guestRun = await reachedRun({ trigger: 'mention', asker: nadia.actorId, channel: guestOpen, root: guestOpenMsg }, [
      ['message', devMsg, 'channel'],
      ['message', guestOpenMsg, 'channel'],
      ['page', 'pages/specs/schedule-migration.md', 'team'],
      ['memory', 'bank:team:engineering', 'team'],
    ]);
    const v = await viewOf(botActor, guestRun, [{ kind: 'message', ref: devMsg }, { kind: 'message', ref: guestOpenMsg }, { kind: 'page', ref: 'pages/specs/schedule-migration.md' }]);
    expect(v.run.reach).toBe('none');
    expect(v.citations[0]).toMatchObject({ found: true, scope: 'team', audience: false });
    expect(v.citations[1]).toMatchObject({ found: true, audience: true });
    expect(v.citations[2]).toMatchObject({ found: true, scope: 'team', audience: false });
    // and what the run read follows: the team's memory is not listed to a channel with a guest in it
    expect(v.sources.find((s) => s.kind === 'memory')).toMatchObject({ audience: false });
  });

  it('a channel a person of another team may also read is no more the team’s than a guest’s', async () => {
    const r = await reachedRun({ trigger: 'mention', asker: nadia.actorId, channel: otherTeamOpen, root: otherTeamOpenMsg }, [['message', devMsg, 'channel']]);
    const v = await viewOf(botActor, r, [{ kind: 'message', ref: devMsg }, { kind: 'message', ref: otherTeamOpenMsg }]);
    expect(v.run.reach).toBe('none');
    expect(v.citations[0]).toMatchObject({ found: true, audience: false });
  });

  it('a private channel of the team, which the bot cannot read, shares only itself', async () => {
    const r = await reachedRun({ trigger: 'mention', asker: nadia.actorId, channel: teamPrivate, root: teamPrivateMsg }, [['message', devMsg, 'channel'], ['message', teamPrivateMsg, 'channel']]);
    const v = await viewOf(botActor, r, [{ kind: 'message', ref: devMsg }, { kind: 'message', ref: teamPrivateMsg }]);
    expect(v.run).toMatchObject({ private: false, reach: 'none' });
    expect(v.citations[0]).toMatchObject({ found: true, audience: false });
    expect(v.citations[1]).toMatchObject({ found: true, audience: true });
  });

  it('a grant to the team itself, and a stale membership of somebody who is not on it, make nobody a reader who is not the team’s', async () => {
    for (const [name, channelId] of [['grant to the team', teamAclOpen], ['membership row of a non-member', staleMember]] as const) {
      const r = await reachedRun({ trigger: 'mention', asker: nadia.actorId, channel: channelId, root: mentionRoot }, [['message', devMsg, 'channel']]);
      const v = await viewOf(botActor, r, [{ kind: 'message', ref: devMsg }]);
      expect(v.run.reach, name).toBe('team');
      expect(v.citations[0], name).toMatchObject({ found: true, audience: true });
    }
  });

  it('a person demoted to guest who keeps a roster row and holds an ACL grant is not the team: the reply is no longer the team’s to read', async () => {
    const ch = await channel({ name: 'demoted-guest' });
    await acl(ch, 'person', rafi.personId);
    const asked = () => reachedRun({ trigger: 'mention', asker: nadia.actorId, channel: ch, root: mentionRoot }, [['message', devMsg, 'channel']]).then((r) => viewOf(botActor, r, [{ kind: 'message', ref: devMsg }]));
    // while Rafi is a member the grant adds nobody who is not the team
    const before = await asked();
    expect(before.run.reach).toBe('team');
    expect(before.citations[0]).toMatchObject({ found: true, audience: true });
    const original = await sys(async (tx) => (await tx.query<{ role: string }>('SELECT role FROM app.workspace_members WHERE person_id = $1', [rafi.personId])).rows[0]!.role);
    // Demoted to guest with the roster row left in place. `workspace_members_guard` refuses that through every normal path, so the owner lifts
    // it for this one statement: the reader test must not stand on a trigger (a roster row is not membership, `lookup_team_role` says so).
    await asOwner(
      `ALTER TABLE app.workspace_members DISABLE TRIGGER workspace_members_guard;
       UPDATE app.workspace_members SET role = 'guest' WHERE person_id = '${rafi.personId}';
       ALTER TABLE app.workspace_members ENABLE TRIGGER workspace_members_guard;`,
    );
    try {
      const rosterRows = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id WHERE a.ref_id = $1', [rafi.personId])).rows[0]!.n);
      expect(rosterRows).toBeGreaterThan(0);
      const after = await asked();
      expect(after.run.reach).toBe('none');
      expect(after.citations[0]).toMatchObject({ found: true, scope: 'team', audience: false });
    } finally {
      await asOwner(`UPDATE app.workspace_members SET role = '${original.replaceAll("'", "''")}' WHERE person_id = '${rafi.personId}'`);
    }
  });

  it('a conversation somebody else holds a grant on is no longer the asker’s alone', async () => {
    const chat = await as(priya, async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [botId])).rows[0]!.channel_id);
    const root = await message(chat, priya.actorId, 'Priya asks something private');
    const alone = await reachedRun({ trigger: 'conversation', asker: priya.actorId, channel: chat, root }, [['message', devMsg, 'channel']]);
    expect((await viewOf(botActor, alone, [{ kind: 'message', ref: devMsg }])).run).toMatchObject({ reach: 'asker', private: true });
    await acl(chat, 'person', lena.personId);
    const shared = await reachedRun({ trigger: 'conversation', asker: priya.actorId, channel: chat, root }, [['message', devMsg, 'channel']]);
    const v = await viewOf(botActor, shared, [{ kind: 'message', ref: devMsg }]);
    expect(v.run).toMatchObject({ reach: 'none', private: false });
    expect(v.citations[0]).toMatchObject({ found: true, audience: false });
  });
});

describe('a reply nobody can be shown to is for no one', () => {
  // `channel_audience` counts only active, non-guest members of the workspace: a conversation channel whose one member is no longer one has
  // no readers, and nothing is proven by an empty set (so the reach is `none`, never `asker`, and only what lives in the channel itself is shown)
  const reachOfConversation = async (chat: string, root: string, asker: Persona): Promise<View> => {
    const r = await reachedRun({ trigger: 'conversation', asker: asker.actorId, channel: chat, root }, [['message', devMsg, 'channel']]);
    return viewOf(botActor, r, [{ kind: 'message', ref: devMsg }]);
  };

  it('a suspended asker leaves the conversation with no readers: none, and a team source is not shown', async () => {
    const before = await reachOfConversation(rafiChat, rafiChatMsg, rafi);
    expect(before.run.reach).toBe('asker');
    expect(before.citations[0]).toMatchObject({ found: true, audience: true });
    // `people_guard` lets only a workspace admin change a status through the app; the owner lifts it for the one statement
    const setStatus = (status: string): Promise<void> =>
      asOwner(
        `ALTER TABLE app.people DISABLE TRIGGER people_guard;
         UPDATE app.people SET status = '${status}' WHERE id = '${rafi.personId}';
         ALTER TABLE app.people ENABLE TRIGGER people_guard;`,
      );
    await setStatus('suspended');
    try {
      const after = await reachOfConversation(rafiChat, rafiChatMsg, rafi);
      expect(after.run.reach).toBe('none');
      expect(after.run.private).toBe(false);
    } finally {
      await setStatus('active');
    }
    // and it is the asker's own again afterwards
    expect((await reachOfConversation(rafiChat, rafiChatMsg, rafi)).run.reach).toBe('asker');
  });

  it('a person demoted to guest, with the roster row and the channel membership left in place, is no reader of their own conversation', async () => {
    const original = await sys(async (tx) => (await tx.query<{ role: string }>('SELECT role FROM app.workspace_members WHERE person_id = $1', [nadia.personId])).rows[0]!.role);
    const before = await reachOfConversation(nadiaChat, nadiaRoot, nadia);
    expect(before.run.reach).toBe('asker');
    // `workspace_members_guard` refuses the demotion of a team member through every normal path: the owner lifts it for one statement
    await asOwner(
      `ALTER TABLE app.workspace_members DISABLE TRIGGER workspace_members_guard;
       UPDATE app.workspace_members SET role = 'guest' WHERE person_id = '${nadia.personId}';
       ALTER TABLE app.workspace_members ENABLE TRIGGER workspace_members_guard;`,
    );
    try {
      const after = await reachOfConversation(nadiaChat, nadiaRoot, nadia);
      expect(after.run.reach).toBe('none');
      expect(after.run.private).toBe(false);
    } finally {
      await asOwner(`UPDATE app.workspace_members SET role = '${original.replaceAll("'", "''")}' WHERE person_id = '${nadia.personId}'`);
    }
    expect((await reachOfConversation(nadiaChat, nadiaRoot, nadia)).run.reach).toBe('asker');
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
    // a source of no resolvable kind is judged by the line's own scope: in the asker's own conversation they are the only reader
    expect(v.sources.find((s) => s.kind === 'drive')).toMatchObject({ audience: true });
  });

  it('shows a team channel only the lines whose scope is the team’s: a person’s connection, a private scope and an unknown one are not', async () => {
    const r = await inDev(nadia.actorId, [['memory', 'bank:team:engineering', 'team'], ['drive', 'doc-1', 'person'], ['wiki', 'page-9', 'channel']]);
    const v = await viewOf(botActor, r, []);
    expect(v.sources.map((s) => [s.kind, s.audience])).toEqual([['memory', true], ['drive', false], ['wiki', false]]);
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

describe('a long log', () => {
  const filler = (runId: string, from: number, to: number): Promise<void> =>
    sys(async (tx) => {
      await tx.query(
        `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
         SELECT $1::uuid, g, 'memory', 'bank:filler-' || g, 'team' FROM generate_series($2::int, $3::int) AS g`,
        [runId, from, to],
      );
    });

  it('is read to its first 20,000 lines: a run that logged more is marked, and what it read after them is not reached', async () => {
    const r = await inNadiaChat([['message', devMsg, 'channel']]); // seq 0
    await filler(r, 1, 20_000); // 20,001 lines in all: the function sees them all, and keeps the first 20,000
    await sys(async (tx) => {
      await tx.query("INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 20001, 'message', $2, 'channel')", [r, devMsg2]);
    });
    const v = await viewOf(botActor, r, [{ kind: 'message', ref: devMsg }, { kind: 'message', ref: devMsg2 }]);
    expect(v.run.logTruncated).toBe(true);
    // the early line is read; the late one (the 20,002nd) is not in what the function reads, so a genuinely read source is reported as not reached
    expect(v.citations[0]).toMatchObject({ found: true, reached: true });
    expect(v.citations[1]).toEqual({ found: false, reached: false });
  }, 120_000);

  it('at exactly 20,000 lines nothing is cut and nothing is marked', async () => {
    const r = await inNadiaChat([['message', devMsg, 'channel']]); // seq 0
    await filler(r, 1, 19_999);
    const v = await viewOf(botActor, r, [{ kind: 'message', ref: devMsg }]);
    expect(v.run.logTruncated).toBe(false);
    expect(v.citations[0]).toMatchObject({ found: true, reached: true });
  }, 120_000);

  it('finds a thread by a reply in a log of 20,000 lines without comparing every reply with every line', async () => {
    const r = await inNadiaChat([['message', devReply, 'channel']]); // a reply of the thread `devMsg`
    await filler(r, 1, 19_990);
    const started = Date.now();
    const v = await viewOf(botActor, r, Array.from({ length: 40 }, () => ({ kind: 'thread', ref: devMsg })));
    expect(v.citations).toHaveLength(40);
    expect(v.citations.every((c) => c.reached === true)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);

  it('cuts every reference to what a citation can be inside the function: nothing longer is ever held', async () => {
    const r = await inNadiaChat([['page', 'p'.repeat(100_000), 'team'], ['message', devMsg, 'channel']]);
    const longest = await asBot(botActor, r, async (tx) => (await tx.query<{ n: number }>('SELECT coalesce(max(length(source_ref)), 0)::int AS n FROM app.answer_run_sources()')).rows[0]!.n);
    expect(longest).toBe(1100);
  });
});

describe('what the bot may cite: only what its run reached', () => {
  it('looks nothing up for an id the run did not reach, and answers the same for a readable one, a hidden one and one that does not exist', async () => {
    const r = await inNadiaChat([['message', devMsg, 'channel']]);
    const v = await viewOf(botActor, r, [
      { kind: 'message', ref: devMsg }, // reached
      { kind: 'message', ref: devMsg2 }, // readable by the asker, never reached
      { kind: 'message', ref: leadsMsg }, // hidden from the asker, never reached
      { kind: 'message', ref: randomUUID() }, // nothing
      { kind: 'file', ref: devFile },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md' },
      { kind: 'run', ref: teamRun },
      { kind: 'thread', ref: devMsg2 },
    ]);
    expect(v.citations[0]).toMatchObject({ found: true, reached: true });
    for (const i of [1, 2, 3, 4, 5, 6, 7]) expect(v.citations[i], `citation ${i}`).toEqual({ found: false, reached: false });
  });

  it('counts as reached: what the source log names, the thread the run answers in, a thread a hit was a reply of, the run itself, a page by path or by team and path', async () => {
    const r = await inNadiaChat([
      ['message', devReply, 'channel'],
      ['file', devFile, 'channel'],
      ['run', teamRun, 'team'],
      ['page', 'pages/specs/schedule-migration.md', 'team'],
      ['page', `${MKT}:pages/launch/plan.md`, 'team'],
    ]);
    const v = await viewOf(botActor, r, [
      { kind: 'message', ref: devReply },
      { kind: 'thread', ref: devMsg }, // a reply of this thread was a hit
      { kind: 'message', ref: nadiaRoot }, // the thread the run answers in
      { kind: 'thread', ref: nadiaRoot },
      { kind: 'message', ref: nadiaChatMsg },
      { kind: 'file', ref: devFile },
      { kind: 'run', ref: teamRun },
      { kind: 'run', ref: r }, // its own
      { kind: 'page', ref: 'pages/specs/schedule-migration.md' },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md', team: ENG },
      { kind: 'page', ref: 'pages/launch/plan.md', team: MKT },
      { kind: 'page', ref: 'pages/launch/plan.md' }, // the same path, but of the run's own team: not what was read
    ]);
    expect(v.citations.map((c) => c.reached)).toEqual([true, true, true, true, true, true, true, true, true, true, true, false]);
  });

  it('is not fooled by the case or the spelling of an id, or by a path that only looks like a logged one', async () => {
    const r = await inNadiaChat([['message', devMsg, 'channel'], ['page', 'pages/specs/schedule-migration.md', 'team']]);
    const v = await viewOf(botActor, r, [
      { kind: 'message', ref: devMsg.toUpperCase() },
      { kind: 'message', ref: `${devMsg} ` },
      { kind: 'page', ref: 'pages/specs/../specs/schedule-migration.md' },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md/' },
      { kind: 'file', ref: devMsg },
    ]);
    // an upper-case spelling is the same id; the others are not what was read
    expect(v.citations.map((c) => c.reached)).toEqual([true, false, false, false, false]);
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

  it('does not count an answer that was deleted: the run may answer again, and then it is answered once more', async () => {
    const r = await inNadiaChat([]);
    const first = await message(nadiaChat, botActor, 'The first answer', nadiaRoot, { answer: { version: 1 }, runId: r });
    expect(await viewAs(botActor, r, [])).toEqual({ already: first });
    await sys(async (tx) => {
      await tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [first]);
    });
    expect(await viewAs(botActor, r, [])).toMatchObject({ run: { runId: r } });
    const second = await message(nadiaChat, botActor, 'The second answer', nadiaRoot, { answer: { version: 1 }, runId: r });
    expect(await viewAs(botActor, r, [])).toEqual({ already: second });
  });

  it('is a hard guarantee of the table as well: a second live answer of one run is refused, whoever writes it', async () => {
    const r = await inNadiaChat([]);
    await message(nadiaChat, botActor, 'One', nadiaRoot, { answer: { version: 1 }, runId: r });
    await expect(message(nadiaChat, botActor, 'Two', nadiaRoot, { answer: { version: 1 }, runId: r })).rejects.toMatchObject({ code: '23505' });
    // a message that carries only a run id (a plain reply of the run) is not an answer
    await expect(message(nadiaChat, botActor, 'Plain', nadiaRoot, { runId: r })).resolves.toBeTruthy();
  });

  it('serialises two calls of one run: the second waits on the run’s lock until the first has posted, and then finds its message', async () => {
    const r = await inDev(nadia.actorId, []);
    // no sleeps: the first call holds the run's lock and waits for a latch, the second is started only after the first has looked, the test
    // sees the second is queued on an advisory lock (pg_locks, this database) and only then lets the first post and commit
    let latch!: () => void;
    const gate = new Promise<void>((resolve) => (latch = resolve));
    let looked!: () => void;
    const lookedAt = new Promise<void>((resolve) => (looked = resolve));
    let posted = '';
    const first = asBot(botActor, r, async (tx) => {
      const seen = await tx.query<{ v: Record<string, unknown> | null }>('SELECT app.answer_view($1::jsonb, $2::text[]) AS v', [JSON.stringify([]), []]);
      expect(seen.rows[0]!.v).toMatchObject({ run: { runId: r } });
      looked();
      await gate;
      // the answer is posted in the same transaction, as `answer.post` does
      posted = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta)
           VALUES (app.workspace_id(), $1, app.actor(), 'The answer', 'The answer', $2, $3::jsonb) RETURNING id`,
          [dev, mentionRoot, JSON.stringify({ answer: { version: 1 }, runId: r })],
        )
      ).rows[0]!.id;
    });
    // a failure of the first before it looked rejects here instead of hanging the test
    await Promise.race([lookedAt, first]);
    const second = asBot(botActor, r, async (tx) => (await tx.query<{ v: unknown }>('SELECT app.answer_view($1::jsonb, $2::text[]) AS v', [JSON.stringify([]), []])).rows[0]!.v);
    try {
      // an advisory lock of this database that somebody is waiting for: the second call, queued behind the first's lock on this run
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = await sys(
          async (tx) =>
            (
              await tx.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
              )
            ).rows[0]!.n,
        );
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error('the second call never queued on the run’s lock: the calls are not serialised');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      latch();
    }
    const [, seenBySecond] = await Promise.all([first, second]);
    expect(posted).not.toBe('');
    expect(seenBySecond).toEqual({ already: posted });
  });

  it('finds the bots of the run’s team by slug, never the answering bot itself, and none of another team', async () => {
    const v = await viewOf(botActor, omarConversation, [], ['coder', 'brain', 'ghost']);
    expect(v.bots).toEqual([{ id: otherBotId, slug: 'coder', name: 'Coder' }]);
  });
});

describe('sharing an answer of one’s own conversation (P5-17)', () => {
  interface ShareView {
    answer: { messageId: string; channelId: string; threadRootId: string | null; teamId: string; botId: string; personId: string; payload: Record<string, unknown> };
    target: { kind: string; channelId: string | null; name: string | null; teamId: string | null; private: boolean; archived: boolean; canPost: boolean } | null;
    reach: 'asker' | 'team' | 'none';
    citations: Array<{ n: number; kept: boolean; label: string | null; at: string | null }>;
    sources: Array<{ kept: boolean }>;
  }
  const viewAsPerson = (p: Persona, message: string, channelId: string | null, page = false): Promise<ShareView | null> =>
    as(p, async (tx) => (await tx.query<{ v: ShareView | null }>('SELECT app.answer_share_view($1::uuid, $2::uuid, $3::boolean) AS v', [message, channelId, page])).rows[0]!.v);
  const keptNumbers = (v: ShareView | null): number[] => (v?.citations ?? []).filter((c) => c.kept).map((c) => c.n);

  const msgCite = (n: number, id: string, channelId: string, over: Record<string, unknown> = {}) => ({
    kind: 'message', n, label: `stored label ${String(n)}`, scope: 'team', messageId: id, channelId, teamId: ENG, channelKind: 'channel', channelName: 'x', threadRootId: null, ...over,
  });
  const payloadOf = (person: Persona, citations: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    body: citations.map((c) => `Claim [${String(c['n'])}].`).join(' '),
    citations,
    lineage: citations.map((c) => ({ n: c['n'], kind: c['kind'], label: c['label'], at: null, snippet: 'a quote' })),
    sourcesReached: [],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: person.personId, name: person.name, scope: 'scoped', alias: 'smart', botId, runId: randomUUID() },
    chips: [],
    ...extra,
  });
  const answerMessage = (chat: string, root: string, person: Persona, citations: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Promise<string> =>
    message(chat, botActor, 'An answer', root, { answer: payloadOf(person, citations, extra), runId: randomUUID() });

  let omarAnswer = '';
  let marketingPage = '';

  beforeAll(async () => {
    marketingPage = 'pages/launch/plan.md';
    const sources = [
      { kind: 'message', ref: devMsg, label: 'stored', marker: 'full' },
      { kind: 'message', ref: leadsMsg, label: 'stored', marker: 'full' },
      { kind: 'drive', ref: 'doc-1', label: null, marker: 'scoped' },
      { kind: 'page', ref: 'pages/specs/schedule-migration.md', label: 'stored', marker: 'full' },
      { kind: 'memory', ref: 'bank:team:engineering', label: 'Team memory', marker: 'full' },
    ];
    omarAnswer = await answerMessage(
      omarChat,
      omarConversationRoot,
      omar,
      [
        msgCite(1, devMsg, dev),
        msgCite(2, leadsMsg, leads, { scope: 'channel', channelName: 'leads' }),
        msgCite(3, dmOmarRafiMsg, dmOmarRafi, { scope: 'channel', channelKind: 'dm', channelName: null, teamId: null }),
        { kind: 'page', n: 4, label: 'pages/specs/schedule-migration.md', scope: 'team', teamId: ENG, path: 'pages/specs/schedule-migration.md' },
        { kind: 'run', n: 5, label: 'Brain · conversation', scope: 'person', runId: omarConversation, botId, botSlug: 'brain' },
        { kind: 'file', n: 6, label: 'runbook.pdf', scope: 'team', fileId: devFile },
        msgCite(7, teamPrivateMsg, teamPrivate, { scope: 'channel', channelName: 'release-room' }),
        { kind: 'page', n: 8, label: 'pages/launch/plan.md', scope: 'channel', teamId: MKT, path: marketingPage },
        msgCite(9, guestOpenMsg, guestOpen, { channelName: 'guest-open' }),
      ],
      { sourcesReached: sources },
    );
  });

  it('is the asker’s own answer or nothing: not a teammate, not an admin, not a deleted one, not a plain message, not a copy in a channel', async () => {
    expect(await viewAsPerson(omar, omarAnswer, dev)).not.toBeNull();
    // somebody else's answer is nothing at all to the owner and admin of the workspace, and to a teammate
    const nadiaAnswer = await answerMessage(nadiaChat, nadiaRoot, nadia, [msgCite(1, devMsg, dev)]);
    expect(await viewAsPerson(omar, nadiaAnswer, dev)).toBeNull();
    expect(await viewAsPerson(rafi, nadiaAnswer, dev)).toBeNull();
    expect(await viewAsPerson(nadia, omarAnswer, dev)).toBeNull();
    expect(await viewAsPerson(nadia, nadiaAnswer, dev)).not.toBeNull();
    // an answer that was for another person, even sitting in this one's conversation
    const forSomeoneElse = await answerMessage(omarChat, omarConversationRoot, nadia, [msgCite(1, devMsg, dev)]);
    expect(await viewAsPerson(omar, forSomeoneElse, dev)).toBeNull();
    // an answer by another bot than the conversation's
    const otherBot = await message(omarChat, otherBotActor, 'Not this conversation’s bot', omarConversationRoot, {
      answer: { ...payloadOf(omar, [msgCite(1, devMsg, dev)]), answeredFor: { personId: omar.personId, name: 'Omar', scope: 'scoped', alias: null, botId: otherBotId, runId: randomUUID() } },
      runId: randomUUID(),
    });
    expect(await viewAsPerson(omar, otherBot, dev)).toBeNull();
    // a plain message, a message that has an answer but sits in a channel (a shared copy is not shared again from there), and a deleted answer
    expect(await viewAsPerson(omar, omarConversationRoot, dev)).toBeNull();
    const copy = await message(dev, omar.actorId, 'A shared copy', null, { answer: payloadOf(omar, [msgCite(1, devMsg, dev)]) });
    expect(await viewAsPerson(omar, copy, dev)).toBeNull();
    const gone = await answerMessage(omarChat, omarConversationRoot, omar, [msgCite(1, devMsg, dev)]);
    await sys(async (tx) => {
      await tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [gone]);
    });
    expect(await viewAsPerson(omar, gone, dev)).toBeNull();
    // a bot and a guest share nothing; a call that names both a channel and a page is not a call
    expect(await asBot(botActor, undefined, async (tx) => (await tx.query('SELECT app.answer_share_view($1::uuid, NULL, false) AS v', [omarAnswer])).rows[0]!['v'])).toBeNull();
    expect(await viewAsPerson(omar, omarAnswer, dev, true)).toBeNull();
  });

  it('a team channel keeps what the team may open and what lives in it, and masks every other source', async () => {
    const v = await viewAsPerson(omar, omarAnswer, dev);
    expect(v).toMatchObject({ reach: 'team', target: { kind: 'channel', channelId: dev, name: 'dev', canPost: true, private: false } });
    // team message, team page, team file, a public channel's message: kept. A private channel, a DM, the asker's own run, a private room, another team's page: masked
    expect(keptNumbers(v)).toEqual([1, 4, 6, 9]);
    expect(v!.citations.find((c) => c.n === 1)).toMatchObject({ label: 'The deploy waits for the Monday window' });
    // a masked one carries no label and no date
    expect(v!.citations.find((c) => c.n === 2)).toEqual({ n: 2, kept: false, label: null, at: null });
    // what the run read follows the same readers, and a kept entry is read again (its stored label was 'stored')
    expect(v!.sources.map((s) => s.kept)).toEqual([true, false, false, true, false]);
    expect((v as unknown as { sources: Array<{ label?: string | null }> }).sources.map((s) => s.label ?? null)).toEqual([
      'The deploy waits for the Monday window',
      null,
      null,
      'pages/specs/schedule-migration.md',
      null,
    ]);
  });

  it('a private room of the team is the team’s too, and what lives in it is kept besides', async () => {
    const v = await viewAsPerson(omar, omarAnswer, teamPrivate);
    expect(v).toMatchObject({ reach: 'team', target: { private: true } });
    expect(keptNumbers(v)).toEqual([1, 4, 6, 7, 9]);
  });

  it('a channel a guest may also read keeps only what lives in it; so does one a person of another team may read', async () => {
    const guest = await viewAsPerson(omar, omarAnswer, guestOpen);
    expect(guest).toMatchObject({ reach: 'none' });
    expect(keptNumbers(guest)).toEqual([9]);
    expect(guest!.sources.every((s) => !s.kept)).toBe(true);
    const other = await viewAsPerson(omar, omarAnswer, otherTeamOpen);
    expect(other).toMatchObject({ reach: 'none' });
    expect(keptNumbers(other)).toEqual([]);
  });

  it('a person demoted to guest who keeps a roster row and an ACL grant is not the team: the channel is `none` again', async () => {
    const ch = await channel({ name: 'share-demoted' });
    await acl(ch, 'person', priya.personId);
    expect(await viewAsPerson(omar, omarAnswer, ch)).toMatchObject({ reach: 'team' });
    const original = await sys(async (tx) => (await tx.query<{ role: string }>('SELECT role FROM app.workspace_members WHERE person_id = $1', [priya.personId])).rows[0]!.role);
    await asOwner(
      `ALTER TABLE app.workspace_members DISABLE TRIGGER workspace_members_guard;
       UPDATE app.workspace_members SET role = 'guest' WHERE person_id = '${priya.personId}';
       ALTER TABLE app.workspace_members ENABLE TRIGGER workspace_members_guard;`,
    );
    try {
      const after = await viewAsPerson(omar, omarAnswer, ch);
      expect(after).toMatchObject({ reach: 'none' });
      expect(keptNumbers(after)).toEqual([]);
    } finally {
      await asOwner(`UPDATE app.workspace_members SET role = '${original.replaceAll("'", "''")}' WHERE person_id = '${priya.personId}'`);
    }
  });

  it('a direct message keeps only what lives in it; the asker’s own conversation with another bot keeps what the asker may open (a hand-off)', async () => {
    const dm = await viewAsPerson(omar, omarAnswer, dmOmarRafi);
    expect(dm).toMatchObject({ reach: 'none', target: { kind: 'dm', name: null } });
    expect(keptNumbers(dm)).toEqual([3]);
    const own = await viewAsPerson(omar, omarAnswer, omarChat);
    expect(own).toMatchObject({ reach: 'asker', target: { kind: 'bot_conversation' } });
    expect(keptNumbers(own)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // but give somebody a grant on that conversation and it is no longer the asker's alone
    const openFor = (p: Persona, bot: string): Promise<string> =>
      as(p, async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [bot])).rows[0]!.channel_id);
    const brainChat = await openFor(priya, botId);
    const coderChat = await openFor(priya, otherBotId);
    const answer = await answerMessage(brainChat, await message(brainChat, priya.actorId, 'A question'), priya, [msgCite(1, devMsg, dev)]);
    expect(await viewAsPerson(priya, answer, coderChat)).toMatchObject({ reach: 'asker' });
    await acl(coderChat, 'person', lena.personId);
    expect(await viewAsPerson(priya, answer, coderChat)).toMatchObject({ reach: 'none' });
  });

  it('the team’s pages are read by the team: a team source is kept, a source only the asker may open is masked', async () => {
    const v = await viewAsPerson(omar, omarAnswer, null, true);
    expect(v).toMatchObject({ reach: 'team', target: { kind: 'page', teamId: ENG, canPost: true } });
    expect(keptNumbers(v)).toEqual([1, 4, 6, 9]);
  });

  it('reads the source again as the sharer: an edited message has its new words, a deleted one is not kept, and one the sharer lost is not kept', async () => {
    const fresh = await message(dev, omar.actorId, 'First words of the note');
    const doomed = await message(dev, omar.actorId, 'A note that will be deleted');
    const answer = await answerMessage(omarChat, omarConversationRoot, omar, [msgCite(1, fresh, dev), msgCite(2, doomed, dev)]);
    expect((await viewAsPerson(omar, answer, dev))!.citations).toMatchObject([{ n: 1, kept: true, label: 'First words of the note' }, { n: 2, kept: true }]);
    await sys(async (tx) => {
      await tx.query("UPDATE app.messages SET body = 'Other words now', body_plain = 'Other words now' WHERE id = $1", [fresh]);
      await tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [doomed]);
    });
    const after = await viewAsPerson(omar, answer, dev);
    expect(after!.citations[0]).toMatchObject({ n: 1, kept: true, label: 'Other words now' });
    expect(after!.citations[1]).toEqual({ n: 2, kept: false, label: null, at: null });
    // a channel the sharer cannot read at all is no target (and every citation is left unjudged)
    const unreadable = await viewAsPerson(omar, answer, nadiaChat);
    expect(unreadable).toMatchObject({ target: null, reach: 'none', citations: [], sources: [] });
  });

  it('survives hostile payloads: a citation of an unknown kind, a path of a hundred thousand characters, numbers that are not numbers', async () => {
    const answer = await answerMessage(omarChat, omarConversationRoot, omar, [
      { kind: 'memory', n: 1, label: 'x', scope: 'team' },
      { kind: 'page', n: 2, label: 'x', scope: 'team', teamId: 'not-a-uuid', path: 'p'.repeat(100_000) },
      { kind: 'message', n: 'seven', label: 'x', scope: 'team', messageId: devMsg, channelId: dev },
      { kind: 'message', n: 4, label: 'x', scope: 'team', messageId: "'; DROP TABLE app.messages; --", channelId: dev },
    ]);
    const v = await viewAsPerson(omar, answer, dev);
    expect(v!.citations.map((c) => [c.n, c.kept])).toEqual([[1, false], [2, false], [4, false]]);
  });

  describe('app.answer_channel_reach', () => {
    const reach = (p: Persona, channelId: string, team: string | null, asker: string | null): Promise<string> =>
      as(p, async (tx) => (await tx.query<{ r: string }>('SELECT app.answer_channel_reach($1::uuid, $2::uuid, $3::uuid) AS r', [channelId, team, asker])).rows[0]!.r);

    it('is the rule of a reply: a team channel, a grant to the team, a guest’s grant, a private room, a DM, and a channel the caller cannot read', async () => {
      expect(await reach(omar, dev, ENG, omar.personId)).toBe('team');
      expect(await reach(omar, teamAclOpen, ENG, omar.personId)).toBe('team');
      expect(await reach(omar, guestOpen, ENG, omar.personId)).toBe('none');
      expect(await reach(omar, otherTeamOpen, ENG, omar.personId)).toBe('none');
      expect(await reach(omar, dmOmarRafi, ENG, omar.personId)).toBe('none');
      // another team's channel is not the answer's team's
      expect(await reach(omar, dev, MKT, omar.personId)).toBe('none');
      // a channel the caller cannot read has no readers they may learn
      expect(await reach(nadia, leads, ENG, nadia.personId)).toBe('none');
    });

    it('`asker` only for a bot conversation whose one reader is the asker', async () => {
      expect(await reach(omar, omarChat, ENG, omar.personId)).toBe('asker');
      expect(await reach(omar, omarChat, ENG, nadia.personId)).toBe('none');
      expect(await reach(omar, omarChat, ENG, null)).toBe('none');
    });
  });

  describe('the access log', () => {
    const record = (p: Persona, message: string, kind: string, channelId: string | null, path: string | null, digest: string, copy: string | null) =>
      as(p, async (tx) =>
        (
          await tx.query<{ id: string }>('SELECT app.answer_share_record($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, 2, ARRAY[3,5], ARRAY[7]) AS id', [message, kind, channelId, path, digest, copy])
        ).rows[0]!.id,
      );
    const find = (p: Persona, message: string, kind: string, channelId: string | null, digest: string) =>
      as(p, async (tx) => (await tx.query<{ id: string | null }>('SELECT app.answer_share_find($1::uuid, $2, $3::uuid, $4) AS id', [message, kind, channelId, digest])).rows[0]!.id);
    const digestA = 'a'.repeat(64);
    const digestB = 'b'.repeat(64);

    it('records the asker’s share, finds it again, and a second record of the same key replaces the pointer', async () => {
      const copy = await message(dev, omar.actorId, 'A copy');
      const id = await record(omar, omarAnswer, 'channel', dev, null, digestA, copy);
      expect(id).toBeTruthy();
      expect(await find(omar, omarAnswer, 'channel', dev, digestA)).toBe(copy);
      // another cut is another share; another channel too; another person never finds it
      expect(await find(omar, omarAnswer, 'channel', dev, digestB)).toBeNull();
      expect(await find(omar, omarAnswer, 'channel', guestOpen, digestA)).toBeNull();
      expect(await find(nadia, omarAnswer, 'channel', dev, digestA)).toBeNull();
      // the copy is deleted and shared again: the same key, a new message
      await sys(async (tx) => {
        await tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [copy]);
      });
      expect(await find(omar, omarAnswer, 'channel', dev, digestA)).toBeNull();
      const again = await message(dev, omar.actorId, 'A copy again');
      expect(await record(omar, omarAnswer, 'channel', dev, null, digestA, again)).toBe(id);
      expect(await find(omar, omarAnswer, 'channel', dev, digestA)).toBe(again);
      const row = await sys(async (tx) => (await tx.query('SELECT kind, kept_count, masked_count, removed_count, masked_numbers, removed_numbers FROM app.answer_shares WHERE id = $1', [id])).rows[0]);
      expect(row).toEqual({ kind: 'channel', kept_count: 2, masked_count: 2, removed_count: 1, masked_numbers: [3, 5], removed_numbers: [7] });
    });

    it('refuses anybody but the asker, a copy that is not the caller’s own, and a shape that is not a share', async () => {
      const copy = await message(dev, omar.actorId, 'Omar’s copy');
      await expect(record(nadia, omarAnswer, 'channel', dev, null, digestB, copy)).rejects.toMatchObject({ code: '42501' });
      const nadiasCopy = await message(dev, nadia.actorId, 'Nadia’s message');
      await expect(record(omar, omarAnswer, 'channel', dev, null, digestB, nadiasCopy)).rejects.toMatchObject({ code: '42501' });
      await expect(record(omar, omarAnswer, 'page', dev, null, digestB, null)).rejects.toMatchObject({ code: '23514' });
      await expect(record(omar, omarAnswer, 'channel', dev, null, 'not-a-digest', copy)).rejects.toMatchObject({ code: '23514' });
      // a bot cannot write a share at all
      await expect(asBot(botActor, nadiaConversation, async (tx) => tx.query('SELECT app.answer_share_record($1::uuid, $2, $3::uuid, NULL, $4, NULL, 0, NULL, NULL)', [omarAnswer, 'channel', dev, digestB]))).rejects.toMatchObject({ code: '42501' });
    });

    it('is readable by the sharer alone: not a teammate, not an admin who is not the sharer', async () => {
      const mine = async (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.answer_shares')).rows[0]!.n);
      expect(await mine(omar)).toBeGreaterThan(0);
      expect(await mine(nadia)).toBe(0);
      expect(await mine(rafi)).toBe(0);
      // and nobody can write it: the request role has no privilege on the table beyond SELECT
      await expect(as(omar, async (tx) => tx.query('DELETE FROM app.answer_shares'))).rejects.toMatchObject({ code: '42501' });
      await expect(as(omar, async (tx) => tx.query('UPDATE app.answer_shares SET kept_count = 0'))).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('hostile input', () => {
  it('reads a reference that is not an id, a path that is a hundred thousand characters and a kind it does not know as "not found", and never raises', async () => {
    // all of them are in the run's log, so the lookup itself is what is exercised (not only the "never reached" door in front of it)
    const refs: Array<[string, string, string | undefined]> = [
      ['message', "'; DROP TABLE app.messages; --", undefined],
      ['message', 'x'.repeat(100_000), undefined],
      ['page', 'p'.repeat(100_000), undefined],
      ['page', '../../etc/passwd', 'not-a-uuid'],
      ['memory', 'concept', undefined],
      ['thread', randomUUID(), undefined],
      ['run', randomUUID(), undefined],
      ['file', randomUUID(), undefined],
    ];
    const r = await inNadiaChat(refs.map(([kind, ref]): Line => [kind, ref, 'team']));
    const v = await viewOf(botActor, r, refs.map(([kind, ref, team]) => ({ kind, ref, ...(team ? { team } : {}) })));
    expect(v.citations).toHaveLength(8);
    // a malformed id is not an id (and not reached); the well-formed ones were reached and are not there
    for (const [i, c] of v.citations.entries()) expect(c.found, `citation ${i}`).toBe(false);
  });

  it('looks at no more than forty citations, however many are sent', async () => {
    const cites = Array.from({ length: 5_000 }, () => ({ kind: 'message', ref: devMsg }));
    const started = Date.now();
    const v = await viewOf(botActor, await inNadiaChat([['message', devMsg, 'channel']]), cites);
    expect(v.citations).toHaveLength(40);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('is not a way into another workspace or another team’s page: a team the asker is not on has no page for them', async () => {
    const asNadia = await inDev(nadia.actorId, [['page', `${MKT}:pages/launch/plan.md`, 'team']]);
    const v = await viewOf(botActor, asNadia, [{ kind: 'page', ref: 'pages/launch/plan.md', team: MKT }]);
    expect(v.citations[0]).toMatchObject({ found: false, reached: true });
    // Priya is on both teams: asked by her, the same page is found, and it is not the run's team's, so it does not reach a team channel
    const priyaRun = await inDev(priya.actorId, [['page', `${MKT}:pages/launch/plan.md`, 'team']]);
    const forPriya = await viewOf(botActor, priyaRun, [{ kind: 'page', ref: 'pages/launch/plan.md', team: MKT }]);
    expect(forPriya.citations[0]).toMatchObject({ found: true, scope: 'channel', audience: false, teamId: MKT });
  });
});
