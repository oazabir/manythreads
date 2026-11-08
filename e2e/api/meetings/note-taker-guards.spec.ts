import { MEETING_BOT_FILES, personas, type Persona } from '@manythreads/test-utils';
import type { APIRequestContext } from '@playwright/test';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import type { Stack } from '../../fixtures/stack.ts';

// Writes data (rooms, answers): its own server and database for this file, seeded with the meetings of seed v15 (a stand-up in #dev, a private leads sync in #eng-leads).
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'meetings' });
test.describe.configure({ mode: 'serial' });

/**
 * The note-taker's guards at the API (PLAN P15-24, criteria 11 and 12): the bot never holds a media token of its own and cannot ask for one; the room's listener hears only the
 * people who said yes, and follows a changed answer; and an answer that would need something not everybody in the call may read is thrown away, not posted.
 */
const { omar, nadia, rafi, priya } = personas;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });
const asBot = (actorId: string): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: omar.workspaceId }) });

let meetingId = '';
let threadRootId = '';
let channel = '';
let botId = '';
let botActor = '';

async function channelId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get('/api/teams/engineering/channels', { headers: as(nadia) });
  const dir = (await res.json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> };
  const id = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === name)?.id;
  expect(id, `channel #${name}`).toBeDefined();
  return id!;
}

interface MediaState {
  tokens: Array<{ identity: string; kind: 'person' | 'bot'; canPublish: boolean; canSubscribe: boolean; listenOnly: boolean }>;
  published: string[];
  listeners: Array<{ identity: string; subscriptions: string[] }>;
}
const media = async (request: APIRequestContext, stack: Stack): Promise<MediaState> => {
  const res = await request.get(`/api/test/media/state?meetingId=${meetingId}`, { headers: { ...as(nadia), 'x-test-auth': stack.testAuthToken } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as MediaState;
};
const heard = async (request: APIRequestContext, stack: Stack): Promise<string[]> => [...((await media(request, stack)).listeners[0]?.subscriptions ?? [])].sort();
const consent = async (request: APIRequestContext, who: Persona, answer: 'yes' | 'no') => {
  const res = await request.post(`/api/meetings/${meetingId}/consent`, { headers: as(who), data: { transcribe: answer } });
  expect(res.status(), await res.text()).toBe(200);
};
const botLines = (stack: Stack) =>
  stack.sql<{ body: string }>(
    `SELECT m.body FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE m.thread_root_id = $1 AND m.id <> $1 AND a.kind = 'bot' ORDER BY m.id`,
    [threadRootId],
  );
const questionRuns = (stack: Stack) => stack.sql<{ status: string }>(`SELECT status FROM app.bot_runs WHERE trigger_type = 'meeting_question' ORDER BY started_at, id`);

test('a call with the note-taker: Nadia and Rafi say yes, Priya says no', async ({ request }) => {
  const stack = await iso.start();
  const note = MEETING_BOT_FILES.find((b) => b.slug === 'note-taker')!;
  expect(note).toBeDefined();
  botId = (await stack.sql<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'note-taker' AND status = 'active'`))[0]!.id;
  botActor = (await stack.sql<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId]))[0]!.id;
  channel = await channelId(request, 'general');

  const start = await request.post(`/api/channels/${channel}/meetings`, { headers: as(nadia), data: { title: 'Guards check' } });
  expect(start.status(), await start.text()).toBe(200);
  const started = (await start.json()) as { meeting: { id: string; threadRootId: string } };
  meetingId = started.meeting.id;
  threadRootId = started.meeting.threadRootId;
  for (const who of [rafi, priya]) expect((await request.post(`/api/meetings/${meetingId}/join`, { headers: as(who) })).status()).toBe(200);
  const add = await request.put(`/api/meetings/${meetingId}/notetaker`, { headers: as(nadia), data: { botId } });
  expect(add.status(), await add.text()).toBe(200);
  await expect.poll(async () => (await media(request, stack)).listeners.length, { timeout: 30_000, message: 'the note-taker to join the room' }).toBe(1);
  await consent(request, nadia, 'yes');
  await consent(request, rafi, 'yes');
  await consent(request, priya, 'no');
});

test('the bot cannot get a media token or take any part in the room on its own; its listener only listens', async ({ request }) => {
  const stack = await iso.start();
  for (const [method, path, data] of [
    ['POST', `/api/meetings/${meetingId}/token`, undefined],
    ['POST', `/api/meetings/${meetingId}/join`, undefined],
    ['POST', `/api/meetings/${meetingId}/consent`, { transcribe: 'yes' }],
    ['PUT', `/api/meetings/${meetingId}/notetaker`, { botId }],
    ['DELETE', `/api/meetings/${meetingId}/notetaker`, undefined],
    ['POST', `/api/channels/${channel}/meetings`, {}],
  ] as const) {
    const res = await request.fetch(path, { method, headers: asBot(botActor), ...(data === undefined ? {} : { data }) });
    expect(res.status(), `${method} ${path} as the bot`).toBe(403);
  }
  const state = await media(request, stack);
  // its own listener has a token the platform made: it cannot publish and can only listen; nobody published anything
  const botTokens = state.tokens.filter((t) => t.kind === 'bot');
  expect(botTokens).toHaveLength(1);
  expect(botTokens[0]).toMatchObject({ canPublish: false, listenOnly: true });
  expect(state.published).toEqual([]);
  // the people each hold a token for themselves only
  expect(state.tokens.filter((t) => t.kind === 'person').map((t) => t.identity).sort()).toEqual([nadia.actorId, rafi.actorId, priya.actorId].sort());
  // the room is still there and the note-taker still in it: the refusals changed nothing
  const current = (await (await request.get(`/api/meetings/${meetingId}/notetakers`, { headers: as(nadia) })).json()) as { current: { bot: { slug: string } } | null };
  expect(current.current?.bot.slug).toBe('note-taker');
});

test('a declined track is unsubscribed, and a changed answer is followed', async ({ request }) => {
  const stack = await iso.start();
  await expect.poll(() => heard(request, stack), { timeout: 20_000, message: 'only the two who said yes' }).toEqual([nadia.actorId, rafi.actorId].sort());
  // Rafi changes his mind: the listener stops hearing him
  await consent(request, rafi, 'no');
  await expect.poll(() => heard(request, stack), { timeout: 20_000 }).toEqual([nadia.actorId]);
  const probe = async (who: Persona) => {
    const res = await request.post('/api/test/media/speak', { headers: { ...as(omar), 'x-test-auth': stack.testAuthToken }, data: { meetingId, actorId: who.actorId, text: 'a probe', durationMs: 1000 } });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { delivered: boolean }).delivered;
  };
  expect(await probe(rafi)).toBe(false);
  expect(await probe(priya)).toBe(false);
  expect(await probe(nadia)).toBe(true);
  // Priya says yes: now she is heard
  await consent(request, priya, 'yes');
  await expect.poll(() => heard(request, stack), { timeout: 20_000 }).toEqual([nadia.actorId, priya.actorId].sort());
  expect(await probe(priya)).toBe(true);
  // and a person who leaves is no longer heard
  expect((await request.post(`/api/meetings/${meetingId}/leave`, { headers: as(priya) })).status()).toBe(200);
  await expect.poll(() => heard(request, stack), { timeout: 20_000 }).toEqual([nadia.actorId]);
  // Priya comes back with a no, so the rest of the checks have the same room as the first test
  expect((await request.post(`/api/meetings/${meetingId}/join`, { headers: as(priya) })).status()).toBe(200);
  await consent(request, priya, 'no');
  await consent(request, rafi, 'yes');
  await expect.poll(() => heard(request, stack), { timeout: 20_000 }).toEqual([nadia.actorId, rafi.actorId].sort());
});

test('a question that needs a channel not everybody in the call may read is not answered; one that stays inside is', async ({ request }) => {
  const stack = await iso.start();
  const ask = async (text: string) => {
    const res = await request.post(`/api/channels/${channel}/messages`, { headers: as(nadia), data: { channelId: channel, body: text, threadRootId } });
    expect(res.status(), await res.text()).toBe(201);
  };

  // inside: the stand-up is in #dev, which Priya reads too
  const before = (await questionRuns(stack)).length;
  await ask('@Note-taker SEARCH-MEETINGS rollback note? what did the stand-up say');
  await expect.poll(async () => (await botLines(stack)).some((l) => /ship on thursday/i.test(l.body)), { timeout: 90_000, message: 'the answer from what everyone may read' }).toBe(true);
  expect((await questionRuns(stack)).slice(before).map((r) => r.status)).toEqual(['done']);

  // outside: the leads sync is in #eng-leads, which Nadia reads and Priya and Rafi do not
  const runs = (await questionRuns(stack)).length;
  const lines = (await botLines(stack)).length;
  await ask('@Note-taker SEARCH-MEETINGS hiring plan? what did the leads decide');
  await expect.poll(async () => (await questionRuns(stack)).length, { timeout: 90_000, message: 'the second run' }).toBe(runs + 1);
  await expect.poll(async () => (await questionRuns(stack)).at(-1)?.status, { timeout: 60_000, message: 'the run to be closed' }).toBe('failed');
  // nothing was posted from it, and the run's own log says what it read
  expect((await botLines(stack)).length).toBe(lines);
  const read = await stack.sql<{ source_type: string }>(`SELECT l.source_type FROM app.run_source_log l JOIN app.bot_runs r ON r.id = l.run_id WHERE r.trigger_type = 'meeting_question' ORDER BY r.started_at DESC, l.seq DESC LIMIT 5`);
  expect(read.some((l) => l.source_type === 'meeting')).toBe(true);
});
