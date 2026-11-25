import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { readFakeAsrText, type LlmTranscriber } from '@manythreads/sdk';
import {
  MEETING_ASK_PUSH,
  MEETING_CAPTION_PUSH,
  MEETING_CATCHUP_PUSH,
  MeetingAssistantStatus,
  StartMeetingResponse,
  type MeetingAskPush,
  type MeetingCaption,
  type MeetingCatchUpPush,
  type MeetingTranscriptLine,
} from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../../files/test/world.ts';
import { CATCH_UPS_PER_WINDOW, assistantStatusOf, catchUpLimiter, readSummary, transcriptExcerpt } from '../src/assistant.ts';

// The meeting assistant in a live call (PLAN P17-06, docs/plans/meeting-assistant.md):
//  * the rules of who may ask (a pure function) and the excerpt the models are given (whole lines, the newest kept);
//  * Ask without a note-taker: the workspace Brain answers through the meeting-run door, with the call so far in its prompt (never the words of a person who said no), and the
//    answer lands in the thread, on the screens and in the asker's panel; refused for a person not in the call and in a private channel;
//  * Ask with a note-taker: the question takes the note-taker's own path (P15-24), and a person who said no is refused;
//  * Catch me up: only lines from before the person joined, only of people who said yes, pushed to that person only; nothing for someone who was there from the start;
//    three in ten minutes.
// Brain and the note-taker run on a stand-in for Hermes (a script that reads the prompt), the fast model is a small local server speaking the proxy's shape.

const { omar, nadia, rafi, priya, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

// ---- pure parts ----------------------------------------------------------------------------------------------------------------------------------------------------

const line = (startMs: number, speakerName: string, text: string): MeetingTranscriptLine =>
  ({ segmentId: null, speakerId: '00000000-0000-4000-8000-000000000001', speakerName, startMs, endMs: startMs + 1000, text, transcribed: true, editable: false }) as MeetingTranscriptLine;

describe('the excerpt a model is given', () => {
  it('writes one "@ms | clock | speaker: words" line each, and keeps the newest whole lines when it is too long', () => {
    const lines = [line(1000, 'Nadia', 'first'), line(65_000, 'Ra:fi|x', 'second'), line(3_700_000, 'Nadia', 'third')];
    expect(transcriptExcerpt(lines, 10_000)).toEqual({ text: '@1000 | 00:00:01 | Nadia: first\n@65000 | 00:01:05 | Ra fi x: second\n@3700000 | 01:01:40 | Nadia: third', cut: false });
    const cut = transcriptExcerpt(lines, 70);
    expect(cut.cut).toBe(true);
    expect(cut.text).toBe('@3700000 | 01:01:40 | Nadia: third');
    expect(transcriptExcerpt([], 100)).toEqual({ text: '', cut: false });
  });
  it('takes linear time on many lines', () => {
    const many = Array.from({ length: 5000 }, (_, i) => line(i * 1000, 'Someone', 'x'.repeat(200)));
    const t = performance.now();
    transcriptExcerpt(many, 60_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
  it('reads a summary as plain text without control characters', () => {
    expect(readSummary('  We talked.\r\n\r\n\r\n\r\nWe decided.\u0007  ')).toBe('We talked.\n\nWe decided.');
    expect(readSummary('   ')).toBe('');
  });
});

describe('who may ask', () => {
  const base = {
    meeting: { state: 'live', started_at: new Date('2026-11-25T10:00:00Z') } as never,
    me: { actorId: 'a', personId: 'p', displayName: 'Nadia', consent: 'unasked' as const, joinedAt: new Date('2026-11-25T10:12:30Z') },
    notetaker: null,
    brain: { id: 'b', name: 'Brain' },
    publicTeamChannel: true,
    onTeam: true,
  };
  const ok = { runs: true, llm: true };
  it('offers Brain in a public team channel, and says how many minutes came before the person', () => {
    const s = assistantStatusOf(base, ok);
    expect(s.ask).toEqual({ available: true, answerer: { kind: 'brain', name: 'Brain' }, reason: null });
    expect(s.catchUp).toEqual({ available: true, minutesBefore: 12, reason: null });
  });
  it('sends the question to the note-taker when there is one, only for a person who said yes', () => {
    const nt = { ...base, notetaker: { id: 'n', name: 'Note-taker', teamId: 't' } };
    expect(assistantStatusOf(nt, ok).ask).toMatchObject({ available: false, answerer: { kind: 'notetaker' }, reason: 'Say yes to “Transcribe my voice” to ask Note-taker.' });
    expect(assistantStatusOf({ ...nt, me: { ...base.me, consent: 'yes' } }, ok).ask.available).toBe(true);
  });
  it('says why not: elsewhere than a public team channel, another team, not in the call, ended, no model', () => {
    expect(assistantStatusOf({ ...base, publicTeamChannel: false }, ok).ask.reason).toMatch(/public channels.*note-taker/);
    expect(assistantStatusOf({ ...base, onTeam: false }, ok).ask.reason).toBe("Brain answers the people of this call's team.");
    expect(assistantStatusOf({ ...base, me: null }, ok)).toMatchObject({ ask: { available: false, reason: 'Join the call to use the assistant.' }, catchUp: { available: false } });
    expect(assistantStatusOf({ ...base, meeting: { state: 'ended', started_at: new Date() } as never }, ok).catchUp.reason).toBe('The call has ended.');
    expect(assistantStatusOf(base, { runs: true, llm: false }).catchUp.reason).toMatch(/no model/);
    expect(assistantStatusOf({ ...base, brain: null }, ok).ask.reason).toMatch(/no Brain/);
  });
});

// ---- the whole path ------------------------------------------------------------------------------------------------------------------------------------------------

// The stand-in for Hermes: an answer run says who answered from what; a notes run answers empty notes. Every prompt goes to the spool.
const FAKE_HERMES = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const spool = (obj) => appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify(obj) + '\\n');",
  "const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
  "const first = prompt.split('\\n')[0];",
  "spool({ at: Date.now(), first, prompt });",
  // the run's own MCP endpoint and token, from the profile the platform rendered (the e2e stand-in reads it the same way)
  "const toolCaller = () => {",
  "  const config = readFileSync(`${process.env.HERMES_HOME ?? ''}/config.yaml`, 'utf8');",
  "  const url = JSON.parse(/^\\s+url: (.*)$/m.exec(config)[1]);",
  "  const bearer = JSON.parse(/Authorization: (.*)$/m.exec(config)[1]);",
  "  let id = 0;",
  "  return async (name, args) => {",
  "    const res = await fetch((process.env.HERMES_FAKE_ORIGIN ?? '') + new URL(url).pathname, { method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } }) });",
  "    const raw = await res.text();",
  "    spool({ at: Date.now(), tool: name, reply: raw.slice(0, 4000) });",
  "    return raw;",
  "  };",
  "};",
  "if (first === 'Answer a question asked in a meeting.') {",
  "  const q = prompt.slice(prompt.indexOf('----- QUESTION -----') + 20, prompt.indexOf('----- END OF QUESTION -----')).trim();",
  "  if (q.includes('SLOW-FOREVER')) await new Promise((r) => setTimeout(r, 60000));",
  "process.on('uncaughtException', (e) => { spool({ at: Date.now(), crash: String(e && e.stack || e).slice(0, 2000) }); process.exit(1); });",
  "process.on('unhandledRejection', (e) => { spool({ at: Date.now(), crash: String(e && e.stack || e).slice(0, 2000) }); process.exit(1); });",
  "  if (q.includes('TOOLS-PROBE')) {",
  "    const tool = toolCaller();",
  "    await tool('messages.search', { query: 'shipdate' });",
  "    await tool('knowledge.search', { query: 'shipdate', teamId: null });",
  "    await tool('personal.read', { path: 'notes.md' });",
  "  }",
  "  if (q.includes('TOOLS-LOOP')) { const tool = toolCaller(); for (let i = 0; i < 10; i += 1) await tool('messages.search', { query: 'loop ' + i }); }",
  "  const withCall = prompt.includes('----- TRANSCRIPT SO FAR -----') ? ' with the call so far' : '';",
  "  out({ type: 'result', exit_code: 0, text: 'Answered' + withCall + ': ' + q, tokens: { input: 5, output: 5, total: 10 } });",
  "} else if (first === 'Write the notes of a meeting.') {",
  "  out({ type: 'result', exit_code: 0, text: JSON.stringify({ summary: 'Nothing much.', decisions: [], actionItems: [], questions: [] }), tokens: { input: 5, output: 5, total: 10 } });",
  '} else {',
  "  out({ type: 'result', exit_code: 0, text: '[]', tokens: { input: 1, output: 1, total: 2 } });",
  '}',
  '',
].join('\n');

const NOTE_TAKER_MD = [
  '---',
  'schema: 1',
  'name: Note-taker',
  'role: Sits in a call and writes its notes',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart, fast]',
  'triggers:',
  '  - type: meeting',
  'capabilities:',
  '  native: [meetings.read, meetings.search, memory.recall, meetings.write_notes]',
  '---',
  '',
  '# Note-taker',
  '',
  'Stand-in definition.',
  '',
].join('\n');

let w: FilesWorld;
let scratch = '';
let spool = '';
let litellm: Server | undefined;
const summaryCalls: Array<{ system: string; user: string }> = [];
let listen: pg.Client | undefined;
const pushed: Array<{ personId: string; type: string; payload: unknown }> = [];
const saved: Record<string, string | undefined> = Object.fromEntries(
  ['MANYTHREADS_MEDIA_PROVIDER', 'MANYTHREADS_FAKE_ASR', 'MANYTHREADS_HERMES_BIN', 'MANYTHREADS_HERMES_PREFIX', 'MANYTHREADS_RUNTIME_DIR', 'MANYTHREADS_LITELLM_URL', 'HERMES_FAKE_SPOOL', 'MANYTHREADS_MEETING_ANSWER_DEADLINE_MS', 'HERMES_FAKE_ORIGIN'].map((k) => [k, process.env[k]]),
);
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
const transcriber: LlmTranscriber = {
  id: 'test-transcriber',
  async transcribe(_tx, request) {
    return { outcome: 'text', text: readFakeAsrText(request.wav), lang: 'en' };
  },
};

const spooled = (): Array<{ first: string; prompt: string; tool?: string; reply?: string }> =>
  existsSync(spool) ? readFileSync(spool, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { first: string; prompt: string; tool?: string; reply?: string }) : [];
const toolReplies = (): Array<{ tool: string; reply: string }> => spooled().filter((s) => typeof s.tool === 'string').map((s) => ({ tool: s.tool!, reply: s.reply ?? '' }));
const answerPrompts = (): string[] => spooled().filter((s) => s.first === 'Answer a question asked in a meeting.').map((s) => s.prompt);
const ok = <T>(res: { status: number; body: unknown }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => {
  const c = new pg.Client({ connectionString: w.server.db.ownerUrl });
  await c.connect();
  try {
    return (await c.query<T>(sql, values)).rows;
  } finally {
    await c.end();
  }
};
const threadOf = (room: string) =>
  w.system(async (tx) =>
    (
      await tx.query<{ body: string; kind: string }>(
        `SELECT m.body, a.kind FROM app.messages m JOIN app.meetings mt ON mt.thread_root_id = m.thread_root_id JOIN app.actors a ON a.id = m.author_id WHERE mt.id = $1 AND m.id <> mt.thread_root_id ORDER BY m.id`,
        [room],
      )
    ).rows,
  );
const asksTo = (personId: string, askId: string): MeetingAskPush[] =>
  pushed.filter((p) => p.type === MEETING_ASK_PUSH && p.personId === personId && (p.payload as MeetingAskPush).askId === askId).map((p) => p.payload as MeetingAskPush);
const catchUpsTo = (requestId: string): Array<{ personId: string; payload: MeetingCatchUpPush }> =>
  pushed.filter((p) => p.type === MEETING_CATCHUP_PUSH && (p.payload as MeetingCatchUpPush).requestId === requestId).map((p) => ({ personId: p.personId, payload: p.payload as MeetingCatchUpPush }));
const answerCaptions = (room: string): MeetingCaption[] =>
  pushed
    .filter((p) => p.type === MEETING_CAPTION_PUSH && (p.payload as { meetingId: string }).meetingId === room)
    .flatMap((p) => (p.payload as { captions: MeetingCaption[] }).captions)
    .filter((c) => c.kind === 'answer');

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'meetings-assistant-'));
  spool = join(scratch, 'spool.jsonl');
  const script = join(scratch, 'fake-hermes.mjs');
  writeFileSync(script, FAKE_HERMES, 'utf8');
  // the fast model: a summary names how many lines it read; the note-taker's "is it a question" check is never asked here (a typed question is not checked)
  litellm = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: string }> };
        const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        summaryCalls.push({ system, user });
        const n = user.split('\n').filter((l) => l.startsWith('@')).length;
        res.end(JSON.stringify({ choices: [{ message: { content: `Before you came, ${n} things were said.` } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'fake-fast' }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => litellm!.listen(0, '127.0.0.1', resolve));
  const port = (litellm.address() as { port: number }).port;
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  process.env['MANYTHREADS_FAKE_ASR'] = '1';
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = script;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = `http://127.0.0.1:${port}`;
  process.env['HERMES_FAKE_SPOOL'] = spool;
  // an answer in a call is stopped after this long (the default is 90 s)
  process.env['MANYTHREADS_MEETING_ANSWER_DEADLINE_MS'] = '5000';
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { transcriber, reconcileMs: 250, flushMs: 500 };
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  // the profile names the public address; the stand-in calls this test server instead
  process.env['HERMES_FAKE_ORIGIN'] = w.server.url;
  await ensureChannels(w);
  await w.system(async (tx) => void (await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'fast', NULL, 'fake/fast', '{}') ON CONFLICT DO NOTHING`, [omar.workspaceId])));
  // the workspace Brain is made by the bots plugin's job (a fresh world has none until it runs)
  await owner(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('bots.ensure-workspace-brain', '{}'::jsonb, now())`);
  await eventually(
    async () => ((await owner(`SELECT 1 FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.scope = 'workspace' AND b.slug = 'brain' AND b.status = 'active'`)).length > 0 ? true : undefined),
    60_000,
    'the workspace Brain',
  );
  // every realtime push, as the sockets would get it
  listen = new pg.Client({ connectionString: w.server.db.systemUrl });
  await listen.connect();
  listen.on('notification', (n) => {
    if (n.payload) pushed.push(JSON.parse(n.payload) as (typeof pushed)[number]);
  });
  await listen.query('LISTEN manythreads_realtime');
}, 300_000);
afterAll(async () => {
  await listen?.end().catch(() => undefined);
  await w?.close();
  await new Promise<void>((resolve) => (litellm ? litellm.close(() => resolve()) : resolve()));
  delete (globalThis as unknown as Record<symbol, unknown>)[HOOK];
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

type Who = typeof nadia;
let seq = 0;
const say = (who: Who, room: string, text: string, startMs: number) =>
  w.call(who, 'POST', `/api/meetings/${room}/segments`, { segments: [{ clientSegId: `a${++seq}`, startMs, endMs: startMs + 1000, text, final: true }] });

/** A room in `channelId` with on-device transcription: Nadia starts it, the others join, Nadia and Rafi say yes, Priya says no. */
async function openRoom(channelId: string, others: Who[] = [rafi, priya]): Promise<{ id: string; threadRootId: string }> {
  const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${channelId}/meetings`, {})));
  const id = started.meeting.id;
  for (const p of others) ok(await w.call(p, 'POST', `/api/meetings/${id}/join`));
  ok(await w.call(nadia, 'PUT', `/api/meetings/${id}/transcription`, { mode: 'on_device' }));
  for (const p of [nadia, ...others]) ok(await w.call(p, 'POST', `/api/meetings/${id}/consent`, { transcribe: p === priya ? 'no' : 'yes' }));
  return { id, threadRootId: started.meeting.threadRootId! };
}

describe('Ask, with no note-taker in the room: Brain answers', () => {
  let room: { id: string; threadRootId: string };
  beforeAll(async () => {
    room = await openRoom(await w.channelId('engineering', 'general'));
    ok(await say(nadia, room.id, 'We ship the release on Thursday.', 1000));
    ok(await say(priya, room.id, 'PRIYA-PRIVATE-WORDS about the budget.', 2000));
  });

  it('tells the panel who answers', async () => {
    const status = MeetingAssistantStatus.parse(ok(await w.call(nadia, 'GET', `/api/meetings/${room.id}/assistant`)));
    expect(status.ask).toEqual({ available: true, answerer: { kind: 'brain', name: 'Brain' }, reason: null });
    expect(status.catchUp.available).toBe(true);
    // someone who cannot see the call learns nothing of it
    expect((await w.call(sameera, 'GET', `/api/meetings/${room.id}/assistant`)).status).toBe(404);
  });

  it('answers in the thread, on the screens and in the asker’s panel, from the call so far without the words of a person who said no', async () => {
    const before = answerPrompts().length;
    const res = ok<{ askId: string; answerer: { kind: string } }>(await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'When do we ship, @coder?' }), 202);
    expect(res.answerer.kind).toBe('brain');
    const line = await eventually(async () => (await threadOf(room.id)).find((m) => m.kind === 'bot' && m.body.includes('Answered')), 90_000, 'Brain’s answer in the thread');
    expect(line.body).toContain('Nadia asked Brain:');
    expect(line.body).toContain('Answered with the call so far');
    // a quoted mention in the heading is not a mention
    expect(line.body.split('\n\n')[0]).not.toMatch(/@coder/);
    const prompt = answerPrompts().slice(before).at(-1)!;
    expect(prompt).toContain('typed a question');
    expect(prompt).toContain('We ship the release on Thursday.');
    expect(prompt).not.toContain('PRIYA-PRIVATE-WORDS');
    expect(prompt).toContain('#general');
    // the question was shown waiting at once, then answered
    expect(asksTo(nadia.personId, res.askId)[0]).toMatchObject({ state: 'asking', question: 'When do we ship, @coder?' });
    const told = await eventually(async () => asksTo(nadia.personId, res.askId).find((a) => a.state !== 'asking'), 20_000, 'the push to the asker');
    expect(told).toMatchObject({ state: 'answered', answererName: 'Brain' });
    expect(told.text).toContain('Answered');
    // only the asker is told in the panel
    expect(pushed.filter((p) => p.type === MEETING_ASK_PUSH && (p.payload as MeetingAskPush).askId === res.askId).every((p) => p.personId === nadia.personId)).toBe(true);
    await eventually(async () => (answerCaptions(room.id).some((c) => c.askerName === 'Nadia' && c.speakerName === 'Brain') ? true : undefined), 20_000, 'the answer caption');
  });

  it('holds Brain’s searches to the call’s own channel before it reads, gives its knowledge search the call’s team, and offers no other tool', async () => {
    const general = await w.channelId('engineering', 'general');
    const dev = await w.channelId('engineering', 'dev');
    ok(await w.call(nadia, 'POST', `/api/channels/${general}/messages`, { channelId: general, body: 'shipdate ROOM-HIT is Thursday', threadRootId: null }), 201);
    ok(await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'shipdate OTHER-HIT is Friday', threadRootId: null }), 201);
    const before = toolReplies().length;
    const res = ok<{ askId: string }>(await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'TOOLS-PROBE when do we ship?' }), 202);
    const told = await eventually(async () => asksTo(nadia.personId, res.askId).find((a) => a.state !== 'asking'), 90_000, 'the answer of the probing run');
    const crashed = spooled().filter((x) => (x as { crash?: string }).crash);
    expect(crashed, JSON.stringify(crashed)).toEqual([]);
    // nothing it read lay outside the room, so the answer was not thrown away
    expect(told).toMatchObject({ state: 'answered' });
    const replies = toolReplies().slice(before);
    const search = replies.find((r) => r.tool === 'messages.search')!.reply;
    expect(search).toContain('ROOM-HIT');
    expect(search).not.toContain('OTHER-HIT');
    const knowledge = replies.find((r) => r.tool === 'knowledge.search')!.reply;
    expect(knowledge).not.toMatch(/validation_failed|invalid_arguments|expected string/);
    expect(replies.find((r) => r.tool === 'personal.read')!.reply).toMatch(/not available here/);
  });

  it('turns away searches past the cap of one answer, and the answer still comes', async () => {
    const before = toolReplies().length;
    const res = ok<{ askId: string }>(await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'TOOLS-LOOP anything?' }), 202);
    const told = await eventually(async () => asksTo(nadia.personId, res.askId).find((a) => a.state !== 'asking'), 90_000, 'the answer of the looping run');
    expect(told).toMatchObject({ state: 'answered' });
    const replies = toolReplies().slice(before).filter((r) => r.tool === 'messages.search');
    expect(replies).toHaveLength(10);
    expect(replies.slice(0, 8).every((r) => !r.reply.includes('may make'))).toBe(true);
    expect(replies.slice(8).every((r) => r.reply.includes('searches one answer in a call may make'))).toBe(true);
  });

  it('stops an answer that takes too long and tells the asker so, with nothing in the thread', async () => {
    const lines = (await threadOf(room.id)).length;
    const res = ok<{ askId: string }>(await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'SLOW-FOREVER please' }), 202);
    const told = await eventually(async () => asksTo(nadia.personId, res.askId).find((a) => a.state !== 'asking'), 60_000, 'the failure push');
    expect(told).toMatchObject({ state: 'failed', text: 'Brain took too long. Try a shorter question.' });
    expect((await threadOf(room.id)).length).toBe(lines);
  });

  it('refuses a person who is not in the call, and a question that is empty or too long', async () => {
    const res = await w.call(omar, 'POST', `/api/meetings/${room.id}/ask`, { question: 'Anything?' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Join the call');
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: '   ' })).status).toBe(400);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'x'.repeat(501) })).status).toBe(400);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.id}/ask`, { question: 'ok', extra: 1 })).status).toBe(400);
  });

  it('says why not in a private channel (Brain may not post there)', async () => {
    const secret = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'assistant-private', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
    const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${secret}/meetings`, {})));
    const res = await w.call(nadia, 'POST', `/api/meetings/${started.meeting.id}/ask`, { question: 'Anything?' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/public channels/);
    ok(await w.call(nadia, 'POST', `/api/meetings/${started.meeting.id}/end`));
  });
});

describe('Catch me up', () => {
  let room: { id: string; threadRootId: string };
  beforeAll(async () => {
    room = await openRoom(await w.channelId('engineering', 'dev'));
    ok(await say(nadia, room.id, 'Rafi owns the rollback note.', 100));
    ok(await say(rafi, room.id, 'I will write it by Friday.', 200));
    ok(await say(priya, room.id, 'PRIYA-SAID-NO words.', 300));
    await new Promise((r) => setTimeout(r, 1500));
    ok(await w.call(omar, 'POST', `/api/meetings/${room.id}/join`));
    const [facts] = await owner<{ before_ms: number }>(
      `SELECT (extract(epoch FROM (p.joined_at - m.started_at)) * 1000)::int AS before_ms FROM app.meetings m JOIN app.meeting_participants p ON p.meeting_id = m.id WHERE m.id = $1 AND p.actor_id = $2`,
      [room.id, omar.actorId],
    );
    ok(await say(nadia, room.id, 'AFTER-THE-JOIN words.', facts!.before_ms + 5000));
  });

  it('summarises only what was said before the person joined, only of people who said yes, and tells that person only', async () => {
    const calls = summaryCalls.length;
    const res = ok<{ requestId: string; minutesBefore: number }>(await w.call(omar, 'POST', `/api/meetings/${room.id}/catch-up`), 202);
    expect(res.minutesBefore).toBe(0);
    const told = await eventually(async () => catchUpsTo(res.requestId)[0], 30_000, 'the summary push');
    expect(told.personId).toBe(omar.personId);
    expect(told.payload).toMatchObject({ state: 'ready', meetingId: room.id, text: 'Before you came, 2 things were said.' });
    expect(catchUpsTo(res.requestId)).toHaveLength(1);
    const call = summaryCalls.slice(calls).at(-1)!;
    expect(call.system).toMatch(/joined a meeting late/);
    expect(call.user).toContain('Rafi owns the rollback note.');
    expect(call.user).toContain('I will write it by Friday.');
    expect(call.user).not.toContain('PRIYA-SAID-NO');
    expect(call.user).not.toContain('AFTER-THE-JOIN');
    const spent = await owner<{ purpose: string }>(`SELECT purpose FROM app.llm_spend WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [`person:${omar.personId}`]).catch(() => []);
    if (spent.length > 0) expect(spent[0]!.purpose).toBe('meeting_catchup');
  });

  it('has nothing to tell someone who was there from the start, and asks no model for it', async () => {
    const calls = summaryCalls.length;
    const res = ok<{ requestId: string }>(await w.call(nadia, 'POST', `/api/meetings/${room.id}/catch-up`), 202);
    const told = await eventually(async () => catchUpsTo(res.requestId)[0], 30_000, 'the empty push');
    expect(told.payload).toMatchObject({ state: 'empty', text: 'Nothing was written down before you joined.' });
    expect(summaryCalls.length).toBe(calls);
  });

  it('gives nothing once the call has ended, even to a job that was queued while it was live (a note-taker’s transcript is then the organizer’s own)', async () => {
    const other = await openRoom(await w.channelId('engineering', 'incidents'));
    ok(await say(nadia, other.id, 'ENDED-CALL words.', 100));
    ok(await w.call(omar, 'POST', `/api/meetings/${other.id}/join`));
    ok(await w.call(nadia, 'POST', `/api/meetings/${other.id}/end`));
    const requestId = '00000000-0000-4000-8000-0000000000e1';
    const calls = summaryCalls.length;
    const payload = { requestId, meetingId: other.id, workspaceId: omar.workspaceId, actorId: omar.actorId, personId: omar.personId, askedAt: new Date().toISOString() };
    await owner(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('meetings.catch-up', $1::jsonb, now())`, [JSON.stringify(payload)]);
    const told = await eventually(async () => catchUpsTo(requestId)[0], 30_000, 'the push of the queued job');
    expect(told.payload).toMatchObject({ state: 'failed', text: 'The call has ended.' });
    expect(summaryCalls.length).toBe(calls);
    expect((await w.call(omar, 'POST', `/api/meetings/${other.id}/catch-up`)).status).toBe(409);
  });

  it('refuses a person outside the call, and a fourth summary in ten minutes', async () => {
    expect((await w.call(sameera, 'POST', `/api/meetings/${room.id}/catch-up`)).status).toBe(404);
    while (catchUpLimiter.take(`${room.id}:${rafi.actorId}`, 1, CATCH_UPS_PER_WINDOW, Date.now()) === null);
    const res = await w.call(rafi, 'POST', `/api/meetings/${room.id}/catch-up`);
    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).toContain('Try again');
  });
});

describe('Ask, with a note-taker in the room: the note-taker answers through its own path', () => {
  let room: { id: string; threadRootId: string };
  beforeAll(async () => {
    ok(await w.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'bots/note-taker/BOT.md', op: 'put', content: NOTE_TAKER_MD, title: 'Set up the note-taker', applyNow: true }), 201);
    await eventually(
      async () => ((await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = 'note-taker' AND b.status = 'active'")).rows.length)) > 0 ? true : undefined),
      30_000,
      'the loader to load the note-taker',
    );
    const channelId = await w.channelId('engineering', 'releases');
    const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${channelId}/meetings`, {})));
    room = { id: started.meeting.id, threadRootId: started.meeting.threadRootId! };
    ok(await w.call(rafi, 'POST', `/api/meetings/${room.id}/join`));
    ok(await w.call(priya, 'POST', `/api/meetings/${room.id}/join`));
    const botId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = 'note-taker'")).rows[0]!.id);
    ok(await w.call(rafi, 'PUT', `/api/meetings/${room.id}/notetaker`, { botId }));
    await eventually(async () => lastFakeMedia().listenerIn(room.id), 20_000, 'the listener to join');
    for (const p of [nadia, rafi]) ok(await w.call(p, 'POST', `/api/meetings/${room.id}/consent`, { transcribe: 'yes' }));
    ok(await w.call(priya, 'POST', `/api/meetings/${room.id}/consent`, { transcribe: 'no' }));
  });

  it('takes a typed question without the model check and answers it in the thread, as a caption and in the panel', async () => {
    const status = MeetingAssistantStatus.parse(ok(await w.call(rafi, 'GET', `/api/meetings/${room.id}/assistant`)));
    expect(status.ask.answerer).toEqual({ kind: 'notetaker', name: 'Note-taker' });
    const before = answerPrompts().length;
    const checks = summaryCalls.length;
    const res = ok<{ askId: string; answerer: { kind: string } }>(await w.call(rafi, 'POST', `/api/meetings/${room.id}/ask`, { question: 'What did we decide about the rollback?' }), 202);
    expect(res.answerer.kind).toBe('notetaker');
    const line = await eventually(async () => (await threadOf(room.id)).find((m) => m.kind === 'bot' && m.body.includes('What did we decide about the rollback?')), 90_000, 'the answer in the thread');
    expect(line.body).toContain('Rafi asked');
    const prompt = answerPrompts().slice(before).at(-1)!;
    expect(prompt).toContain('typed a question');
    expect(prompt).not.toContain('----- TRANSCRIPT SO FAR -----');
    expect(summaryCalls.length).toBe(checks);
    const told = await eventually(async () => asksTo(rafi.personId, res.askId).find((a) => a.state !== 'asking'), 20_000, 'the push to the asker');
    expect(told).toMatchObject({ state: 'answered', answererName: 'Note-taker' });
    await eventually(async () => (answerCaptions(room.id).some((c) => c.askerName === 'Rafi' && c.speakerName === 'Note-taker') ? true : undefined), 20_000, 'the answer caption');
  });

  it('refuses a person who said no to being transcribed (P15-22’s rule), and queues nothing', async () => {
    const res = await w.call(priya, 'POST', `/api/meetings/${room.id}/ask`, { question: 'What is the plan?' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Say yes to');
    const queued = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.jobs WHERE queue IN ('meetings.question', 'meetings.ask') AND payload->>'askerActorId' = $1", [priya.actorId])).rows.length);
    expect(queued).toBe(0);
  });
});
