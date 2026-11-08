import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, answerConsent, personas, closePerson, enterRoom, installBots, lastMeeting, mediaState, meetingsStack, openAs, speakToListener, statusOf, threadLines, type Person } from './support.ts';

/**
 * A question put to the note-taker in a call (PLAN P15-17, criterion 14, P15-24). Rafi says "Hey Note-taker, what did we decide about the release?"; a fast model checks the
 * line, the note-taker's run answers from the channels EVERYONE in the call may read, and the answer is posted in the call thread and shown as a caption that names who asked.
 * Priya said no to being written down: nothing she says is heard, and her mention in the thread is not taken as a question. A private channel she is not in is not offered to the run.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const spool = join(mkdtempSync(join(tmpdir(), 'manythreads-question-spool-')), 'hermes.jsonl');
const QUESTION = 'Hey Note-taker, what did we decide about the release?';

let stack: Stack;
let omar: StackApi;
let fast: Server;
const checks: string[] = [];
let nadia: Person | undefined;
let rafi: Person | undefined;
let priya: Person | undefined;
let meetingId = '';

/** The prompts the stand-in model got for answering a question, oldest first. */
const answerPrompts = (): string[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { first?: string; prompt?: string }).filter((s) => s.first === 'Answer a question asked in a meeting.').map((s) => s.prompt ?? '')
    : [];
const botLines = async () => (await threadLines(stack, meetingId)).filter((m) => m.kind === 'bot');

test.beforeAll(async ({ playwright }) => {
  // the fast model of the stack: a line with "?" is a question and its answer is the question said on its own; anything else is "NO"
  fast = createServer((req, res) => {
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
  await new Promise<void>((resolve) => fast.listen(0, '127.0.0.1', resolve));
  const port = (fast.address() as { port: number }).port;
  stack = await meetingsStack('content', { HERMES_FAKE_SPOOL: spool, MANYTHREADS_LITELLM_URL: `http://127.0.0.1:${port}` });
  omar = await apiOn(playwright, stack, 'omar');
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) SELECT id, 'fast', NULL, 'fake/fast', '{}' FROM app.workspaces ON CONFLICT DO NOTHING`);
  await installBots(stack, omar, ['note-taker']);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await closePerson(priya);
  await omar?.ctx.dispose();
  await new Promise((resolve) => (fast ? fast.close(() => resolve(undefined)) : resolve(undefined)));
  await stack?.stop();
});

test('a call with the note-taker: Nadia and Rafi say yes, Priya says no, and a private channel Priya is not in exists', async ({ browser, playwright }) => {
  // #leads-only: Nadia and Rafi are in it, Priya is not
  const made = await omar.ctx.post('/api/teams/engineering/channels', { data: { name: 'leads-only', private: true }, headers: await omar.headers() });
  expect(made.status(), await made.text()).toBe(201);
  const secret = ((await made.json()) as { channel: { id: string } }).channel.id;
  for (const who of ['nadia', 'rafi'] as const) {
    const added = await omar.ctx.post(`/api/channels/${secret}/members`, { data: { personId: personas[who].personId }, headers: await omar.headers() });
    expect(added.status(), await added.text()).toBeLessThan(300);
  }

  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, 'general')).id;
  rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/c/general');
  await enterRoom(rafi);
  priya = await openAs(browser, playwright, stack, 'priya', '/t/engineering/c/general');
  await enterRoom(priya);
  await nadia.page.getByTestId('call-notetaker-btn').click();
  await nadia.page.getByTestId('notetaker-add-note-taker').click();
  await answerConsent(nadia, 'yes');
  await answerConsent(rafi, 'yes');
  await answerConsent(priya, 'no');
  await expect
    .poll(async () => [...((await mediaState(stack, omar, meetingId)).listeners[0]?.subscriptions ?? [])].sort(), { timeout: 20_000, message: 'the listener to follow the answers' })
    .toEqual([actorOf('nadia'), actorOf('rafi')].sort());
});

test('Rafi asks by name: the answer is in the thread and on every screen as a caption naming him', async () => {
  const before = answerPrompts().length;
  await expect.poll(() => speakToListener(stack, omar, meetingId, 'rafi', QUESTION), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await botLines()).find((m) => /ship on thursday/i.test(m.body))?.body, { timeout: 60_000, message: 'the answer in the call thread' }).toBeTruthy();
  const line = (await botLines()).find((m) => /ship on thursday/i.test(m.body))!;
  expect(line.body).toContain('Rafi asked');
  expect(line.body).toContain('What did we decide about the release date?');
  expect(answerPrompts().length).toBe(before + 1);

  // the run was offered the channels all three people may read, and not the private one
  const offered = answerPrompts().at(-1)!;
  expect(offered).toContain('#general');
  expect(offered).not.toContain('#leads-only');
  // the fast check saw what people who said yes said, and no one else
  expect(checks.at(-1)).toContain(`Rafi: ${QUESTION}`);

  // the caption, even with captions switched off, on all three pages
  for (const p of [nadia!, rafi!, priya!]) {
    const caption = p.page.locator('[data-testid="caption-line"][data-kind="answer"]');
    await expect(caption.first(), `${p.key} sees the answer caption`).toBeVisible({ timeout: 20_000 });
    await expect(caption.first()).toContainText('Rafi');
    await expect(caption.first()).toContainText(/ship on thursday/i);
  }
});

test('a line that only talks about the note-taker is checked and not answered; a line that does not name it is not even checked', async () => {
  const runs = answerPrompts().length;
  const asked = checks.length;
  const lines = (await botLines()).length;
  await expect.poll(() => speakToListener(stack, omar, meetingId, 'nadia', 'The note-taker is a good idea.'), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => checks.length, { timeout: 30_000, message: 'the fast check' }).toBeGreaterThan(asked);
  const afterCheck = checks.length;
  await expect.poll(() => speakToListener(stack, omar, meetingId, 'nadia', 'Who owns the release?'), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await nadia!.api.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript`)).lines.map((l) => l.text), { timeout: 20_000 }).toContain('Who owns the release?');
  // give the scan its time, then show that nothing was asked of the model
  await expect.poll(async () => (await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.jobs WHERE queue = 'meetings.question' AND state IN ('ready', 'running')`))[0]!.n, { timeout: 15_000 }).toBe('0');
  expect(checks.length).toBe(afterCheck);
  expect(answerPrompts().length).toBe(runs);
  expect((await botLines()).length).toBe(lines);
});

test('Priya, who said no, is never heard and never answered, in the call or in the thread', async () => {
  const runs = answerPrompts().length;
  const asked = checks.length;
  expect(await speakToListener(stack, omar, meetingId, 'priya', 'Note-taker, what is the plan?')).toBe(false);
  const thread = (await lastMeeting(stack, 'general')).thread_root_id!;
  const channel = (await stack.sql<{ channel_id: string }>('SELECT channel_id FROM app.meetings WHERE id = $1', [meetingId]))[0]!.channel_id;
  expect(await statusOf(priya!.api, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, body: '@Note-taker what is the plan?', threadRootId: thread })).toBe(201);
  await expect.poll(async () => (await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages WHERE thread_root_id = $1`, [thread]))[0]!.n).not.toBe('0');
  // a negative: give a wrongly queued question the time it would need to be taken, then show nothing was
  await priya!.page.waitForTimeout(2_500);
  expect((await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.jobs WHERE queue = 'meetings.question' AND payload->>'askerActorId' = $1`, [actorOf('priya')]))[0]!.n).toBe('0');
  expect(answerPrompts().length).toBe(runs);
  expect(checks.length).toBe(asked);
  expect((await botLines()).some((m) => /plan/i.test(m.body) && m.body.includes('Priya'))).toBe(false);
});
