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
const questionRuns = (stack: Stack) => stack.sql<{ id: string; status: string }>(`SELECT id, status FROM app.bot_runs WHERE trigger_type = 'meeting_question' ORDER BY started_at, id`);
/** The tools a run called through the gateway's door (one `run_decisions` line each) and the sources it read (`run_source_log`). */
const toolsOf = async (stack: Stack, runId: string): Promise<string[]> =>
  (await stack.sql<{ subject: string }>(`SELECT subject FROM app.run_decisions WHERE run_id = $1 AND kind = 'tool' ORDER BY seq`, [runId])).map((r) => r.subject);
const sourcesOf = (stack: Stack, runId: string) => stack.sql<{ source_type: string; source_ref: string }>(`SELECT source_type, source_ref FROM app.run_source_log WHERE run_id = $1 ORDER BY seq`, [runId]);

test('a call with the note-taker: Nadia and Rafi say yes, Priya says no', async ({ request }) => {
  const stack = await iso.start();
  const note = MEETING_BOT_FILES.find((b) => b.slug === 'note-taker')!;
  expect(note).toBeDefined();
  botId = (await stack.sql<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'note-taker' AND status = 'active'`))[0]!.id;
  botActor = (await stack.sql<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId]))[0]!.id;
  // the call is in #dev, where the seeded stand-up was held: since P17-06 a run in a call is only shown hits of the call's own channel, so a question about the stand-up
  // is "inside" only for a call in #dev (in #general the stand-up is outside the room and its hits are held back, P38-08)
  channel = await channelId(request, 'dev');

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
  // the run's own log says what it read: the stand-up (a meeting of #dev, the call's channel), and the search was made through the door (one `meetings.search` line)
  const insideRun = (await questionRuns(stack)).at(-1)!;
  expect(await toolsOf(stack, insideRun.id), 'tools of the inside run').toContain('meetings.search');
  const insideRows = await sourcesOf(stack, insideRun.id);
  expect(insideRows.map((l) => l.source_type), 'sources of the inside run').toContain('meeting');
  const standup = await stack.sql<{ id: string }>(`SELECT id FROM app.meetings WHERE title = 'Engineering stand-up'`);
  const meetingRefs = insideRows.filter((l) => l.source_type === 'meeting').map((l) => l.source_ref);
  expect(meetingRefs).toContain(standup[0]!.id);
  // and every meeting it read is one of the call's own channel (#dev)
  const readIn = await stack.sql<{ channel_id: string }>(`SELECT channel_id FROM app.meetings WHERE id = ANY ($1::uuid[])`, [meetingRefs]);
  expect(readIn.every((m) => m.channel_id === channel)).toBe(true);

  // outside: the leads sync is in #eng-leads, which Nadia reads and Priya and Rafi do not
  const runs = (await questionRuns(stack)).length;
  await ask('@Note-taker SEARCH-MEETINGS hiring plan? what did the leads decide');
  await expect.poll(async () => (await questionRuns(stack)).length, { timeout: 90_000, message: 'the second run' }).toBe(runs + 1);
  // since P17-06 the run's searches are held to the call's own channel BEFORE they read: the search is made, finds the leads sync, and the door drops the hit before the model or
  // the log sees it. The run closes as done (the model says it found nothing) and nothing the leads said (the autumn hiring plan of seed v15) is posted anywhere
  await expect.poll(async () => (await questionRuns(stack)).at(-1)?.status, { timeout: 60_000, message: 'the run to be closed' }).toMatch(/^(done|failed)$/);
  expect((await botLines(stack)).some((l) => /autumn/i.test(l.body))).toBe(false);
  const leaked = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages WHERE body ILIKE '%hiring plan for the autumn%'`);
  expect(leaked[0]?.n).toBe('0');
  // the outside run did search (so an empty log is the hold's doing, not a search that never ran), and its log has no meeting at all
  const outsideRun = (await questionRuns(stack)).at(-1)!;
  expect(await toolsOf(stack, outsideRun.id), 'tools of the outside run').toContain('meetings.search');
  expect((await sourcesOf(stack, outsideRun.id)).map((l) => l.source_type), 'sources of the outside run').not.toContain('meeting');
  expect((await botLines(stack)).at(-1)?.body ?? '', 'what the model said when the room had nothing').toMatch(/found nothing/i);
});
