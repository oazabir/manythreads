import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { readFakeAsrText, type LlmTranscriber } from '@manythreads/sdk';
import { MEETING_CAPTION_PUSH, MEETING_QUESTIONS_PER_MINUTE, StartMeetingResponse, type MeetingCaption } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../../files/test/world.ts';
import { mentionsAt, mentionsName, noteTakerNames, questionLimiter, readCheck } from '../src/questions.ts';

// Questions to the note-taker in a call (PLAN P15-24, decision C20) and the notes it writes when the call ends (P15-21).
//  * the name scan: folding, word edges, hostile input (linear time);
//  * the whole path on a real server: a person says the note-taker's name, a fast model checks the minute around the line, the note-taker's run answers from the channels everyone
//    present may read, and the answer lands in the thread and as a caption naming the asker; a person who said no is never answered; six a minute; one at a time;
//  * at the end of the call: the notes in the organizer's Personal space, the message to the organizer, the line in the thread, the failure message, a note-taker removed early.
// The note-taker's model is a stand-in for Hermes (a script that reads the prompt), the fast model is a small local server speaking the proxy's shape, the transcriber reads the
// text out of the fake WAV.

const { omar, nadia, rafi, priya } = personas;
vi.setConfig({ testTimeout: 180_000 });

// ---- the scan ------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the name scan', () => {
  const names = noteTakerNames({ name: 'Note-taker', slug: 'note-taker' });

  it('folds case, width and compatibility forms before looking', () => {
    expect(mentionsName('Hey NOTE-TAKER, what did we decide?', names)).toBe(true);
    expect(mentionsName('hey ｎｏｔｅ－ｔａｋｅｒ what now', names)).toBe(true); // full-width letters and hyphen fold to the plain ones
    expect(mentionsName('Notetaker, are you there', names)).toBe(true);
    expect(mentionsName('note taker?', names)).toBe(true);
  });
  it('takes only an @ in front of the name as an address in the thread', () => {
    expect(mentionsAt('@Note-taker what time do we ship?', names)).toBe(true);
    expect(mentionsAt('thanks @NOTE-TAKER!', names)).toBe(true);
    expect(mentionsAt('Rafi added Note-taker. It listens on the server.', names)).toBe(false);
    expect(mentionsAt('mail@note-takers.example', names)).toBe(false);
  });
  it('finds the bot’s own name and slug, whatever they are', () => {
    const scribe = noteTakerNames({ name: 'Maya', slug: 'maya-the-scribe' });
    expect(mentionsName('maya, can you hear me', scribe)).toBe(true);
    expect(mentionsName('MAYA-THE-SCRIBE please', scribe)).toBe(true);
    expect(mentionsName('mayan calendar', scribe)).toBe(false);
  });
  it('wants the name as a word of its own', () => {
    expect(mentionsName('denote-takers are not bots', names)).toBe(false);
    expect(mentionsName('the notetakers union', names)).toBe(false);
    expect(mentionsName('ask the note-taker.', names)).toBe(true);
    expect(mentionsName('(note-taker)', names)).toBe(true);
    expect(mentionsName('Note-taker: what is next', names)).toBe(true);
  });
  it('finds a name in any script and ignores a line that does not hold one', () => {
    const arabic = noteTakerNames({ name: 'كاتب', slug: 'katib' });
    expect(mentionsName('يا كاتب ما القرار؟', arabic)).toBe(true);
    expect(mentionsName('نكتب القرار', arabic)).toBe(false);
    expect(mentionsName('', names)).toBe(false);
    expect(mentionsName('nothing to see', [])).toBe(false);
  });
  it('does not look for a name that is too short to mean anything', () => {
    expect(noteTakerNames({ name: 'Al', slug: 'al' })).toEqual(expect.not.arrayContaining(['al']));
  });
  it('takes linear time on hostile lines: long runs, near-misses, expanding characters', () => {
    const lines = [
      'a'.repeat(4000),
      `${'note-take'.repeat(500)}x`,
      `${'note-taker'.repeat(500)}`.replace(/r/g, 'rx'),
      'ﷺ'.repeat(4000), // folds to eighteen characters each
      `${'́'.repeat(4000)}note-taker`,
      `${'ab'.repeat(20000)}`, // longer than the scan reads
    ];
    const started = performance.now();
    for (let round = 0; round < 50; round += 1) for (const l of lines) mentionsName(l, names);
    const per = (performance.now() - started) / (50 * lines.length);
    expect(per).toBeLessThan(15);
    // a hundred times the input costs about a hundred times the time, not ten thousand times
    const small = (() => {
      const t = performance.now();
      for (let i = 0; i < 400; i += 1) mentionsName(`${'note-take'.repeat(20)}x`, names);
      return (performance.now() - t) / 400;
    })();
    const big = (() => {
      const t = performance.now();
      for (let i = 0; i < 4; i += 1) mentionsName(`${'note-take'.repeat(2000)}x`, names);
      return (performance.now() - t) / 4;
    })();
    expect(big).toBeLessThan(Math.max(small, 0.005) * 1000);
  });
});

describe('what the fast model said', () => {
  it('reads NO as no question, and anything else as the question', () => {
    expect(readCheck('NO')).toBeNull();
    expect(readCheck('no.')).toBeNull();
    expect(readCheck('  No!  ')).toBeNull();
    expect(readCheck('')).toBeNull();
    expect(readCheck('What did we decide about the release date?')).toBe('What did we decide about the release date?');
    expect(readCheck('Question: "What is the plan?"')).toBe('What is the plan?');
    expect(readCheck('\n\nWhat is next?\nSecond line')).toBe('What is next?');
    expect(readCheck('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('six questions a minute', () => {
  it('lets six through and tells the seventh how long to wait, per room', () => {
    const now = 1_000_000;
    for (let i = 0; i < MEETING_QUESTIONS_PER_MINUTE; i += 1) expect(questionLimiter.take('unit-room', 1, MEETING_QUESTIONS_PER_MINUTE, now + i * 1000)).toBeNull();
    expect(questionLimiter.take('unit-room', 1, MEETING_QUESTIONS_PER_MINUTE, now + 10_000)).toBeGreaterThan(0);
    expect(questionLimiter.take('another-room', 1, MEETING_QUESTIONS_PER_MINUTE, now + 10_000)).toBeNull();
    expect(questionLimiter.take('unit-room', 1, MEETING_QUESTIONS_PER_MINUTE, now + 61_000)).toBeNull();
  });
});

// ---- the whole path --------------------------------------------------------------------------------------------------------------------------------------------------

// The note-taker's stand-in for Hermes. `Write the notes of a meeting.`: notes by the same rules as the Scribe's stand-in (DECIDE: x a decision, CRASH a model that falls over).
// `Answer a question asked in a meeting.`: one sentence naming the channels it was offered; a question with SLOW in it takes a second and a half. Every call is written to the spool
// with its start and end times, so the tests can see what was offered and that two answers never overlapped.
const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const spool = (obj) => appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify(obj) + '\\n');",
  "const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
  "const first = prompt.split('\\n')[0];",
  "spool({ at: Date.now(), phase: 'start', first, prompt });",
  "if (first === 'Write the notes of a meeting.') {",
  "  const body = prompt.slice(prompt.indexOf('----- TRANSCRIPT -----'), prompt.indexOf('----- END OF TRANSCRIPT -----'));",
  '  const rows = [];',
  '  for (const raw of body.split("\\n")) { const m = /^@(\\d+) \\| [^|]* \\| ([^:]{1,80}): (.+)$/.exec(raw.trim()); if (m) rows.push({ atMs: Number(m[1]), speaker: m[2], text: m[3] }); }',
  "  if (rows.some((r) => r.text.includes('CRASH'))) { spool({ at: Date.now(), phase: 'end', first }); out({ type: 'result', exit_code: 1, text: '', error: 'model fell over' }); process.exit(1); }",
  '  const notes = { summary: "They talked for " + rows.length + " lines.", decisions: [], actionItems: [], questions: [] };',
  '  for (const r of rows) { let m; if ((m = /DECIDE: (.*)$/.exec(r.text))) notes.decisions.push({ text: m[1], atMs: r.atMs }); }',
  '  const reply = "Here are the notes:\\n```json\\n" + JSON.stringify(notes) + "\\n```";',
  "  spool({ at: Date.now(), phase: 'end', first });",
  "  out({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } });",
  "} else if (first === 'Answer a question asked in a meeting.') {",
  "  const q = prompt.slice(prompt.indexOf('----- QUESTION -----') + 20, prompt.indexOf('----- END OF QUESTION -----')).trim();",
  "  if (q.includes('SLOW')) await new Promise((r) => setTimeout(r, 1500));",
  "  const reply = 'We ship on Thursday, from the channels I was offered. Question was: ' + q;",
  "  spool({ at: Date.now(), phase: 'end', first });",
  "  out({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } });",
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
const checks: string[] = [];
let listen: pg.Client | undefined;
const pushed: Array<{ personId: string; type: string; payload: { meetingId: string; captions: MeetingCaption[] } }> = [];
const saved: Record<string, string | undefined> = Object.fromEntries(
  ['MANYTHREADS_MEDIA_PROVIDER', 'MANYTHREADS_FAKE_ASR', 'MANYTHREADS_HERMES_BIN', 'MANYTHREADS_HERMES_PREFIX', 'MANYTHREADS_RUNTIME_DIR', 'MANYTHREADS_LITELLM_URL', 'HERMES_FAKE_SPOOL'].map((k) => [k, process.env[k]]),
);
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
const transcriber: LlmTranscriber = {
  id: 'test-transcriber',
  async transcribe(_tx, request) {
    return { outcome: 'text', text: readFakeAsrText(request.wav), lang: 'en' };
  },
};

interface Spooled {
  at: number;
  phase: 'start' | 'end';
  first: string;
  prompt?: string;
}
const spooled = (): Spooled[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Spooled)
    : [];
const answerRuns = (): Spooled[] => spooled().filter((s) => s.phase === 'start' && s.first === 'Answer a question asked in a meeting.');

const ok = <T>(res: { status: number; body: unknown }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const threadOf = (room: string) =>
  w.system(async (tx) =>
    (
      await tx.query<{ body: string; kind: string; meta: Record<string, unknown> | null }>(
        `SELECT m.body, a.kind, m.meta FROM app.messages m JOIN app.meetings mt ON mt.thread_root_id = m.thread_root_id JOIN app.actors a ON a.id = m.author_id WHERE mt.id = $1 AND m.id <> mt.thread_root_id ORDER BY m.id`,
        [room],
      )
    ).rows,
  );
const botLines = async (room: string) => (await threadOf(room)).filter((m) => m.kind === 'bot');
const captionsOf = (room: string) => pushed.filter((p) => p.type === MEETING_CAPTION_PUSH && p.payload.meetingId === room).flatMap((p) => p.payload.captions).filter((c) => c.kind === 'answer');

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'meetings-questions-'));
  spool = join(scratch, 'spool.jsonl');
  const script = join(scratch, 'fake-hermes.mjs');
  writeFileSync(script, FAKE_HERMES, 'utf8');
  // the fast model: a question for the note-taker is a line with "?" in it; the answer is that line, cleaned up
  litellm = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: string }> };
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        checks.push(user);
        const last = user.split('\n').filter((l) => l.trim() !== '').at(-1) ?? '';
        const text = last.includes('?') ? `What did we decide about the release date? (${last.replace(/^[^:]*:\s*/, '').slice(0, 80)})` : 'NO';
        res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'fake-fast' }));
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
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { transcriber, reconcileMs: 250, flushMs: 500 };
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
  await w.system(async (tx) => void (await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) VALUES ($1, 'fast', NULL, 'fake/fast', '{}') ON CONFLICT DO NOTHING`, [omar.workspaceId])));
  ok(await w.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'bots/note-taker/BOT.md', op: 'put', content: NOTE_TAKER_MD, title: 'Set up the note-taker', applyNow: true }), 201);
  await eventually(
    async () => ((await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = 'note-taker' AND b.status = 'active'")).rows.length)) > 0 ? true : undefined),
    30_000,
    'the loader to load the note-taker',
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
const speak = async (room: string, who: Who, text: string): Promise<boolean> => {
  const res = await w.call(omar, 'POST', '/api/test/media/speak', { meetingId: room, actorId: who.actorId, text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { delivered: boolean }).delivered;
};
const subscribed = (room: string): string[] => [...(lastFakeMedia().listeners.get(room)?.subscriptions() ?? [])].sort();
const lineSaid = (room: string, text: string) =>
  eventually(async () => ((await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND text = $2', [room, text])).rows.length)) > 0 ? true : undefined), 20_000, `the line "${text}"`);

/** A room in `channel` with the note-taker in it, everyone asked again, Nadia and Rafi saying yes, Priya saying no. */
async function openRoom(channel: string, title: string): Promise<{ id: string; threadRootId: string; botId: string }> {
  const channelId = await w.channelId('engineering', channel);
  const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${channelId}/meetings`, { title })));
  const id = started.meeting.id;
  ok(await w.call(rafi, 'POST', `/api/meetings/${id}/join`));
  ok(await w.call(priya, 'POST', `/api/meetings/${id}/join`));
  const botId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = 'note-taker'")).rows[0]!.id);
  ok(await w.call(rafi, 'PUT', `/api/meetings/${id}/notetaker`, { botId }));
  await eventually(async () => lastFakeMedia().listeners.get(id), 20_000, 'the listener to join');
  ok(await w.call(nadia, 'POST', `/api/meetings/${id}/consent`, { transcribe: 'yes' }));
  ok(await w.call(rafi, 'POST', `/api/meetings/${id}/consent`, { transcribe: 'yes' }));
  ok(await w.call(priya, 'POST', `/api/meetings/${id}/consent`, { transcribe: 'no' }));
  await eventually(async () => (subscribed(id).length === 2 ? true : undefined), 10_000, 'the subscriptions');
  return { id, threadRootId: started.meeting.threadRootId!, botId };
}
const postInThread = (who: Who, room: { id: string; threadRootId: string }, body: string) =>
  w.call(who, 'POST', `/api/channels/${channelOf.get(room.id)}/messages`, { channelId: channelOf.get(room.id), body, threadRootId: room.threadRootId });
const channelOf = new Map<string, string>();

describe('a question put to the note-taker in a call', () => {
  let room: { id: string; threadRootId: string; botId: string };
  beforeAll(async () => {
    room = await openRoom('general', 'Release planning');
    channelOf.set(room.id, await w.channelId('engineering', 'general'));
    // a private channel that Nadia and Rafi are in and Priya is not: the answer may not read it
    const secret = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads-only', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: rafi.personId }));
  });

  it('is answered in the thread and as a caption naming the asker, from the channels everyone present may read', async () => {
    const before = answerRuns().length;
    expect(await speak(room.id, rafi, 'Hey Note-taker, what did we decide about the release?')).toBe(true);
    const line = await eventually(async () => (await botLines(room.id)).find((m) => m.body.includes('We ship on Thursday')), 60_000, 'the answer in the thread');
    expect(line.body).toContain('Rafi asked');
    expect(line.body).toContain('What did we decide about the release date?');
    expect(answerRuns().length).toBe(before + 1);

    // the run was offered the channels all three people can read, and not the one Priya cannot
    const offered = answerRuns().at(-1)!.prompt!;
    expect(offered).toContain('#general');
    expect(offered).not.toContain('#leads-only');
    // the fast check saw only what people who said yes said in the minute before
    expect(checks.at(-1)).toContain('Rafi: Hey Note-taker, what did we decide about the release?');

    await eventually(async () => (captionsOf(room.id).length > 0 ? true : undefined), 10_000, 'the answer caption');
    const caption = captionsOf(room.id).at(-1)!;
    expect(caption).toMatchObject({ kind: 'answer', askerName: 'Rafi', speakerName: 'Note-taker', final: true });
    expect(caption.text).toContain('We ship on Thursday');
  });

  it('does not answer a line that only talks about the note-taker', async () => {
    const runs = answerRuns().length;
    const asked = checks.length;
    const lines = (await botLines(room.id)).length;
    expect(await speak(room.id, nadia, 'The note-taker is a good idea.')).toBe(true);
    await eventually(async () => (checks.length > asked ? true : undefined), 30_000, 'the fast check');
    await new Promise((r) => setTimeout(r, 1500));
    expect(answerRuns().length).toBe(runs);
    expect((await botLines(room.id)).length).toBe(lines);
  });

  it('does not even look at a line that does not name the note-taker', async () => {
    const asked = checks.length;
    expect(await speak(room.id, nadia, 'Who owns the release?')).toBe(true);
    await lineSaid(room.id, 'Who owns the release?');
    await new Promise((r) => setTimeout(r, 1500));
    expect(checks.length).toBe(asked);
  });

  it('never answers a person who said no: nothing of theirs is heard, and a mention in the thread is not taken', async () => {
    const runs = answerRuns().length;
    const asked = checks.length;
    expect(await speak(room.id, priya, 'Note-taker, what is the plan?')).toBe(false);
    const res = await postInThread(priya, room, '@Note-taker what is the plan?');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await new Promise((r) => setTimeout(r, 2500));
    expect(answerRuns().length).toBe(runs);
    expect(checks.length).toBe(asked);
    const queued = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.jobs WHERE queue = 'meetings.question' AND payload->>'askerActorId' = $1", [priya.actorId])).rows.length);
    expect(queued).toBe(0);
  });

  it('takes a mention of the note-taker in the call’s thread the same way', async () => {
    const runs = answerRuns().length;
    const res = await postInThread(rafi, room, '@Note-taker what time do we ship?');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await eventually(async () => (answerRuns().length > runs ? true : undefined), 30_000, 'the answer run');
    const line = await eventually(async () => (await botLines(room.id)).find((m) => m.body.includes('what time do we ship?')), 30_000, 'the answer in the thread');
    expect(line.body).toContain('Rafi asked');
  });

  it('answers one question at a time in a room', async () => {
    const runs = answerRuns().length;
    ok(await postInThread(rafi, room, '@Note-taker SLOW first question'), 201);
    ok(await postInThread(nadia, room, '@Note-taker second question'), 201);
    await eventually(async () => (answerRuns().length >= runs + 2 ? true : undefined), 60_000, 'both answer runs');
    await eventually(async () => (spooled().filter((s) => s.phase === 'end' && s.first === 'Answer a question asked in a meeting.').length >= runs + 2 ? true : undefined), 30_000, 'both to finish');
    const all = spooled().filter((s) => s.first === 'Answer a question asked in a meeting.');
    const starts = all.filter((s) => s.phase === 'start').slice(-2);
    const ends = all.filter((s) => s.phase === 'end').slice(-2);
    // the second started after the first ended
    expect(starts[1]!.at).toBeGreaterThanOrEqual(ends[0]!.at);
  });

  it('answers six questions a minute at most, and says so on the seventh', async () => {
    // fill the minute: whatever this room already used, then up to the limit
    while (questionLimiter.take(room.id, 1, MEETING_QUESTIONS_PER_MINUTE, Date.now()) === null);
    await new Promise((r) => setTimeout(r, 2500)); // the answers of the test before have been posted
    const runs = answerRuns().length;
    const lines = (await botLines(room.id)).length;
    ok(await postInThread(rafi, room, '@Note-taker one more question'), 201);
    await eventually(async () => (captionsOf(room.id).some((c) => c.text.includes('questions a minute')) ? true : undefined), 20_000, 'the limit caption');
    expect(answerRuns().length).toBe(runs);
    expect((await botLines(room.id)).length).toBe(lines);
  });

  it('leaves no question behind when the room ends', async () => {
    ok(await w.call(nadia, 'POST', `/api/meetings/${room.id}/end`));
    await eventually(async () => (lastFakeMedia().listeners.get(room.id) === undefined ? true : undefined), 20_000, 'the listener to leave');
    const runs = answerRuns().length;
    ok(await postInThread(rafi, room, '@Note-taker are you still there?'), 201);
    await new Promise((r) => setTimeout(r, 1500));
    expect(answerRuns().length).toBe(runs);
  });
});

describe('the notes at the end of a call with a note-taker', () => {
  let room: { id: string; threadRootId: string; botId: string };
  const notesRow = (id: string) =>
    w.system(async (tx) => (await tx.query<{ status: string; location: string; notes_path: string | null; notes_md: string; failure: string | null; file_ids: string[] }>('SELECT status, location, notes_path, notes_md, failure, file_ids FROM app.meeting_notes WHERE meeting_id = $1', [id])).rows[0]);
  const dmsOf = async (actorId: string) =>
    w.system(async (tx) =>
      (
        await tx.query<{ body: string; meta: Record<string, unknown> | null; kind: string }>(
          `SELECT m.body, m.meta, a.kind FROM app.messages m JOIN app.actors a ON a.id = m.author_id JOIN app.channels c ON c.id = m.channel_id
            WHERE c.kind = 'bot_conversation' AND c.created_by = $1 ORDER BY m.id`,
          [actorId],
        )
      ).rows,
    );

  it('writes notes.md beside the transcript, tells the organizer, and says in the thread who has the notes, within fifteen seconds of the end', async () => {
    room = await openRoom('dev', 'Planning call');
    expect(await speak(room.id, nadia, 'DECIDE: Ship on Thursday')).toBe(true);
    expect(await speak(room.id, rafi, 'Agreed.')).toBe(true);
    await lineSaid(room.id, 'DECIDE: Ship on Thursday');
    await lineSaid(room.id, 'Agreed.');
    const ended = Date.now();
    ok(await w.call(nadia, 'POST', `/api/meetings/${room.id}/end`));
    const notes = await eventually(async () => {
      const n = await notesRow(room.id);
      return n && n.status !== 'pending' && n.notes_path ? n : undefined;
    }, 60_000, 'the notes');
    expect(Date.now() - ended).toBeLessThan(15_000);
    expect(notes).toMatchObject({ status: 'written', location: 'personal' });
    expect(notes.notes_path).toMatch(/^Meetings\/.+\/notes\.md$/);
    expect(notes.notes_md).toContain('Ship on Thursday');

    // the Personal file is there, and only its owner can open it
    const fileId = notes.file_ids.at(-1)!;
    const open = (who: Who) => fetch(`${w.server.url}/api/files/${fileId}/content`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) } });
    const own = await open(nadia);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('Ship on Thursday');
    expect([403, 404]).toContain((await open(rafi)).status);

    // the message to the organizer carries the meeting, for the Share and Save buttons
    const dm = await eventually(async () => (await dmsOf(nadia.actorId)).find((m) => m.meta && (m.meta as { meetingNotes?: { meetingId?: string } }).meetingNotes?.meetingId === room.id), 15_000, 'the message to the organizer');
    expect(dm.kind).toBe('bot');
    expect(dm.body).toContain('Planning call');
    expect(dm.body).not.toContain('Ship on Thursday');
    // the thread says who has the notes, not what is in them
    const line = await eventually(async () => (await threadOf(room.id)).find((m) => m.body.includes('Notes are with Nadia')), 30_000, 'the thread line');
    expect(line.body).not.toContain('Ship on Thursday');
    // the people it was not shared with cannot open them
    expect((await w.call(rafi, 'GET', `/api/meetings/${room.id}/notes`)).status).toBe(404);
    expect((await w.call(nadia, 'GET', `/api/meetings/${room.id}/notes`)).status).toBe(200);
    const written = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.notes.written' AND payload->>'meetingId' = $1", [room.id])).rows);
    expect(written).toEqual([expect.objectContaining({ payload: expect.objectContaining({ store: 'organizer_files' }) })]);
  });

  it('says in the message that the transcript is there when the notes could not be written', async () => {
    const failing = await openRoom('incidents', 'Broken call');
    expect(await speak(failing.id, nadia, 'CRASH now')).toBe(true);
    await lineSaid(failing.id, 'CRASH now');
    ok(await w.call(nadia, 'POST', `/api/meetings/${failing.id}/end`));
    const n = await eventually(async () => {
      const row = await notesRow(failing.id);
      return row && row.status === 'failed' ? row : undefined;
    }, 60_000, 'the failure');
    expect(n.failure).toBeTruthy();
    const dm = await eventually(async () => (await dmsOf(nadia.actorId)).find((m) => m.meta && (m.meta as { meetingNotes?: { meetingId?: string } }).meetingNotes?.meetingId === failing.id), 30_000, 'the message to the organizer');
    expect(dm.body).toContain('could not be written');
    expect(dm.body).toContain('transcript is saved');
    expect(dm.body).toContain('Meetings/');
    expect((await threadOf(failing.id)).some((m) => m.body.includes('Notes are with'))).toBe(false);
    expect(GetNotesStatus(await w.call(nadia, 'GET', `/api/meetings/${failing.id}/notes`))).toBe('failed');
  });

  it('keeps the Personal place when the note-taker is taken out before the room ends, and still writes the notes at the end', async () => {
    const early = await openRoom('standup', 'Short visit');
    expect(await speak(early.id, nadia, 'DECIDE: Keep it short')).toBe(true);
    await lineSaid(early.id, 'DECIDE: Keep it short');
    ok(await w.call(nadia, 'DELETE', `/api/meetings/${early.id}/notetaker`));
    const mid = await eventually(async () => {
      const row = await notesRow(early.id);
      return row ?? undefined;
    }, 20_000, 'the notes row');
    expect(mid.location).toBe('personal');
    // the notes wait for the end of the room
    await new Promise((r) => setTimeout(r, 2500));
    expect((await notesRow(early.id))?.status).toBe('pending');
    ok(await w.call(nadia, 'POST', `/api/meetings/${early.id}/end`));
    const done = await eventually(async () => {
      const row = await notesRow(early.id);
      return row && row.status === 'written' ? row : undefined;
    }, 60_000, 'the notes after the end');
    expect(done.location).toBe('personal');
    expect(done.notes_md).toContain('Keep it short');
    // the transcript writer did not move the transcript to the team's files
    const moved = await w.system(async (tx) => (await tx.query<{ transcript_path: string | null }>('SELECT transcript_path FROM app.meetings WHERE id = $1', [early.id])).rows[0]!.transcript_path);
    expect(moved).toBeNull();
  });
});

function GetNotesStatus(res: { status: number; body: unknown }): string {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { status: string }).status;
}
