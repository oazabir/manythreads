import { enqueue } from '@manythreads/kernel';
import {
  ChannelMessage,
  ClosePollResponse,
  ListMessagesResponse,
  PollChangedPush,
  PollResultsResponse,
  VotePollResponse,
  pollBodyText,
  type PollView,
} from '@manythreads/shared';
import { ownerSql } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { createWorld, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { lena, priya, sameera } = personas;

// P14-07: polls through the HTTP routes, the minute close job and the realtime push. DB-backed, so it runs on the devbox when no CI run shares the
// database. The server clock (`ctx.runtime.now`) is moved by `skewMs` so a poll can come due without waiting. The row-level security of ballots has
// its own file (rls/polls.test.ts); the DB-free decisions of the job are in poll-job.test.ts.

const { omar, nadia, rafi, tariq } = personas;
const MINUTE = 60_000;

let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const at = (minutes: number): string => new Date(Date.now() + minutes * MINUTE).toISOString();

let w: World;
let dev = '';
/** A public channel of Engineering that six people can read (the four of the team, and Lena and Sameera by a grant): enough for an anonymous poll. */
let room = '';
/** The channel each poll was asked in, so the helpers below need no channel argument. */
const home = new Map<string, string>();
const homeOf = (pollId: string): string => home.get(pollId) ?? dev;
beforeAll(async () => {
  w = await createWorld({ now: clock, limiter: relaxedRateLimiter() }); // many polls in a minute: the file is not about limits
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  await w.call(nadia, 'POST', `/api/channels/${dev}/join`);
  await w.call(rafi, 'POST', `/api/channels/${dev}/join`);
  room = (ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-room' }), 201)).channel.id;
  for (const who of [lena, sameera]) await grantRead(room, who);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

function ok<T>(res: ApiResult<T>, status = 200): T {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
const grantRead = (channelId: string, who: Persona): Promise<void> =>
  w.system(async (tx) => {
    await tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`,
      [who.workspaceId, channelId, who.personId],
    );
  });
const create = (who: Persona, body: Record<string, unknown>, channelId = dev) => w.call<ChannelMessage>(who, 'POST', `/api/channels/${channelId}/polls`, body);
const make = async (who: Persona, body: Record<string, unknown>, channelId = dev): Promise<{ message: ChannelMessage; poll: PollView }> => {
  const message = ChannelMessage.parse(ok(await create(who, { question: 'Lunch?', options: ['Pizza', 'Sushi', 'Soup'], ...body }, channelId), 201));
  home.set(message.poll!.id, channelId);
  return { message, poll: message.poll! };
};
const vote = (who: Persona, pollId: string, options: number[]) => w.call<VotePollResponse>(who, 'PUT', `/api/channels/${homeOf(pollId)}/polls/${pollId}/vote`, { options });
const withdraw = (who: Persona, pollId: string) => w.call<VotePollResponse>(who, 'DELETE', `/api/channels/${homeOf(pollId)}/polls/${pollId}/vote`);
const close = (who: Persona, pollId: string) => w.call<ClosePollResponse>(who, 'POST', `/api/channels/${homeOf(pollId)}/polls/${pollId}/close`);
const results = (who: Persona, pollId: string) => w.call<PollResultsResponse>(who, 'GET', `/api/channels/${homeOf(pollId)}/polls/${pollId}`);
const feed = async (who: Persona, channelId = dev): Promise<ChannelMessage[]> => ListMessagesResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/messages?limit=100`))).items;
const metaOf = (messageId: string): Promise<Record<string, unknown>> =>
  w.system(async (tx) => (await tx.query<{ meta: Record<string, unknown> }>('SELECT meta FROM app.messages WHERE id = $1', [messageId])).rows[0]!.meta);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Runs the close job with the server clock moved ahead, so polls that close within `minutes` come due. */
const runCloseJobAhead = async (minutes: number): Promise<void> => {
  skewMs = minutes * MINUTE;
  try {
    await runCloseJob();
  } finally {
    skewMs = 0;
  }
};
const counts = (p: PollView): number[] => p.options.map((o) => o.votes);
const eventsOf = (type: string, pollId: string): Promise<Array<Record<string, unknown>>> =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND payload->>'pollId' = $2 ORDER BY id`, [type, pollId])).rows.map((r) => r.payload));
/** Runs the close job once and waits for it. */
const runCloseJob = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'channels.close_polls', {})).id);
  await eventually(
    async () => {
      const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
      expect(row.last_error).toBeNull();
      return row.state === 'done' ? true : undefined;
    },
    20_000,
    'the close job',
  );
};

describe('asking a poll', () => {
  it('201 with a message of the channel that carries the poll; the text is plain for search and for bots; the others read it with no vote of their own', async () => {
    const { message, poll } = await make(nadia, { multiple: false, anonymous: false });
    expect(message).toMatchObject({ channelId: dev, authorId: nadia.actorId, body: pollBodyText({ question: 'Lunch?', options: ['Pizza', 'Sushi', 'Soup'], multiple: false, anonymous: false, closesAt: null }) });
    expect(poll).toMatchObject({ question: 'Lunch?', closed: false, voters: 0, mine: [], anonymous: false, multiple: false, closesAt: null });
    expect(counts(poll)).toEqual([0, 0, 0]);
    const seen = (await feed(rafi)).find((m) => m.id === message.id)!;
    expect(seen.poll).toMatchObject({ id: poll.id, mine: [] });
    const [created] = await eventsOf('channel.poll.created', poll.id);
    expect(created).toMatchObject({ optionCount: 3, anonymous: false, authorId: nadia.actorId });
    expect(JSON.stringify(created)).not.toContain('Lunch');
  });

  it('refuses a bad poll: too few or too many options, two the same, an empty or long question, a time in the past or far away, an unknown field', async () => {
    const bad = async (over: Record<string, unknown>): Promise<number> => (await create(nadia, { question: 'Q', options: ['A', 'B'], ...over })).status;
    expect(await bad({ options: ['A'] })).toBe(400);
    expect(await bad({ options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toBe(400);
    expect(await bad({ options: ['A', 'a'] })).toBe(400);
    expect(await bad({ question: '  ' })).toBe(400);
    expect(await bad({ question: 'q'.repeat(301) })).toBe(400);
    expect(await bad({ options: ['A', 'x'.repeat(101)] })).toBe(400);
    expect(await bad({ closesAt: at(-60) })).toBe(400);
    expect(await bad({ closesAt: at(0.5) })).toBe(400); // less than a minute away
    expect(await bad({ options: ['Pizza  slice', 'pizza slice'] })).toBe(400); // the same once spaces and capitals are ignored
    expect(await bad({ closesAt: at(60 * 24 * 400) })).toBe(400);
    expect(await bad({ voters: 5 })).toBe(400);
  });

  it('only someone who can post in the channel may ask one', async () => {
    expect([403, 404]).toContain((await create(tariq, { question: 'Q', options: ['A', 'B'] })).status);
  });

  it('can be a reply in a thread', async () => {
    const root = ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a thread', threadRootId: null }), 201);
    const { message } = await make(rafi, { threadRootId: root.id });
    expect(message.threadRootId).toBe(root.id);
  });

  it('a poll cannot be edited, but its author can delete it', async () => {
    const { message } = await make(nadia, {});
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${message.id}`, { body: 'new text' })).status).toBe(409);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${message.id}`));
    expect((await feed(rafi)).find((m) => m.id === message.id)?.poll).toBeUndefined();
  });
});

describe('voting in a named poll', () => {
  it('one choice per person: a vote counts, a changed vote moves, a withdrawn vote goes; each answer shows only the caller’s own vote', async () => {
    const { poll } = await make(nadia, {});
    const first = ok(await vote(rafi, poll.id, [1])).poll;
    expect(first).toMatchObject({ mine: [1], voters: 1 });
    expect(counts(first)).toEqual([0, 1, 0]);
    const second = ok(await vote(nadia, poll.id, [0])).poll;
    expect(counts(second)).toEqual([1, 1, 0]);
    expect(second.mine).toEqual([0]);
    // changed
    const moved = ok(await vote(rafi, poll.id, [2])).poll;
    expect(counts(moved)).toEqual([1, 0, 1]);
    expect(moved.voters).toBe(2);
    // the feed shows each reader their own vote
    const items = await feed(omar);
    expect(items.find((m) => m.poll?.id === poll.id)?.poll).toMatchObject({ mine: [], voters: 2 });
    expect((await feed(rafi)).find((m) => m.poll?.id === poll.id)?.poll?.mine).toEqual([2]);
    // withdrawn
    const gone = ok(await withdraw(rafi, poll.id)).poll;
    expect(gone).toMatchObject({ mine: [], voters: 1 });
    expect(counts(gone)).toEqual([1, 0, 0]);
    // withdrawing again changes nothing
    expect(counts(ok(await withdraw(rafi, poll.id)).poll)).toEqual([1, 0, 0]);
  });

  it('a single-choice poll refuses two choices and an option that does not exist; a several-choice poll counts each chosen option once', async () => {
    const single = (await make(nadia, {})).poll;
    expect((await vote(rafi, single.id, [0, 1])).status).toBe(400);
    expect((await vote(rafi, single.id, [3])).status).toBe(400);
    expect((await vote(rafi, single.id, [])).status).toBe(400);
    const multi = (await make(nadia, { multiple: true })).poll;
    const voted = ok(await vote(rafi, multi.id, [0, 2])).poll;
    expect(counts(voted)).toEqual([1, 0, 1]);
    expect(voted.voters).toBe(1);
    expect(counts(ok(await vote(nadia, multi.id, [2])).poll)).toEqual([1, 0, 2]);
  });

  it('the voters of a named poll are listed with what they chose, for anyone who reads the channel', async () => {
    const { poll } = await make(nadia, {});
    await vote(rafi, poll.id, [1]);
    await vote(omar, poll.id, [0]);
    const listed = PollResultsResponse.parse(ok(await results(nadia, poll.id)));
    expect(listed.voters).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: rafi.actorId, displayName: rafi.name, options: [1] }),
      expect.objectContaining({ actorId: omar.actorId, displayName: omar.name, options: [0] }),
    ]));
    expect(listed.poll.voters).toBe(2);
    const voted = await eventsOf('channel.poll.voted', poll.id);
    expect(voted).toHaveLength(2);
    expect(voted[0]).toMatchObject({ voterId: rafi.actorId, anonymous: false, options: [1] });
  });

  it('someone outside the channel can neither vote nor read the results', async () => {
    const { poll } = await make(nadia, {});
    expect([403, 404]).toContain((await w.call(tariq, 'PUT', `/api/channels/${dev}/polls/${poll.id}/vote`, { options: [0] })).status);
    expect([403, 404]).toContain((await w.call(tariq, 'GET', `/api/channels/${dev}/polls/${poll.id}`)).status);
  });
});

describe('an anonymous poll', () => {
  it('needs a channel that at least five people can read, and is refused in a direct message; the sentence says why', async () => {
    const small = await create(nadia, { question: 'Q', options: ['A', 'B'], anonymous: true }); // dev: four readers
    expect(small.status).toBe(400);
    expect(JSON.stringify(small.body)).toContain('5 people');
    // a direct message between two people is one conversation: an earlier test may have opened it (200), or this one does (201)
    const opened = await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect([200, 201]).toContain(opened.status);
    const dm = opened.body.dm.channel.id;
    expect(JSON.stringify(small.body)).not.toContain('direct message');
    const inDm = await create(nadia, { question: 'Q', options: ['A', 'B'], anonymous: true }, dm);
    expect(inDm.status).toBe(400);
    expect(JSON.stringify(inDm.body)).toContain('A direct message is too small for an anonymous poll');
    expect((await create(nadia, { question: 'Q', options: ['A', 'B'], anonymous: false }, dm)).status).toBe(201); // a named poll is fine there
    ok(await create(nadia, { question: 'Q', options: ['A', 'B'], anonymous: true }, room), 201);
  });

  it('shows the counts to everyone and who voted for what to no one: not the author, not an admin; and writes no vote event', async () => {
    const { poll } = await make(nadia, { anonymous: true }, room);
    const mine = ok(await vote(rafi, poll.id, [2])).poll;
    expect(mine).toMatchObject({ anonymous: true, mine: [2], voters: 1 });
    ok(await vote(omar, poll.id, [2]));
    expect(counts(ok(await vote(nadia, poll.id, [0])).poll)).toEqual([1, 0, 2]);
    for (const who of [nadia, omar, rafi]) {
      const res = PollResultsResponse.parse(ok(await results(who, poll.id)));
      expect(res.voters, who.key).toBeNull();
      expect(counts(res.poll)).toEqual([1, 0, 2]);
    }
    // the event log would name the voter and the time: there is no vote event for an anonymous poll, and created/closed events carry no choices
    expect(await eventsOf('channel.poll.voted', poll.id)).toEqual([]);
    expect(await eventsOf('channel.poll.created', poll.id)).toHaveLength(1);
    // nothing readable by the system role either
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.poll_votes WHERE poll_id = $1', [poll.id])).rows.length)).toBe(0);
    // a voter changes their own vote and withdraws it
    expect(counts(ok(await vote(rafi, poll.id, [1])).poll)).toEqual([1, 1, 1]);
    expect(counts(ok(await withdraw(rafi, poll.id)).poll)).toEqual([1, 0, 1]);
    expect(await eventsOf('channel.poll.voted', poll.id)).toEqual([]);
  });

  it('the result message of an anonymous poll holds the counts and no voter', async () => {
    const { poll } = await make(nadia, { anonymous: true }, room);
    await vote(rafi, poll.id, [0]);
    const closed = ok(await close(nadia, poll.id)).poll;
    const result = (await feed(omar, room)).find((m) => m.id === closed.resultMessageId);
    expect(result?.body).toContain('1 person voted (anonymous poll).');
    expect(result?.body).not.toContain(rafi.name);
  });
});

describe('closing a poll', () => {
  it('its author closes it early (a lead or an admin may too, see below); the result is a plain message from the author that a bot can read; closing again changes nothing', async () => {
    const { poll } = await make(nadia, {});
    await vote(rafi, poll.id, [0]);
    await vote(omar, poll.id, [0]);
    await vote(nadia, poll.id, [2]);
    expect((await close(rafi, poll.id)).status).toBe(403);
    const closed = ok(await close(nadia, poll.id)).poll;
    expect(closed).toMatchObject({ closed: true, voters: 3 });
    expect(closed.resultMessageId).not.toBeNull();
    const result = (await feed(rafi)).find((m) => m.id === closed.resultMessageId)!;
    expect(result.authorId).toBe(nadia.actorId);
    expect(result.poll).toBeUndefined();
    expect(result.body).toBe('Poll closed early: Lunch?\nPizza: 2 votes (67%)\nSushi: 0 votes (0%)\nSoup: 1 vote (33%)\n3 people voted.');
    expect(result.bodyPlain).toContain('Pizza: 2 votes');
    // again: the same poll, no second result
    expect(ok(await close(nadia, poll.id)).poll.resultMessageId).toBe(closed.resultMessageId);
    expect((await feed(rafi)).filter((m) => m.body === result.body)).toHaveLength(1);
    expect(ok(await results(rafi, poll.id)).poll.resultMessageId).toBe(closed.resultMessageId);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    expect(event).toMatchObject({ reason: 'author', closedBy: nadia.actorId, voters: 3, resultMessageId: closed.resultMessageId });
  });

  it('a closed poll takes no new vote, no changed vote and no withdrawal; everyone still sees the closed card', async () => {
    const { poll } = await make(nadia, {});
    await vote(rafi, poll.id, [1]);
    ok(await close(nadia, poll.id));
    for (const attempt of [vote(omar, poll.id, [0]), vote(rafi, poll.id, [0]), withdraw(rafi, poll.id)]) expect((await attempt).status).toBe(409);
    expect((await feed(omar)).find((m) => m.poll?.id === poll.id)?.poll).toMatchObject({ closed: true, voters: 1 });
  });
});

describe('closing at the time', () => {
  it('the minute job closes a poll whose time has come and posts the result as its author; a poll whose time has not come stays open', async () => {
    const due = (await make(nadia, { closesAt: at(5) })).poll;
    const later = (await make(nadia, { closesAt: at(600) })).poll;
    await vote(rafi, due.id, [1]);
    await vote(omar, due.id, [1]);
    await vote(rafi, later.id, [0]);
    skewMs = 10 * MINUTE;
    try {
      await runCloseJob();
    } finally {
      skewMs = 0;
    }
    const closed = (await feed(rafi)).find((m) => m.poll?.id === due.id)!.poll!;
    expect(closed).toMatchObject({ closed: true, voters: 2 });
    expect(closed.resultMessageId).not.toBeNull();
    const result = (await feed(rafi)).find((m) => m.id === closed.resultMessageId)!;
    expect(result.authorId).toBe(nadia.actorId);
    expect(result.body).toBe('Poll closed: Lunch?\nPizza: 0 votes (0%)\nSushi: 2 votes (100%)\nSoup: 0 votes (0%)\n2 people voted.');
    expect((await feed(rafi)).find((m) => m.poll?.id === later.id)?.poll).toMatchObject({ closed: false });
    expect(ok(await vote(omar, later.id, [1])).poll.closed).toBe(false);
    const [event] = await eventsOf('channel.poll.closed', due.id);
    expect(event).toMatchObject({ reason: 'time', closedBy: null });
    // running it again closes nothing twice
    skewMs = 10 * MINUTE;
    try {
      await runCloseJob();
    } finally {
      skewMs = 0;
    }
    expect(await eventsOf('channel.poll.closed', due.id)).toHaveLength(1);
  });

  it('after its time no vote is accepted even before the job has recorded the closing', async () => {
    const { poll } = await make(nadia, { closesAt: at(30) });
    await vote(rafi, poll.id, [0]);
    // the closing time passes without the job having run: the owner moves it into the past, with triggers off for this one statement
    await ownerSql(w.server.db.ownerUrl, `BEGIN; SET LOCAL session_replication_role = replica; UPDATE app.polls SET closes_at = now() - interval '1 minute' WHERE id = '${poll.id}'; COMMIT;`);
    expect((await vote(omar, poll.id, [1])).status).toBe(409);
    expect((await withdraw(rafi, poll.id)).status).toBe(409);
    expect((await feed(omar)).find((m) => m.poll?.id === poll.id)?.poll).toMatchObject({ closed: true });
  });
});

describe('counts update live', () => {
  it('a vote is pushed to everyone who reads the channel as totals only: no voter, no choice of the reader', async () => {
    const { poll } = await make(nadia, { anonymous: true }, room);
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const header = JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId });
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header } } as never);
    ws.onmessage = (e) => void frames.push(JSON.parse(String(e.data)) as { type: string; payload: Record<string, unknown> });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket failed to open'));
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      ok(await vote(rafi, poll.id, [1]));
      // an anonymous poll's totals are not pushed at the moment of a vote (a page would see whose it was); two votes in a row become one push
      await sleep(1_500);
      expect(frames.some((f) => f.type === 'poll.changed' && f.payload['pollId'] === poll.id)).toBe(false);
      ok(await vote(nadia, poll.id, [1]));
      const push = await eventually(async () => frames.find((f) => f.type === 'poll.changed' && f.payload['pollId'] === poll.id), 10_000, 'the poll.changed push');
      const parsed = PollChangedPush.parse(push.payload);
      expect(parsed).toMatchObject({ votes: [0, 2, 0], voters: 2, closed: false });
      expect(frames.filter((f) => f.type === 'poll.changed' && f.payload['pollId'] === poll.id)).toHaveLength(1);
      expect(Object.keys(push.payload).sort()).toEqual(['channelId', 'closed', 'closedAt', 'messageId', 'pollId', 'resultMessageId', 'version', 'voters', 'votes']);
      expect(JSON.stringify(push.payload)).not.toContain(rafi.actorId);
    } finally {
      ws.close();
    }
  });
});

describe('a poll whose message was deleted', () => {
  it('shows no card, serves no results, takes no vote or withdrawal, and can still be closed (without a result message)', async () => {
    const { message, poll } = await make(nadia, {});
    await vote(rafi, poll.id, [0]);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${message.id}`));
    expect((await results(omar, poll.id)).status).toBe(404);
    expect((await vote(omar, poll.id, [1])).status).toBe(409);
    expect((await withdraw(rafi, poll.id)).status).toBe(409);
    const closed = ok(await close(nadia, poll.id)).poll;
    expect(closed).toMatchObject({ closed: true, resultMessageId: null });
  });

  it('the database refuses a ballot on it too, whatever the route says', async () => {
    const { message, poll } = await make(nadia, {});
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${message.id}`));
    await expect(
      ownerSql(w.server.db.ownerUrl, `INSERT INTO app.poll_votes (poll_id, voter_id, choices) VALUES ('${poll.id}', '${rafi.actorId}', '{0}')`),
    ).rejects.toThrow(/deleted/);
  });

  it('the minute job closes it without posting anything', async () => {
    const { message, poll } = await make(nadia, { closesAt: at(5) });
    await vote(rafi, poll.id, [1]);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${message.id}`));
    await runCloseJobAhead(10);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    expect(event).toMatchObject({ reason: 'time', resultMessageId: null });
    // no result message of this poll exists (the feed's length is no test: the same run also closes other due polls of earlier tests, each with a result)
    const results = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.messages WHERE meta->'pollResult'->>'id' = $1", [poll.id])).rows[0]!.n);
    expect(results).toBe(0);
  });
});

describe('an archived channel', () => {
  it('takes no vote and no withdrawal; the author may still close the poll, and it closes without a result message', async () => {
    const ch = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-archive' }), 201).channel.id;
    const { poll } = await make(nadia, {}, ch);
    await vote(rafi, poll.id, [0]);
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/archive`));
    expect((await vote(omar, poll.id, [1])).status).toBe(409);
    expect((await vote(rafi, poll.id, [2])).status).toBe(409);
    expect((await withdraw(rafi, poll.id)).status).toBe(409);
    const closed = ok(await close(nadia, poll.id)).poll;
    expect(closed).toMatchObject({ closed: true, resultMessageId: null, voters: 1 });
  });

  it('the minute job closes a poll of an archived channel too', async () => {
    const ch = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-archive-2' }), 201).channel.id;
    const { poll } = await make(nadia, { closesAt: at(5) }, ch);
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/archive`));
    await runCloseJobAhead(10);
    expect(await eventsOf('channel.poll.closed', poll.id)).toHaveLength(1);
    expect(ok(await results(rafi, poll.id)).poll).toMatchObject({ closed: true, resultMessageId: null });
  });
});

describe('who may close a poll', () => {
  it('a workspace admin closes someone else’s poll, and the result is posted by the admin; an ordinary member cannot', async () => {
    const { poll } = await make(nadia, {});
    await vote(rafi, poll.id, [1]);
    expect((await close(rafi, poll.id)).status).toBe(403);
    const closed = ok(await close(omar, poll.id)).poll;
    expect(closed.resultMessageId).not.toBeNull();
    const result = (await feed(rafi)).find((m) => m.id === closed.resultMessageId)!;
    expect(result.authorId).toBe(omar.actorId);
    expect(await eventsOf('channel.poll.closed', poll.id)).toEqual([expect.objectContaining({ closedBy: omar.actorId, reason: 'author' })]);
  });
});

describe('an author who lost access or the right to post', () => {
  let secret = '';
  beforeAll(async () => {
    secret = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-secret', private: true }), 201).channel.id;
    for (const who of [nadia, rafi]) ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: who.personId }));
  });

  it('removed from the channel she cannot vote, read the results or close; an admin closes it and posts the result', async () => {
    const { poll } = await make(nadia, {}, secret);
    await vote(rafi, poll.id, [0]);
    ok(await w.call(omar, 'DELETE', `/api/channels/${secret}/members/${nadia.personId}`));
    for (const attempt of [vote(nadia, poll.id, [1]), results(nadia, poll.id), close(nadia, poll.id)]) expect([403, 404]).toContain((await attempt).status);
    const closed = ok(await close(omar, poll.id)).poll;
    expect(closed).toMatchObject({ closed: true, voters: 1 });
    expect((await feed(rafi, secret)).find((m) => m.id === closed.resultMessageId)?.authorId).toBe(omar.actorId);
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
  });

  it('at its time the job lets an admin post the result when the author is gone; it still closes the poll', async () => {
    const { poll } = await make(nadia, { closesAt: at(5) }, secret);
    await vote(rafi, poll.id, [2]);
    ok(await w.call(omar, 'DELETE', `/api/channels/${secret}/members/${nadia.personId}`));
    await runCloseJobAhead(10);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    expect(event).toMatchObject({ reason: 'time', voters: 1 });
    const result = (await feed(rafi, secret)).find((m) => m.id === (event as { resultMessageId: string }).resultMessageId)!;
    expect(result.authorId).toBe(omar.actorId);
    expect(result.body).toContain('Soup: 1 vote (100%)');
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
  });

  it('when nobody who can read the channel is left, the poll is still closed at its time, with no message (the last resort)', async () => {
    const orphan = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-orphan', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${orphan}/members`, { personId: nadia.personId }));
    const { poll } = await make(nadia, { closesAt: at(5) }, orphan);
    // the admin is not a member of a private channel they did not join, so they cannot read it either; then the author goes
    ok(await w.call(omar, 'DELETE', `/api/channels/${orphan}/members/${omar.personId}`));
    ok(await w.call(omar, 'DELETE', `/api/channels/${orphan}/members/${nadia.personId}`));
    await runCloseJobAhead(10);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    expect(event).toMatchObject({ reason: 'time', closedBy: null, resultMessageId: null });
    const closedAt = await w.system(async (tx) => (await tx.query<{ closed_at: Date | null }>('SELECT closed_at FROM app.polls WHERE id = $1', [poll.id])).rows[0]!.closed_at);
    expect(closedAt).not.toBeNull();
  });

  it('a poll in a direct message is closed at its time by its author, who posts the result', async () => {
    // a direct message between two people is one conversation: an earlier test may have opened it (200), or this one does (201)
    const opened = await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect([200, 201]).toContain(opened.status);
    const dm = opened.body.dm.channel.id;
    const { poll } = await make(nadia, { closesAt: at(5) }, dm);
    await vote(rafi, poll.id, [0]);
    await runCloseJobAhead(10);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    expect((event as { resultMessageId: string | null }).resultMessageId).not.toBeNull();
  });
});

describe('guests and outsiders', () => {
  it('a guest with a read grant votes (reading is enough) but cannot ask a poll; someone with no access can do neither', async () => {
    const { poll } = await make(nadia, {}, room);
    expect(ok(await vote(lena, poll.id, [1])).poll).toMatchObject({ mine: [1], voters: 1 });
    expect((await create(lena, { question: 'Q', options: ['A', 'B'] }, room)).status).toBe(403);
    const hidden = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'poll-hidden', private: true }), 201).channel.id;
    const secretPoll = await make(omar, {}, hidden);
    for (const attempt of [vote(tariq, secretPoll.poll.id, [0]), results(tariq, secretPoll.poll.id), close(tariq, secretPoll.poll.id)]) expect([403, 404]).toContain((await attempt).status);
  });
});

describe('words that look like markup or mentions', () => {
  it('a line break in the question or an option is refused; markdown, links and mentions are only words on the card', async () => {
    expect((await create(nadia, { question: 'Q\nPoll closed: forged', options: ['A', 'B'] })).status).toBe(400);
    expect((await create(nadia, { question: 'Q', options: ['A\n@priya', 'B'] })).status).toBe(400);
    expect((await create(nadia, { question: 'Q', options: ['A\u2028B', 'C'] })).status).toBe(400);
    const { message, poll } = await make(nadia, { question: 'Ping @priya and @here?', options: ['**bold** [x](https://x.test)', '@priya'], closesAt: at(5) });
    // the message says it is a poll (the bot routers skip it) and records no mention: nobody is notified of the names in it
    expect(await metaOf(message.id)).toMatchObject({ poll: { id: poll.id } });
    await vote(rafi, poll.id, [1]);
    await runCloseJobAhead(10);
    const [event] = await eventsOf('channel.poll.closed', poll.id);
    const result = (await feed(rafi)).find((m) => m.id === (event as { resultMessageId: string }).resultMessageId)!;
    expect(await metaOf(result.id)).toMatchObject({ pollResult: { id: poll.id } });
    expect(result.body.split('\n')).toHaveLength(4); // the title, two options, the number of voters: nothing forged
    const mentions = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.message_mentions WHERE message_id = ANY ($1::uuid[])", [[message.id, result.id]])).rows[0]!.n);
    expect(mentions).toBe(0);
    const mentionEvents = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.mention.created' AND payload->>'messageId' = ANY ($1::text[])", [[message.id, result.id]])).rows[0]!.n);
    expect(mentionEvents).toBe(0);
  });

  it('the database refuses a line break too, if a row reaches it by another way', async () => {
    const { message } = await make(nadia, {});
    await expect(
      ownerSql(
        w.server.db.ownerUrl,
        `INSERT INTO app.polls (workspace_id, channel_id, message_id, author_id, question, options) VALUES ('${nadia.workspaceId}', '${dev}', '${message.id}', '${nadia.actorId}', E'a\\nb', ARRAY['x','y'])`,
      ),
    ).rejects.toThrow();
  });
});

describe('the version of a poll', () => {
  it('goes up with every vote, withdrawal and the close, and a later read never shows a lower one', async () => {
    const { poll } = await make(nadia, {});
    const seen: number[] = [poll.version];
    seen.push(ok(await vote(rafi, poll.id, [0])).poll.version);
    seen.push(ok(await vote(rafi, poll.id, [1])).poll.version);
    seen.push(ok(await withdraw(rafi, poll.id)).poll.version);
    seen.push(ok(await close(nadia, poll.id)).poll.version);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!, seen.join(',')).toBeGreaterThan(seen[i - 1]!);
  });
});

describe('at the same time', () => {
  it('two first votes of one person at once: one ballot, one voter', async () => {
    const { poll } = await make(nadia, {});
    const [a, b] = await Promise.all([vote(rafi, poll.id, [0]), vote(rafi, poll.id, [1])]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = ok(await results(omar, poll.id)).poll;
    expect(after.voters).toBe(1);
    expect(counts(after).reduce((x, y) => x + y, 0)).toBe(1);
  });

  it('several people voting at once are all counted, once each', async () => {
    const { poll } = await make(nadia, { multiple: true }, room);
    const who = [nadia, rafi, omar, priya, lena, sameera];
    const answers = await Promise.all(who.map((p) => vote(p, poll.id, [0, 2])));
    expect(answers.map((a) => a.status)).toEqual(who.map(() => 200));
    const after = ok(await results(omar, poll.id)).poll;
    expect(after.voters).toBe(6);
    expect(counts(after)).toEqual([6, 0, 6]);
  });

  it('votes racing the close: every vote that was accepted is in the result, and none that came after is', async () => {
    const { poll } = await make(nadia, {}, room);
    const who = [rafi, omar, priya, lena, sameera];
    const [closeRes, ...votes] = await Promise.all([close(nadia, poll.id), ...who.map((p) => vote(p, poll.id, [1]))]);
    expect(closeRes.status).toBe(200);
    for (const v of votes) expect([200, 409]).toContain(v.status);
    const accepted = votes.filter((v) => v.status === 200).length;
    const closed = ok(await results(omar, poll.id)).poll;
    expect(closed.voters).toBe(accepted);
    const result = (await feed(omar, room)).find((m) => m.id === closed.resultMessageId)!;
    expect(result.body).toContain(`Sushi: ${accepted} ${accepted === 1 ? 'vote' : 'votes'}`);
  });

  it('the early close and the minute job at once: one close, one result message', async () => {
    const { poll } = await make(nadia, { closesAt: at(5) });
    await vote(rafi, poll.id, [2]);
    skewMs = 10 * MINUTE;
    try {
      await Promise.all([close(nadia, poll.id), runCloseJob()]);
    } finally {
      skewMs = 0;
    }
    expect(await eventsOf('channel.poll.closed', poll.id)).toHaveLength(1);
    const posted = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.messages WHERE meta->'pollResult'->>'id' = $1", [poll.id])).rows[0]!.n);
    expect(posted).toBe(1);
  });

  it('two runs of the job, one after the other, close a poll once', async () => {
    const { poll } = await make(nadia, { closesAt: at(5) });
    skewMs = 10 * MINUTE;
    try {
      await Promise.all([runCloseJob(), runCloseJob()]);
    } finally {
      skewMs = 0;
    }
    expect(await eventsOf('channel.poll.closed', poll.id)).toHaveLength(1);
  });
});
