import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnswerPayload,
  AnswerSharePreview,
  AnswerShareTargetsResponse,
  GetRepoBlobResponse,
  HandoffAnswerResponse,
  ListConversationsResponse,
  ListMessagesResponse,
  SaveAnswerPageResponse,
  ShareAnswerResponse,
  eventRegistry,
  isSubsequence,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// Sharing an answer of one's own conversation, through the real server (PLAN P5-17, SPEC §6.3 and §6.4): the preview, the share to a channel
// with masking, replays, Save as page and Hand to a bot. The answer is a message the bot's identity wrote with `meta.answer`, as `answer.post`
// does; what these tests pin is what a person can then do with it and what a reader of the result can and cannot learn from it.

const { omar, nadia, rafi, lena, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ prompt }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'text', text: 'Answering: ' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: 'Answering the hand-over.', tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

const botMd = (name: string, triggers: string[]): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    'role: Shares answers in the share test',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...triggers.map((t) => `  - ${t}`),
    'capabilities:',
    '  native: [messages.post]',
    '---',
    '',
    `# ${name}`,
    '',
    'Soul text of the share test.',
    '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
const savedEnv: Record<string, string | undefined> = {
  MANYTHREADS_HERMES_BIN: process.env['MANYTHREADS_HERMES_BIN'],
  MANYTHREADS_HERMES_PREFIX: process.env['MANYTHREADS_HERMES_PREFIX'],
  MANYTHREADS_RUNTIME_DIR: process.env['MANYTHREADS_RUNTIME_DIR'],
  MANYTHREADS_LITELLM_URL: process.env['MANYTHREADS_LITELLM_URL'],
  HERMES_FAKE_SPOOL: process.env['HERMES_FAKE_SPOOL'],
};

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const spoolPrompts = (): string[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { prompt: string }).prompt)
    : [];

async function loadBot(slug: string, md: string): Promise<{ botId: string; actorId: string }> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`,
          [slug],
        );
        return r.rows[0]?.id ?? null;
      }),
    20_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null),
    5_000,
    `the actor of ${slug}`,
  );
  return { botId, actorId };
}

const send = async (who: typeof nadia, channelId: string, body: string): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};
const channelOf = async (who: typeof nadia, name: string, priv: boolean): Promise<string> => {
  const res = await w.call<{ channel: { id: string } }>(who, 'POST', '/api/teams/engineering/channels', { name, private: priv });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.channel.id;
};
const grant = (channelId: string, personId: string): Promise<void> =>
  w.system(async (tx) => {
    await tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')`,
      [omar.workspaceId, channelId, personId],
    );
  });

let brain: { botId: string; actorId: string };
let coder: { botId: string; actorId: string };
let devChannel = '';
let devMessage = '';
let leadsChannel = '';
let leadsMessage = '';
let guestOpen = '';
let widened = '';
let omarChat = '';
let omarRoot = '';
let omarRun = '';
let answerId = '';
let nadiaChat = '';
let nadiaRoot = '';
let nadiaAnswer = '';

const BODY = 'The deploy waits for the Monday window [1]. Leadership also has plans [2] that I cannot repeat. A run is behind this [3].';

/** The stored payload of an Answer for `personId`, as `answer.post` would have written it (citations by kind; the SQL reads only these fields). */
const payloadFor = (person: typeof omar, citations: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  body: BODY,
  citations,
  lineage: (citations as Array<{ n: number; kind: string; label: string }>).map((c) => ({ n: c.n, kind: c.kind, label: c.label, at: '2026-10-01T12:00:00.000Z', snippet: `quote ${String(c.n)}` })),
  sourcesReached: [
    { kind: 'message', ref: devMessage, label: 'The deploy waits for the Monday change window', marker: 'full' },
    { kind: 'message', ref: leadsMessage, label: 'Layoffs are planned for March, zebra', marker: 'full' },
    { kind: 'drive', ref: 'doc-1', label: null, marker: 'scoped' },
  ],
  outsideScope: { count: 0, items: [] },
  answeredFor: { personId: person.personId, name: person.name, scope: 'scoped', alias: 'smart', botId: brain.botId, runId: randomUUID() },
  chips: [
    { kind: 'followup', label: 'Why?', prompt: 'Why is it waiting?' },
    { kind: 'handoff', botId: coder.botId, botSlug: 'coder', botName: 'Coder' },
  ],
  ...extra,
});

const postAnswer = (chat: string, root: string, payload: Record<string, unknown>): Promise<string> =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta)
           VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb) RETURNING id`,
          [omar.workspaceId, chat, brain.actorId, payload['body'], root, JSON.stringify({ answer: payload, runId: (payload['answeredFor'] as { runId: string }).runId })],
        )
      ).rows[0]!.id,
  );

const url = (chat: string, id: string, op: string): string => `/api/channels/${chat}/messages/${id}/answer/${op}`;

const preview = async (who: typeof omar, target: unknown, remove: number[] = [], id = answerId, chat = omarChat) => {
  const res = await w.call(who, 'POST', url(chat, id, 'preview'), { target, remove });
  return { status: res.status, body: res.body, parsed: res.status === 200 ? AnswerSharePreview.parse(res.body) : null };
};
const channelTarget = (channelId: string) => ({ kind: 'channel', channelId });

const copiesIn = (channelId: string, authorActor: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string; body: string; meta: Record<string, unknown> }>(
          "SELECT id, body, meta FROM app.messages WHERE channel_id = $1 AND author_id = $2 AND meta ? 'answer' AND deleted_at IS NULL ORDER BY id",
          [channelId, authorActor],
        )
      ).rows,
  );

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'share-'));
  spool = join(scratch, 'spool.jsonl');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;

  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  devChannel = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT c.id FROM app.channels c WHERE c.team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND c.name = 'dev'")).rows[0]!.id);
  devMessage = await send(omar, devChannel, 'The deploy waits for the Monday change window');
  leadsChannel = await channelOf(omar, 'leads', true);
  leadsMessage = await send(omar, leadsChannel, 'Layoffs are planned for March, zebra');
  // a public channel a guest may also read, and a private one a person of another team may
  guestOpen = await channelOf(omar, 'guest-open', false);
  await grant(guestOpen, lena.personId);
  widened = await channelOf(omar, 'liaison', true);
  await grant(widened, sameera.personId);

  brain = await loadBot('brain', botMd('Brain', ['{ type: conversation }', '{ type: mention }']));
  coder = await loadBot('coder', botMd('Coder', ['{ type: conversation }']));

  // Omar's conversation with Brain, and the run that answers it (its id is a source of his that only he may open)
  const opened = await w.call<{ channelId: string }>(omar, 'POST', '/api/teams/engineering/bots/brain/conversation');
  expect(opened.status).toBeLessThan(300);
  omarChat = opened.body.channelId;
  omarRoot = await send(omar, omarChat, 'What is blocking the release?');
  omarRun = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.bot_runs WHERE bot_id = $1 AND asker_id = $2 ORDER BY started_at LIMIT 1', [brain.botId, omar.actorId])).rows[0]?.id ?? null),
    30_000,
    'the run of Omar’s conversation',
  );
  await until(
    () => w.system(async (tx) => (await tx.query('SELECT 1 FROM app.conversations WHERE thread_root_id = $1', [omarRoot])).rows[0] ?? null),
    30_000,
    'the conversation to be indexed',
  );
  answerId = await postAnswer(omarChat, omarRoot, payloadFor(omar, [
    { kind: 'message', n: 1, label: 'The deploy waits for the Monday change window', scope: 'team', messageId: devMessage, channelId: devChannel, teamId: null, channelKind: 'channel', channelName: 'dev', threadRootId: null },
    { kind: 'message', n: 2, label: 'Layoffs are planned for March, zebra', scope: 'channel', messageId: leadsMessage, channelId: leadsChannel, teamId: null, channelKind: 'channel', channelName: 'leads', threadRootId: null },
    { kind: 'run', n: 3, label: 'Brain · conversation', scope: 'person', runId: omarRun, botId: brain.botId, botSlug: 'brain' },
  ]));

  // Nadia's own conversation and answer: the owner and admin of the workspace must be able to do nothing with it
  const nadiaOpen = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/brain/conversation');
  nadiaChat = nadiaOpen.body.channelId;
  nadiaRoot = await send(nadia, nadiaChat, 'What does Nadia ask?');
  nadiaAnswer = await postAnswer(nadiaChat, nadiaRoot, payloadFor(nadia, [
    { kind: 'message', n: 1, label: 'The deploy waits for the Monday change window', scope: 'team', messageId: devMessage, channelId: devChannel, teamId: null, channelKind: 'channel', channelName: 'dev', threadRootId: null },
  ], { body: 'A short answer [1].' }));
}, 300_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('who may touch an answer', () => {
  it('is the asker alone: not the owner and admin of the workspace, not a teammate, not somebody who is signed out', async () => {
    expect((await preview(omar, channelTarget(devChannel))).status).toBe(200);
    // Omar owns and administers the workspace; Nadia's answer is nothing to him, nor to Rafi
    for (const who of [omar, rafi]) {
      const res = await w.call(who, 'POST', url(nadiaChat, nadiaAnswer, 'preview'), { target: channelTarget(devChannel), remove: [] });
      expect(res.status, `${who.key} previews Nadia's answer`).toBe(404);
    }
    expect((await w.call(nadia, 'POST', url(omarChat, answerId, 'preview'), { target: channelTarget(devChannel), remove: [] })).status).toBe(404);
    expect((await w.call(null, 'POST', url(omarChat, answerId, 'preview'), { target: channelTarget(devChannel), remove: [] })).status).toBe(401);
    // the same answer addressed through another channel is no answer there
    expect((await w.call(omar, 'POST', url(devChannel, answerId, 'preview'), { target: channelTarget(devChannel), remove: [] })).status).toBe(404);
    // a message that is not an answer
    expect((await w.call(omar, 'POST', url(omarChat, omarRoot, 'preview'), { target: channelTarget(devChannel), remove: [] })).status).toBe(404);
    // none of them can share, save or hand over either
    const digest = 'a'.repeat(64);
    expect((await w.call(omar, 'POST', url(nadiaChat, nadiaAnswer, 'share'), { targetChannelId: devChannel, remove: [], digest })).status).toBe(404);
    expect((await w.call(omar, 'POST', url(nadiaChat, nadiaAnswer, 'page'), { remove: [], digest })).status).toBe(404);
    expect((await w.call(omar, 'POST', url(nadiaChat, nadiaAnswer, 'handoff'), { botId: coder.botId })).status).toBe(404);
    expect((await w.call(omar, 'GET', url(nadiaChat, nadiaAnswer, 'targets'))).status).toBe(404);
    // and nothing was posted anywhere
    expect(await copiesIn(devChannel, omar.actorId)).toEqual([]);
  });

  it('lists the channels the asker may post in, and not a conversation or a direct message', async () => {
    const res = await w.call(omar, 'GET', url(omarChat, answerId, 'targets'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = AnswerShareTargetsResponse.parse(res.body).channels.map((c) => c.name);
    expect(names).toContain('dev');
    expect(names).toContain('leads');
    expect(names).not.toContain('');
  });
});

describe('the preview', () => {
  it('says per citation what the readers of the channel would see, and carries the copy exactly as it would be posted', async () => {
    const p = (await preview(omar, channelTarget(devChannel))).parsed!;
    expect(p.audience).toBe('team');
    expect(p.target).toMatchObject({ kind: 'channel', channelId: devChannel, name: 'dev', private: false, path: null });
    expect(p.items.map((i) => [i.n, i.kind, i.status])).toEqual([[1, 'message', 'kept'], [2, 'message', 'masked'], [3, 'run', 'masked']]);
    expect(p.counts).toMatchObject({ kept: 1, masked: 2, removed: 0, sentences: 0 });
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    // the copy: the text is the answer's own, the masked citations are a number and a kind
    expect(p.payload.body).toBe(BODY);
    expect(p.payload.citations.map((c) => c.kind)).toEqual(['message', 'masked', 'masked']);
    expect(p.payload.chips).toEqual([]);
    const wire = JSON.stringify(p.payload);
    for (const secret of ['Layoffs', leadsChannel, leadsMessage, omarRun, 'Brain · conversation', 'quote 2', 'quote 3', 'doc-1']) {
      expect(wire, `the copy must not carry ${secret}`).not.toContain(secret);
    }
    // "Sources reached": the team's message stays, the private ones are counted, not named
    expect(p.payload.sourcesReached.map((s) => s.kind)).toEqual(['message']);
    expect(p.payload.outsideScope.items).toContainEqual({ kind: 'message', reason: 'not_shared', count: 1 });
    expect(p.payload.outsideScope.items).toContainEqual({ kind: 'drive', reason: 'not_shared', count: 1 });
  });

  it('a channel a guest may read masks what is only the team’s; one a person of another team may read does too', async () => {
    const guest = (await preview(omar, channelTarget(guestOpen))).parsed!;
    expect(guest.audience).toBe('wider');
    expect(guest.items.map((i) => i.status)).toEqual(['masked', 'masked', 'masked']);
    const other = (await preview(omar, channelTarget(widened))).parsed!;
    expect(other.audience).toBe('wider');
    expect(other.items.every((i) => i.status === 'masked')).toBe(true);
  });

  it('a private channel is judged by who reads it: Omar’s own #leads keeps the private message that lives in it', async () => {
    const p = (await preview(omar, channelTarget(leadsChannel))).parsed!;
    expect(p.items.map((i) => [i.n, i.status])).toEqual([[1, 'kept'], [2, 'kept'], [3, 'masked']]);
    expect(p.target.private).toBe(true);
  });

  it('removing a claim takes its sentence out and nothing else, and moves the digest', async () => {
    const whole = (await preview(omar, channelTarget(devChannel))).parsed!;
    const cut = (await preview(omar, channelTarget(devChannel), [2])).parsed!;
    expect(cut.payload.body).toBe('The deploy waits for the Monday window [1]. A run is behind this [3].');
    expect(isSubsequence(cut.payload.body, BODY)).toBe(true);
    expect(cut.items.find((i) => i.n === 2)).toMatchObject({ status: 'removed' });
    expect(cut.counts).toMatchObject({ removed: 1, sentences: 1 });
    expect(cut.payload.citations.map((c) => c.n)).toEqual([1, 3]);
    expect(cut.digest).not.toBe(whole.digest);
    expect(JSON.stringify(cut.payload)).not.toContain('Layoffs');
  });

  it('refuses what is not a share: a number the answer has no citation for, text of one’s own, a DM or a conversation as the target, and everything cut away', async () => {
    expect((await preview(omar, channelTarget(devChannel), [9])).status).toBe(400);
    const extra = await w.call(omar, 'POST', url(omarChat, answerId, 'preview'), { target: channelTarget(devChannel), remove: [], body: 'Omar adds a sentence' });
    expect(extra.status).toBe(400);
    const dm = await w.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect((await preview(omar, channelTarget(dm.body.dm.channel.id))).status).toBe(400);
    expect((await preview(omar, channelTarget(omarChat))).status).toBe(400);
    expect((await preview(omar, channelTarget(randomUUID()))).status).toBe(403);
    // a channel the person cannot read at all is the same 403 as one that does not exist
    expect((await preview(nadia, channelTarget(leadsChannel), [], nadiaAnswer, nadiaChat)).status).toBe(403);
    // every claim of a short answer removed: nothing is left to say
    expect((await preview(nadia, channelTarget(devChannel), [1], nadiaAnswer, nadiaChat)).status).toBe(422);
  });
});

describe('sharing to a channel', () => {
  let copyId = '';

  it('posts the masked copy as the sharer, once: a replay answers with the same message and posts nothing', async () => {
    const p = (await preview(omar, channelTarget(devChannel), [])).parsed!;
    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: devChannel, remove: [], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const shared = ShareAnswerResponse.parse(res.body);
    copyId = shared.messageId;
    expect(shared).toMatchObject({ channelId: devChannel, replayed: false, counts: { kept: 1, masked: 2, removed: 0 } });

    const copies = await copiesIn(devChannel, omar.actorId);
    expect(copies.map((c) => c.id)).toEqual([copyId]);
    const stored = AnswerPayload.parse(copies[0]!.meta['answer']);
    expect(stored.body).toBe(BODY);
    expect(copies[0]!.body).toBe(BODY);
    expect(stored.citations.map((c) => c.kind)).toEqual(['message', 'masked', 'masked']);
    expect(stored.share).toEqual({ masked: 2, removed: 0 });
    // nothing of the private sources is in the row a reader of the channel reads
    for (const secret of ['Layoffs', leadsChannel, leadsMessage, omarRun, 'doc-1']) expect(JSON.stringify(copies[0]!.meta)).not.toContain(secret);

    const again = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: devChannel, remove: [], digest: p.digest });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(ShareAnswerResponse.parse(again.body)).toMatchObject({ messageId: copyId, replayed: true });
    expect((await copiesIn(devChannel, omar.actorId)).map((c) => c.id)).toEqual([copyId]);
  });

  it('a teammate reads the copy in the channel with its masked citations, and the conversation itself stays private', async () => {
    const res = await w.call(nadia, 'GET', `/api/channels/${devChannel}/messages?limit=50`);
    expect(res.status).toBe(200);
    const copy = ListMessagesResponse.parse(res.body).items.find((m) => m.id === copyId);
    expect(copy?.meta.answer?.citations.map((c) => c.kind)).toEqual(['message', 'masked', 'masked']);
    for (const who of [nadia, rafi]) {
      expect((await w.call(who, 'GET', `/api/channels/${omarChat}/messages?limit=50`)).status, `${who.key} reads Omar's conversation`).toBeGreaterThanOrEqual(400);
    }
    // the conversation is listed under Shared for the team, through the copy
    const list = await w.call(nadia, 'GET', '/api/teams/engineering/bots/brain/conversations?scope=shared');
    expect(list.status).toBe(200);
    const row = ListConversationsResponse.parse(list.body).items.find((i) => i.sharedTo?.channelId === devChannel);
    expect(row).toMatchObject({ visibility: 'shared', mine: false, threadRootId: copyId });
  });

  it('an answer cannot be edited, by the person who shared it or anybody: the text must stay the payload’s', async () => {
    const edit = await w.call(omar, 'PATCH', `/api/channels/${devChannel}/messages/${copyId}`, { body: 'An invented claim [1].' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(409);
    const body = await w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE id = $1', [copyId])).rows[0]!.body);
    expect(body).toBe(BODY);
  });

  it('is judged again when it is posted: a digest of another copy is a 409 and posts nothing', async () => {
    const before = (await copiesIn(guestOpen, omar.actorId)).length;
    const stale = (await preview(omar, channelTarget(devChannel))).parsed!.digest;
    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: guestOpen, remove: [], digest: stale });
    expect(res.status).toBe(409);
    expect((await copiesIn(guestOpen, omar.actorId)).length).toBe(before);
    // and with the right digest the guest-readable channel gets a copy with every source masked
    const p = (await preview(omar, channelTarget(guestOpen))).parsed!;
    const ok = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: guestOpen, remove: [], digest: p.digest });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const copy = (await copiesIn(guestOpen, omar.actorId))[0]!;
    expect(AnswerPayload.parse(copy.meta['answer']).citations.map((c) => c.kind)).toEqual(['masked', 'masked', 'masked']);
    // the guest reads it; nothing in it tells them where anything lives
    const asGuest = await w.call(lena, 'GET', `/api/channels/${guestOpen}/messages?limit=50`);
    expect(asGuest.status).toBe(200);
    expect(JSON.stringify(asGuest.body)).not.toContain(devChannel);
  });

  it('a different cut is a different share, reached only through its own preview: a copy with a claim removed is a second message', async () => {
    const p = (await preview(omar, channelTarget(devChannel), [2])).parsed!;
    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: devChannel, remove: [2], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(ShareAnswerResponse.parse(res.body).messageId).not.toBe(copyId);
    const copies = await copiesIn(devChannel, omar.actorId);
    expect(copies).toHaveLength(2);
    const cut = AnswerPayload.parse(copies[1]!.meta['answer']);
    expect(cut.body).toBe('The deploy waits for the Monday window [1]. A run is behind this [3].');
    expect(cut.share).toEqual({ masked: 1, removed: 1 });
    // an unknown claim is refused with the digest of the real thing: a request cannot name what is not there
    const bad = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: devChannel, remove: [8], digest: p.digest });
    expect(bad.status).toBe(400);
  });

  it('writes the access event with ids and counts only, and no team', async () => {
    const rows = await w.system(
      async (tx) =>
        (await tx.query<{ team_id: string | null; payload: Record<string, unknown> }>("SELECT team_id, payload FROM app.events WHERE type = 'answer.answer.shared' AND payload ->> 'kind' = 'channel' ORDER BY id")).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.team_id === null)).toBe(true);
    const first = rows.find((r) => r.payload['channelId'] === devChannel && (r.payload['removedCount'] as number) === 0)!;
    expect(first.payload).toMatchObject({
      kind: 'channel',
      personId: omar.personId,
      messageId: answerId,
      keptCount: 1,
      maskedCount: 2,
      removedCount: 0,
      maskedNumbers: [2, 3],
      removedNumbers: [],
    });
    const wire = JSON.stringify(rows);
    for (const secret of ['Layoffs', leadsMessage, leadsChannel, omarRun, 'doc-1', BODY]) expect(wire).not.toContain(secret);
    expect(Object.keys(eventRegistry['answer.answer.shared'])).toEqual(['1']);
    // the access log of the sharer holds the same lines, and nobody else's
    const lines = await w.system(async (tx) => (await tx.query('SELECT kind, kept_count, masked_count FROM app.answer_shares WHERE message_id = $1 ORDER BY created_at', [answerId])).rows);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a share the person may not make: a channel they cannot post in, and one of nobody’s', async () => {
    const forbidden = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: randomUUID(), remove: [], digest: 'c'.repeat(64) });
    expect(forbidden.status).toBe(403);
    const shapeless = await w.call(omar, 'POST', url(omarChat, answerId, 'share'), { targetChannelId: devChannel, remove: [], digest: 'short' });
    expect(shapeless.status).toBe(400);
  });
});

describe('what a share does to the conversation, and what a copy can wake', () => {
  const stateOf = (root: string) =>
    w.system(async (tx) => (await tx.query<{ visibility: string; shared_to: string | null }>('SELECT visibility, shared_to FROM app.conversations WHERE thread_root_id = $1', [root])).rows[0]!);

  it('a share into a private room posts the copy and leaves the conversation private: nobody else is shown a row they cannot open', async () => {
    await until(() => w.system(async (tx) => (await tx.query('SELECT 1 FROM app.conversations WHERE thread_root_id = $1', [nadiaRoot])).rows[0] ?? null), 30_000, 'Nadia’s conversation to be indexed');
    // a private room of the team that Nadia is in (Omar made it and added her)
    const room = await channelOf(omar, 'nadia-room', true);
    const added = await w.call(omar, 'POST', `/api/channels/${room}/members`, { personId: nadia.personId });
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
    const p = (await preview(nadia, channelTarget(room), [], nadiaAnswer, nadiaChat)).parsed!;
    const res = await w.call(nadia, 'POST', url(nadiaChat, nadiaAnswer, 'share'), { targetChannelId: room, remove: [], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await copiesIn(room, nadia.actorId)).length).toBe(1);
    expect(await stateOf(nadiaRoot)).toEqual({ visibility: 'private', shared_to: null });
    expect((await w.call(rafi, 'GET', '/api/teams/engineering/bots/brain/conversations?scope=shared')).status).toBe(200);
  });

  it('a share into a channel of the whole team marks it, and deleting the copy takes the mark away', async () => {
    const p = (await preview(nadia, channelTarget(devChannel), [], nadiaAnswer, nadiaChat)).parsed!;
    const res = await w.call(nadia, 'POST', url(nadiaChat, nadiaAnswer, 'share'), { targetChannelId: devChannel, remove: [], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copy = ShareAnswerResponse.parse(res.body).messageId;
    expect(await stateOf(nadiaRoot)).toEqual({ visibility: 'shared', shared_to: devChannel });
    const del = await w.call(nadia, 'DELETE', `/api/channels/${devChannel}/messages/${copy}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await stateOf(nadiaRoot)).toEqual({ visibility: 'private', shared_to: null });
    const list = await w.call(rafi, 'GET', '/api/teams/engineering/bots/brain/conversations?scope=shared');
    expect(ListConversationsResponse.parse(list.body).items.some((i) => i.personId === nadia.personId)).toBe(false);
  });

  it('a copy is nobody’s request: an @mention a source planted in the answer fires no bot, where the same words typed would', async () => {
    const planted = await postAnswer(
      omarChat,
      omarRoot,
      payloadFor(
        omar,
        [{ kind: 'message', n: 1, label: 'The deploy waits for the Monday change window', scope: 'team', messageId: devMessage, channelId: devChannel, teamId: null, channelKind: 'channel', channelName: 'dev', threadRootId: null }],
        { body: 'Please ask @brain to run the cleanup now [1].' },
      ),
    );
    const p = (await preview(omar, channelTarget(devChannel), [], planted)).parsed!;
    const res = await w.call(omar, 'POST', url(omarChat, planted, 'share'), { targetChannelId: devChannel, remove: [], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copy = ShareAnswerResponse.parse(res.body).messageId;
    // the control: the same words typed by the person do wake Brain (it has a mention trigger)
    const typed = await send(omar, devChannel, 'Please ask @brain to run the cleanup now');
    const jobsFor = (message: string) =>
      w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key = $1", [`runtime-hermes:${brain.botId}:${message}`])).rows[0]!.n);
    await until(async () => ((await jobsFor(typed)) === 1 ? true : null), 30_000, 'the typed mention to fire a run');
    // not "it came first": wait for the copy's own event to have been delivered to every subscriber (the router among them), then look
    const delivered = (message: string) =>
      w.system(async (tx) => {
        const rows = (
          await tx.query<{ done: boolean }>(
            `SELECT (o.done_at IS NOT NULL) AS done FROM app.outbox o JOIN app.events e ON e.id = o.event_id
              WHERE e.type = 'channel.message.posted' AND e.payload ->> 'messageId' = $1`,
            [message],
          )
        ).rows;
        return rows.length > 0 && rows.every((r) => r.done);
      });
    await until(async () => ((await delivered(copy)) ? true : null), 30_000, 'the copy’s event to be delivered');
    expect(await jobsFor(copy)).toBe(0);
  });
});

describe('save as page', () => {
  it('writes the masked copy under pages/answers, readable by the team, once', async () => {
    const p = (await preview(omar, { kind: 'page' })).parsed!;
    expect(p.target).toMatchObject({ kind: 'page', channelId: null });
    // no day in the name: the same answer is the same file on any day
    expect(p.target.path).toMatch(/^pages\/answers\/the-deploy-waits-for-the-monday-window-[0-9a-f]{8}\.md$/);
    expect(p.audience).toBe('team');
    expect(p.items.map((i) => i.status)).toEqual(['kept', 'masked', 'masked']);

    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'page'), { remove: [], digest: p.digest });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const saved = SaveAnswerPageResponse.parse(res.body);
    expect(saved).toMatchObject({ path: p.target.path, created: true });

    // Nadia reads the page; it is the copy, so a source only Omar may open is "not shared" and its words are not there
    const blob = await w.call(nadia, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(saved.path)}`);
    expect(blob.status, JSON.stringify(blob.body)).toBe(200);
    const text = GetRepoBlobResponse.parse(blob.body).content;
    expect(text).toContain('The deploy waits for the Monday window [1].');
    expect(text).toContain("2. from Omar's message · not shared");
    expect(text).toContain("3. from Omar's run · not shared");
    for (const secret of ['Layoffs', 'zebra', leadsMessage, omarRun, 'Brain · conversation']) expect(text).not.toContain(secret);

    // saving the same answer again finds the page and overwrites nothing
    const again = await w.call(omar, 'POST', url(omarChat, answerId, 'page'), { remove: [], digest: p.digest });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(SaveAnswerPageResponse.parse(again.body)).toMatchObject({ path: saved.path, created: false });

    // the page's own event and the access event
    const events = await w.system(async (tx) => (await tx.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM app.events WHERE type IN ('pages.page.written', 'answer.answer.shared') AND payload ->> 'kind' = 'page' OR (type = 'pages.page.written' AND payload ->> 'path' = $1) ORDER BY id", [saved.path])).rows);
    expect(events.some((e) => e.type === 'pages.page.written')).toBe(true);
    const access = events.find((e) => e.type === 'answer.answer.shared');
    expect(access?.payload).toMatchObject({ kind: 'page', channelId: null, copyMessageId: null, maskedCount: 2 });
  });

  it('is judged as the team’s page: a digest of another copy is a 409, and a removed claim is not on the page', async () => {
    const wrong = await w.call(omar, 'POST', url(omarChat, answerId, 'page'), { remove: [], digest: 'd'.repeat(64) });
    expect(wrong.status).toBe(409);
    const p = (await preview(omar, { kind: 'page' }, [3])).parsed!;
    // the same answer, another cut: its page name is the same file, which is not overwritten
    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'page'), { remove: [3], digest: p.digest });
    expect(res.status).toBe(200);
    // the counts are those of the page that is there (the first cut), not of the cut this request would have written
    expect(SaveAnswerPageResponse.parse(res.body)).toMatchObject({ created: false, counts: { kept: 1, masked: 2, removed: 0 } });
  });
});

describe('hand to a bot', () => {
  it('starts a thread in the asker’s own conversation with the other bot, whose run is given the answer; once', async () => {
    const res = await w.call(omar, 'POST', url(omarChat, answerId, 'handoff'), { botId: coder.botId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const handed = HandoffAnswerResponse.parse(res.body);
    expect(handed).toMatchObject({ botSlug: 'coder', botName: 'Coder', replayed: false });

    // the message is Omar's own, in his own conversation channel with Coder (private to him), and says where it came from
    const row = await w.system(async (tx) => (await tx.query<{ author_id: string; body: string; channel_id: string; kind: string; bot_id: string }>(
      'SELECT m.author_id, m.body, m.channel_id, c.kind, c.bot_id FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1', [handed.threadRootId])).rows[0]!);
    expect(row).toMatchObject({ author_id: omar.actorId, kind: 'bot_conversation', bot_id: coder.botId, channel_id: handed.channelId });
    expect(row.body).toContain('Handed over from Brain.');
    expect(row.body).toContain('What is blocking the release?');
    expect(row.body).toContain(BODY);
    // the destination is Omar's own conversation, whose only reader is Omar (reach `asker`): what he may open stays, labels included
    expect(row.body).toContain('[2] Layoffs are planned for March, zebra (message)');

    // Coder's run was started for it, with Omar as the asker
    await until(async () => spoolPrompts().find((p) => p.includes('Handed over from Brain.')) ?? null, 60_000, 'Coder to be handed the answer');

    const again = await w.call(omar, 'POST', url(omarChat, answerId, 'handoff'), { botId: coder.botId });
    expect(again.status).toBe(200);
    expect(HandoffAnswerResponse.parse(again.body)).toMatchObject({ threadRootId: handed.threadRootId, replayed: true });
  });

  it('is only what the answer offered: another bot, the answering bot itself and an unknown bot are refused', async () => {
    expect((await w.call(omar, 'POST', url(omarChat, answerId, 'handoff'), { botId: brain.botId })).status).toBe(400);
    expect((await w.call(omar, 'POST', url(omarChat, answerId, 'handoff'), { botId: randomUUID() })).status).toBe(400);
  });
});
