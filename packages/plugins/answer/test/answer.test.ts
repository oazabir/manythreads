import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnswerPayload, ListMessagesResponse, eventRegistry, type Message } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// `answer.post` end to end (PLAN P5-18): a person asks a bot, the router opens a run for them, the stand-in Hermes calls the tool over the run's
// real MCP endpoint, and what lands in the thread is the bot's message with the Answer on `meta.answer`. The stand-in is the one of
// conversation.test.ts plus a script: it performs the calls a test wrote to its scenario file, in order, and then prints a reply of its own —
// which the runtime must NOT post again once the run has answered.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FAKE_HERMES = [
  "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "const config = readFileSync(home + '/config.yaml', 'utf8');",
  "const url = JSON.parse(/^\\s+url: (.*)$/m.exec(config)[1]);",
  "const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);",
  "const target = (process.env.HERMES_FAKE_ORIGIN ?? '') + new URL(url).pathname;",
  "const scenarioPath = process.env.HERMES_FAKE_SCENARIO ?? '';",
  "const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { steps: [] };",
  'const call = async (step, id) => {',
  "  const body = step.method === 'tools/list' ? { jsonrpc: '2.0', id, method: 'tools/list' } : { jsonrpc: '2.0', id, method: 'tools/call', params: { name: step.name, arguments: step.arguments ?? {} } };",
  "  const res = await fetch(target, { method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });",
  '  return { status: res.status, body: await res.text() };',
  '};',
  '// `parallel`: every step at once (two calls of one run racing), else one after the other in the order written',
  'let results = [];',
  'if (scenario.parallel) results = await Promise.all(scenario.steps.map((step, i) => call(step, i + 1)));',
  'else for (const [i, step] of scenario.steps.entries()) results.push(await call(step, i + 1));',
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ prompt, results }) + '\\n');",
  "const reply = scenario.text ?? ('Answering: ' + prompt.replace(/\\s+/g, ' '));",
  "process.stdout.write(JSON.stringify({ type: 'text', text: 'Answering: ' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

const botMd = (name: string, native: string[], triggers = ['{ type: conversation }', '{ type: mention }']): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    'role: Answers with citations in the answer test',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...triggers.map((t) => `  - ${t}`),
    'capabilities:',
    `  native: [${native.join(', ')}]`,
    '---',
    '',
    `# ${name}`,
    '',
    'Soul text of the answer test.',
    '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let scenarioFile = '';
let devChannel = '';
let devMessage = '';
let leadsMessage = '';
let dmChannel = '';
let dmMessage = '';
let roomMessage = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MANYTHREADS_HERMES_BIN', 'MANYTHREADS_HERMES_PREFIX', 'MANYTHREADS_RUNTIME_DIR', 'MANYTHREADS_LITELLM_URL', 'HERMES_FAKE_SPOOL', 'HERMES_FAKE_SCENARIO', 'HERMES_FAKE_ORIGIN'];

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

interface Spooled {
  prompt: string;
  results: Array<{ status: number; body: string }>;
}
const spooled = (): Spooled[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Spooled)
    : [];

/** What a tool answered, as the model read it: the text block of an MCP result, parsed. */
const toolAnswer = (result: { status: number; body: string }): Record<string, unknown> => {
  const rpc = JSON.parse(result.body) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  return JSON.parse(rpc.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
};

interface LoadedBot {
  botId: string;
  actorId: string;
}
async function loadBot(slug: string, md: string): Promise<LoadedBot> {
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

const scenario = (steps: Array<{ method?: 'tools/list'; name?: string; arguments?: Record<string, unknown> }>, text?: string, parallel = false): void =>
  writeFileSync(scenarioFile, JSON.stringify({ steps, ...(text !== undefined ? { text } : {}), ...(parallel ? { parallel: true } : {}) }), 'utf8');

const send = async (who: typeof nadia, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};
const thread = async (who: typeof nadia, channelId: string, rootId: string): Promise<Message[]> => {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
};
const conversationOf = async (who: typeof nadia, slug: string): Promise<string> => {
  const res = await w.call<{ channelId: string }>(who, 'POST', `/api/teams/engineering/bots/${slug}/conversation`);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.channelId;
};
const runFor = (rootId: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string; status: string; trigger_type: string }>(
          'SELECT id, status, trigger_type FROM app.bot_runs WHERE reply_root_id = $1 ORDER BY started_at DESC LIMIT 1',
          [rootId],
        )
      ).rows[0],
  );
const finishedRun = (rootId: string) =>
  until(async () => {
    const run = await runFor(rootId);
    return run && run.status !== 'running' ? run : null;
  }, 90_000, 'the run to finish');

let brain: LoadedBot;
let coder: LoadedBot;
let mute: LoadedBot;
let leadsChannel = '';

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'answer-'));
  spool = join(scratch, 'spool.jsonl');
  scenarioFile = join(scratch, 'scenario.json');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;
  process.env['HERMES_FAKE_SCENARIO'] = scenarioFile;

  w = await createRepoWorld();
  process.env['HERMES_FAKE_ORIGIN'] = w.server.url;
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  devChannel = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT c.id FROM app.channels c WHERE c.team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND c.name = 'dev'")).rows[0]!.id);
  devMessage = await send(omar, devChannel, 'The deploy waits for the Monday change window');
  const leads = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads', private: true });
  expect(leads.status, JSON.stringify(leads.body)).toBe(201);
  leadsChannel = leads.body.channel.id;
  leadsMessage = await send(omar, leadsChannel, 'Layoffs are planned for March, zebra');
  // a direct message between Nadia and Omar: Nadia can read it, a team channel's readers cannot
  const dm = await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [omar.personId] });
  expect(dm.status, JSON.stringify(dm.body)).toBeLessThan(300);
  dmChannel = dm.body.dm.channel.id;
  dmMessage = await send(nadia, dmChannel, 'A word about the zebra rollout, just between us');
  // a private channel of the team that Nadia sits in: a search of the team reaches it, a team channel's readers cannot read it
  const room = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'release-room', private: true });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const added = await w.call(omar, 'POST', `/api/channels/${room.body.channel.id}/members`, { personId: nadia.personId });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  roomMessage = await send(omar, room.body.channel.id, 'Release room: the zebra rollout needs the Monday window');

  brain = await loadBot('brain', botMd('Brain', ['messages.search', 'messages.post', 'answer.post']));
  coder = await loadBot('coder', botMd('Coder', ['messages.post'], ['{ type: mention }']));
  mute = await loadBot('mute', botMd('Mute', ['messages.post']));
}, 300_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('a conversation answered with an Answer', () => {
  let chat = '';
  let root = '';
  let answer: Message;
  let payload: AnswerPayload;

  beforeAll(async () => {
    chat = await conversationOf(nadia, 'brain');
    scenario(
      [
        // the bot reads before it cites: a citation of something the run did not reach is not discussed at all
        { name: 'messages.search', arguments: { query: 'Monday change window' } },
        {
          name: 'answer.post',
          arguments: {
            body: 'The deploy waits for the Monday window [1]. Leadership also has plans [2] that I cannot repeat. Your own question is [3].',
            citations: [
              { kind: 'message', messageId: devMessage, snippet: '  The deploy waits for the Monday change window ' },
              { kind: 'message', messageId: leadsMessage, snippet: 'Layoffs are planned for March' },
            ],
            outsideScope: [{ kind: 'drive', count: 1 }],
            chips: [
              { kind: 'followup', prompt: 'When does the window open?', label: 'When does it open?' },
              { kind: 'handoff', botSlug: 'coder' },
              { kind: 'handoff', botSlug: 'ghost' },
            ],
          },
        },
      ],
      'This is the model’s own closing text, which must not become a second reply',
    );
    root = await send(nadia, chat, 'What is blocking the schedule migration?');
    const run = await finishedRun(root);
    expect(run).toMatchObject({ status: 'done', trigger_type: 'conversation' });
    const replies = (await thread(nadia, chat, root)).filter((m) => m.authorId === brain.actorId);
    // one reply: the Answer. The model's printed text after the tool call is not posted again.
    expect(replies).toHaveLength(1);
    answer = replies[0]!;
    payload = AnswerPayload.parse(answer.meta.answer);
  }, 150_000);

  it('is the bot’s message in the person’s own thread, carrying its text and the Answer', () => {
    expect(answer.body).toContain('The deploy waits for the Monday window [1]');
    expect(answer.threadRootId).toBe(root);
    expect(answer.channelId).toBe(chat);
    expect(payload.body).toBe(answer.body);
  });

  it('keeps the citation the asker may open with the platform’s own words, and has no trace of the one she cannot', () => {
    expect(payload.citations).toHaveLength(1);
    expect(payload.citations[0]).toMatchObject({
      n: 1,
      kind: 'message',
      messageId: devMessage,
      channelId: devChannel,
      channelKind: 'channel',
      channelName: 'dev',
      scope: 'team',
      label: 'The deploy waits for the Monday change window',
    });
    expect(payload.lineage).toHaveLength(1);
    expect(payload.lineage[0]).toMatchObject({ n: 1, kind: 'message', snippet: 'The deploy waits for the Monday change window' });
    // not the id, not the label, not the bot's own quote of it — in the message the person reads, nowhere
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain(leadsMessage);
    expect(wire).not.toContain('Layoffs');
    expect(wire).not.toContain(leadsChannel);
  });

  it('counts what was left out by kind and reason, and what the bot said it could not reach', () => {
    // the lead's message was never reached by this run's search (the asker cannot see it, so the search could not find it): not reached
    expect(payload.outsideScope).toEqual({
      count: 2,
      items: [
        { kind: 'message', reason: 'not_reached', count: 1 },
        { kind: 'drive', reason: 'not_granted', count: 1 },
      ],
    });
  });

  it('lists what the search reached, from the run’s own log, and not what it was told to cite', () => {
    expect(payload.sourcesReached.some((s) => s.ref === devMessage && s.marker === 'full')).toBe(true);
    expect(JSON.stringify(payload.sourcesReached)).not.toContain(leadsMessage);
  });

  it('says whom it was for: stamped from the run, not from anything the bot sent', () => {
    expect(payload.answeredFor).toMatchObject({ personId: nadia.personId, name: 'Nadia', scope: 'scoped', alias: 'smart', botId: brain.botId });
    expect(payload.chips).toEqual([
      { kind: 'followup', label: 'When does it open?', prompt: 'When does the window open?' },
      { kind: 'handoff', botId: coder.botId, botSlug: 'coder', botName: 'Coder' },
    ]);
  });

  it('stays private: the conversation is hers, so nobody else reads the answer, an admin included', async () => {
    for (const who of [rafi, omar]) {
      const res = await w.call(who, 'GET', `/api/channels/${chat}/messages?threadRootId=${root}&limit=20`);
      expect(res.status, `${who.key}`).toBe(403);
    }
  });

  it('announces itself with ids and counts and no team, so a teammate learns nothing from it', async () => {
    const rows = await w.system(async (tx) =>
      (await tx.query<{ team_id: string | null; payload: Record<string, unknown> }>("SELECT team_id, payload FROM app.events WHERE type = 'answer.answer.posted' ORDER BY id")).rows,
    );
    const mine = rows.find((r) => r.payload['messageId'] === answer.id)!;
    expect(mine.team_id).toBeNull();
    expect(mine.payload).toMatchObject({ botId: brain.botId, askerPersonId: nadia.personId, channelId: chat, citationCount: 1, droppedCount: 1, reachedCount: payload.sourcesReached.length });
    expect(mine.payload).not.toHaveProperty('teamId');
    expect(Object.keys(eventRegistry['answer.answer.posted'])).toEqual(['1']);
    // nothing of the text or of what was cited travels in the event
    expect(JSON.stringify(mine.payload)).not.toContain('Layoffs');
  });

  it('is never fed to the team’s memory: the narrowest-source rule refuses a conversation run, and the answer inherits it', async () => {
    const verdict = await w.system(
      async (tx) =>
        (await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.run_retain_verdict($1::uuid)', [(await runFor(root))!.id])).rows[0],
    );
    // a conversation is refused outright; this run also read a private room through its search, which is refused for its own reason first
    expect(['conversation', 'private_source']).toContain(verdict?.retain_refusal);
    const authored = await w.system(
      async (tx) =>
        (await tx.query<{ retain_refusal: string | null; runs: number }>('SELECT retain_refusal, runs FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [brain.actorId, answer.createdAt]))
          .rows[0],
    );
    expect(authored?.retain_refusal).not.toBeNull();
    // and the message is in a conversation channel, which the feed's source query never reads (kind = 'channel' only)
    const kind = (await w.system(async (tx) => (await tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1', [chat])).rows[0]!.kind));
    expect(kind).toBe('bot_conversation');
  });
});

describe('a mention in a team channel', () => {
  it('drops what only the asker may open, counts it, and is withheld from memory because the run read a private message', async () => {
    scenario(
      [
        { name: 'messages.search', arguments: { query: 'zebra' } },
        { name: 'messages.search', arguments: { query: 'Monday change window' } },
        {
          name: 'answer.post',
          arguments: {
            body: 'See [1]. And [2] and [3].',
            citations: [
              { kind: 'message', messageId: devMessage },
              { kind: 'message', messageId: dmMessage, snippet: 'just between us' },
              { kind: 'message', messageId: leadsMessage },
            ],
          },
        },
      ],
    );
    const root = await send(nadia, devChannel, '@brain what is happening with the zebra rollout?');
    expect(await finishedRun(root)).toMatchObject({ status: 'done', trigger_type: 'mention' });
    const replies = (await thread(nadia, devChannel, root)).filter((m) => m.authorId === brain.actorId);
    expect(replies).toHaveLength(1);
    const payload = AnswerPayload.parse(replies[0]!.meta.answer);
    // the channel reads it: the public message stays, the DM (hers to read, not the channel's) and the lead's channel do not
    expect(payload.citations.map((c) => c.n)).toEqual([1]);
    // the DM she cited was never reached (a team search does not reach a direct message) and neither was the lead's channel: `not_reached`,
    // two items. What her search did reach in a place the channel cannot read (the private room, her own conversation) is `not_shared`.
    const reason = (r: string) => payload.outsideScope.items.filter((i) => i.reason === r).reduce((n, i) => n + i.count, 0);
    expect(reason('not_reached')).toBe(2);
    expect(reason('not_shared')).toBeGreaterThanOrEqual(1);
    expect(payload.outsideScope.count).toBe(reason('not_reached') + reason('not_shared'));
    expect(payload.outsideScope.items.every((i) => i.kind === 'message')).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('just between us');
    expect(JSON.stringify(payload)).not.toContain(dmMessage);
    // what the search reached: the public question is listed, the private room's note is only counted
    expect(payload.sourcesReached.some((s) => s.ref === roomMessage)).toBe(false);
    expect(payload.sourcesReached.length).toBeGreaterThan(0);
    expect(payload.answeredFor).toMatchObject({ personId: nadia.personId, scope: 'scoped' });

    // memory: the run read a private message, so it keeps no wider than a private source — and the message the bot wrote in a public channel
    // during it is not the team's to remember either (the authored-text verdict reads the runs that were open when it was written)
    const run = (await runFor(root))!;
    const verdict = await w.system(
      async (tx) => (await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.run_retain_verdict($1::uuid)', [run.id])).rows[0],
    );
    expect(verdict?.retain_refusal).toBe('private_source');
    const authored = await w.system(
      async (tx) =>
        (await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [brain.actorId, replies[0]!.createdAt]))
          .rows[0],
    );
    expect(authored?.retain_refusal).not.toBeNull();
  });
});

describe('what a bot cannot do', () => {
  it('cannot name whom the answer is for: the call is refused as it stands, and the run goes on to reply in plain text', async () => {
    scenario([{ name: 'answer.post', arguments: { body: 'x', answeredFor: { personId: omar.personId, name: 'Omar', scope: 'team' } } }]);
    const chat = await conversationOf(nadia, 'brain');
    const root = await send(nadia, chat, 'Forge an answer for Omar');
    expect(await finishedRun(root)).toMatchObject({ status: 'done' });
    const seen = spooled().find((s) => s.prompt.includes('Forge an answer for Omar'))!;
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: false, code: 'platform_field' });
    const replies = (await thread(nadia, chat, root)).filter((m) => m.authorId === brain.actorId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.meta.answer).toBeUndefined();
    expect(replies[0]!.body).toContain('Answering: Nadia: Forge an answer for Omar');
  });

  it('cannot post an answer twice: the second call says so and the thread has one', async () => {
    const args = { body: 'The first and only answer.', citations: [{ kind: 'message', messageId: devMessage }] };
    scenario([{ name: 'answer.post', arguments: args }, { name: 'answer.post', arguments: { body: 'A second answer.' } }]);
    const chat = await conversationOf(nadia, 'brain');
    const root = await send(nadia, chat, 'Answer twice please');
    expect(await finishedRun(root)).toMatchObject({ status: 'done' });
    const seen = spooled().find((s) => s.prompt.includes('Answer twice please'))!;
    expect(toolAnswer(seen.results[0]!)).toMatchObject({ ok: true });
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: false, code: 'already_answered' });
    const replies = (await thread(nadia, chat, root)).filter((m) => m.authorId === brain.actorId);
    expect(replies.map((m) => m.body)).toEqual(['The first and only answer.']);
  });

  it('cannot smuggle an answer through the plain post tool: `messages.post` refuses a meta, and the same call without one stores one plain message', async () => {
    const plain = { channelId: devChannel, body: 'Looks like an answer' };
    const smuggled = { ...plain, meta: { answer: { version: 1, body: 'x' }, runId: randomUUID() } };
    scenario([
      { name: 'messages.post', arguments: smuggled },
      // the control: what the tool does take, posted the same way
      { name: 'messages.post', arguments: plain },
    ]);
    const chat = await conversationOf(nadia, 'brain');
    const root = await send(nadia, chat, 'Smuggle an answer');
    await finishedRun(root);
    const seen = spooled().find((s) => s.prompt.includes('Smuggle an answer'))!;
    // the strict schema of the tool answers the unknown key as a validation failure, naming it: nothing was stored for it
    expect(seen.results[0]!.status).toBe(400);
    expect(JSON.parse(seen.results[0]!.body)).toMatchObject({ error: { code: 'validation_failed' } });
    expect(seen.results[0]!.body).toContain('meta');
    expect(seen.results[1]!.status).toBe(200);
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: true });
    const stored = await w.system(
      async (tx) => (await tx.query<{ meta: Record<string, unknown> }>("SELECT meta FROM app.messages WHERE body = 'Looks like an answer'")).rows,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.meta).not.toHaveProperty('answer');
    expect(stored[0]!.meta).not.toHaveProperty('runId');
  });

  it('serialises two calls of one run made at the same moment: one is stored, the other is told so', async () => {
    const args = { body: 'The one answer, whichever call won.' };
    scenario([{ name: 'answer.post', arguments: args }, { name: 'answer.post', arguments: args }], 'The text printed after the calls', true);
    const chat = await conversationOf(nadia, 'brain');
    const root = await send(nadia, chat, 'Answer twice at once');
    expect(await finishedRun(root)).toMatchObject({ status: 'done' });
    const seen = spooled().find((s) => s.prompt.includes('Answer twice at once'))!;
    const codes = seen.results.map((r) => toolAnswer(r)).map((a) => (a['ok'] === true ? 'ok' : String(a['code']))).sort();
    expect(codes).toEqual(['already_answered', 'ok']);
    const replies = (await thread(nadia, chat, root)).filter((m) => m.authorId === brain.actorId);
    expect(replies.map((m) => m.body)).toEqual(['The one answer, whichever call won.']);
  });

  it('is not offered to a bot that was not granted it, and refused when it is called anyway', async () => {
    scenario([{ method: 'tools/list' }, { name: 'answer.post', arguments: { body: 'Sneaking one in' } }]);
    const chat = await conversationOf(nadia, 'mute');
    const root = await send(nadia, chat, 'Mute, answer');
    expect(await finishedRun(root)).toMatchObject({ status: 'done' });
    const seen = spooled().find((s) => s.prompt.includes('Mute, answer'))!;
    const listed = (JSON.parse(seen.results[0]!.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(listed).toContain('messages.post');
    expect(listed).not.toContain('answer.post');
    expect(toolAnswer(seen.results[1]!)).toMatchObject({ ok: false, code: 'forbidden' });
    const replies = (await thread(nadia, chat, root)).filter((m) => m.authorId === mute.actorId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.meta.answer).toBeUndefined();
  });

  it('is offered to the bot that was, with what it takes described', async () => {
    scenario([{ method: 'tools/list' }]);
    const chat = await conversationOf(nadia, 'brain');
    const root = await send(nadia, chat, 'What tools do I have?');
    await finishedRun(root);
    const seen = spooled().find((s) => s.prompt.includes('What tools do I have?'))!;
    const tools = (JSON.parse(seen.results[0]!.body) as { result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    const tool = tools.find((t) => t.name === 'answer.post')!;
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['body', 'chips', 'citations', 'outsideScope']);
    expect(tool.description).toContain('re-checks every citation');
  });
});
