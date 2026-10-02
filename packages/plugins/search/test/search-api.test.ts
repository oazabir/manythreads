import { createAppPool, withActor } from '@manythreads/kernel';
import { SearchResponse } from '@manythreads/shared';
import { personaActor } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;

let w: FilesWorld;
let dev = '';
let releases = '';
let supportChannel = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
  supportChannel = await w.channelId('customer-support', 'support');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = async (who: typeof nadia, channelId: string, body: string, threadRootId: string | null = null): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId }), 201).id;
const find = async (who: typeof nadia | null, q: string, extra = ''): Promise<SearchResponse> =>
  SearchResponse.parse(ok(await w.call(who, 'GET', `/api/search?q=${encodeURIComponent(q)}${extra}`)));
const ids = (r: SearchResponse): string[] => r.messages.map((m) => m.id);
/** A message written `age` ago: the id carries the time (uuid v7), as a real older message's does. */
const postAged = (channelId: string, author: typeof nadia, body: string, age: string): Promise<string> =>
  w.system(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, created_at)
       VALUES (uuidv7(-$5::interval), $1, $2, $3, $4, $4, now() - $5::interval) RETURNING id`,
      [author.workspaceId, channelId, author.actorId, body, age],
    );
    return r.rows[0]!.id;
  });
let n = 0;
/** A random word that shares no trigrams worth mentioning with any other (two of them never match each other). */
const word = (): string => Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

describe('typos (criterion 6)', () => {
  it('"rolback" finds "rollback", for a member of the team', async () => {
    const id = await post(nadia, dev, 'We need to rollback the release before standup');
    const hits = await find(rafi, 'rolback');
    expect(ids(hits)).toContain(id);
    expect(hits.messages.find((m) => m.id === id)?.channel).toMatchObject({ id: dev, name: 'dev', kind: 'channel' });
    expect(hits.messages.find((m) => m.id === id)?.snippet).toContain('rollback the release');
    expect(hits.messages.find((m) => m.id === id)?.score).toBeGreaterThan(0.5);
  });

  it('finds a word with a letter missing, one too many, or one wrong; not a different word', async () => {
    const w1 = word();
    const id = await post(nadia, dev, `the ${w1} migration is blocked`);
    expect(ids(await find(rafi, w1))).toContain(id);
    expect(ids(await find(rafi, w1.slice(0, 4) + w1.slice(5)))).toContain(id);
    expect(ids(await find(rafi, w1 + 'x'))).toContain(id);
    expect(ids(await find(rafi, `${w1.slice(0, 5)}${w1[5] === 'q' ? 'z' : 'q'}${w1.slice(6)}`))).toContain(id);
    expect(ids(await find(rafi, `${word()}`))).not.toContain(id);
  });

  it('matches words inside long messages and across punctuation (word similarity, not whole-text similarity)', async () => {
    const w1 = word();
    const long = `${'Lots of unrelated words about nothing in particular. '.repeat(8)}Then ${w1}, finally, and after that more filler text. ${'More. '.repeat(20)}`;
    const id = await post(nadia, dev, long);
    expect(ids(await find(rafi, w1))).toContain(id);
    expect(ids(await find(rafi, w1.slice(0, 5) + w1.slice(6)))).toContain(id);
  });

  it('finds markdown text by what is shown: **bold**, links and code keep their words', async () => {
    const w1 = word();
    const id = await post(nadia, dev, `**${w1}** and [a link to ${w1}b](https://example.com) and \`code${w1}\``);
    const hit = (await find(rafi, w1)).messages.find((m) => m.id === id);
    expect(hit).toBeDefined();
    expect(hit?.snippet).not.toContain('**');
    expect(hit?.snippet).not.toContain('https://');
  });
});

describe('what you cannot read is never found', () => {
  it('a private channel: not by a team member outside it, not by another team, not by a guest, not by a workspace admin who is not a member', async () => {
    const w1 = word();
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: `srch-private-${n++}`, private: true }), 201);
    const priv = created.channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId }));
    const secret = await post(rafi, priv, `the ${w1} layoff plan`);
    const open = await post(nadia, dev, `${w1} is also discussed in the open`);
    // Omar created the channel and so is its first member: he finds it until he leaves, and a workspace admin who is not a member does not.
    expect(ids(await find(omar, w1)).sort()).toEqual([open, secret].sort());
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${omar.personId}`));
    for (const who of [nadia, priya, sameera, tariq, lena, omar]) {
      const hits = await find(who, w1);
      expect(ids(hits), who.key).not.toContain(secret);
      expect(JSON.stringify(hits), who.key).not.toContain('layoff');
    }
    expect(ids(await find(rafi, w1)).sort()).toEqual([open, secret].sort());
    // Thread titles too: a thread in the private channel is invisible by the same rule.
    await post(rafi, priv, 'a reply', secret);
    expect((await find(nadia, w1, '&scope=threads')).threads).toEqual([]);
    expect((await find(rafi, w1, '&scope=threads')).threads.map((t) => t.rootMessageId)).toEqual([secret]);
  });

  it('a DM: only its two people', async () => {
    const w1 = word();
    const dm = await w.system(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key) VALUES ($1, NULL, 'dm-search', 'dm', true, $2) RETURNING id`,
        [nadia.workspaceId, `search:${nadia.personId}:${rafi.personId}`],
      );
      await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2), ($1, $3)', [r.rows[0]!.id, nadia.personId, rafi.personId]);
      return r.rows[0]!.id;
    });
    const id = await post(nadia, dm, `${w1} between the two of us`);
    expect(ids(await find(rafi, w1))).toEqual([id]);
    expect((await find(rafi, w1)).messages[0]?.channel).toMatchObject({ kind: 'dm', name: null });
    for (const who of [priya, omar, sameera, lena]) expect(ids(await find(who, w1)), who.key).toEqual([]);
  });

  it('another team: Sameera finds nothing of Engineering and Engineering nothing of Customer support; Priya (both) finds both', async () => {
    const w1 = word();
    const eng = await post(nadia, dev, `${w1} engineering note`);
    const sup = await post(sameera, supportChannel, `${w1} support note`);
    expect(ids(await find(sameera, w1))).toEqual([sup]);
    expect(ids(await find(nadia, w1))).toEqual([eng]);
    expect(ids(await find(omar, w1)).sort()).toEqual([eng, sup].sort()); // a workspace admin reads every public channel
    // The team filter narrows, never widens.
    const teams = ok<{ teams: { id: string; slug: string }[] }>(await w.call(omar, 'GET', '/api/teams'));
    const engTeam = teams.teams.find((t) => t.slug === 'engineering')!;
    expect(ids(await find(omar, w1, `&teamId=${engTeam.id}`))).toEqual([eng]);
    const supTeam = teams.teams.find((t) => t.slug === 'customer-support')!;
    expect(ids(await find(nadia, w1, `&teamId=${supTeam.id}`))).toEqual([]);
  });

  it('a guest: nothing until a grant, then only the granted channel; revoked, nothing again', async () => {
    const w1 = word();
    await post(nadia, dev, `${w1} in dev`);
    const rel = await post(nadia, releases, `${w1} in releases`);
    expect(ids(await find(lena, w1))).toEqual([]);
    await w.grant(releases, lena, 'read');
    expect(ids(await find(lena, w1))).toEqual([rel]);
    await w.revoke(releases, lena);
    expect(ids(await find(lena, w1))).toEqual([]);
  });

  it('an edit is searchable at once and the old text is gone; a deleted message is not found', async () => {
    const before = word();
    const after = word();
    const id = await post(nadia, dev, `first ${before}`);
    expect(ids(await find(rafi, before))).toEqual([id]);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: `second ${after}` }));
    expect(ids(await find(rafi, before))).toEqual([]);
    expect(ids(await find(rafi, after))).toEqual([id]);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    expect(ids(await find(rafi, after))).toEqual([]);
  });
});

describe('ranking and slices', () => {
  it('exact spelling before a typo, then newest first among equals', async () => {
    const w1 = word();
    const typo = await post(nadia, dev, `${w1.slice(0, 4)}${w1.slice(5)} the misspelt one`);
    const first = await post(nadia, dev, `${w1} first exact`);
    const second = await post(nadia, dev, `${w1} second exact`);
    const hits = (await find(rafi, w1)).messages;
    expect(hits.map((m) => m.id)).toEqual([second, first, typo]);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it('finds old messages: a rare word only matched 200 days ago is found; so is one older than every slice', async () => {
    const w1 = word();
    const w2 = word();
    const old = await postAged(dev, nadia, `${w1} from last spring`, '200 days');
    const ancient = await postAged(dev, nadia, `${w2} from long ago`, '900 days');
    expect(ids(await find(rafi, w1))).toEqual([old]);
    expect(ids(await find(rafi, w2))).toEqual([ancient]);
  });

  it('a common word is answered from the newest slice: with 25 hits from today, an older hit is not needed (limit 20)', async () => {
    const w1 = word();
    const oldest = await postAged(dev, nadia, `${w1} old and exact`, '100 days');
    const recent: string[] = [];
    for (let i = 0; i < 25; i++) recent.push(await postAged(dev, nadia, `${w1} recent number ${i}`, `${i + 1} minutes`));
    const hits = await find(rafi, w1);
    expect(hits.messages).toHaveLength(20);
    expect(ids(hits)).not.toContain(oldest);
    expect(hits.messages.every((m) => recent.includes(m.id))).toBe(true);
    // Asking for less than there is never returns an older hit before a newer exact one.
    expect(ids(await find(rafi, w1, '&limit=5'))).toEqual(hits.messages.slice(0, 5).map((m) => m.id));
    // With fewer than `limit` hits in the recent slices the older one joins them.
    const w3 = word();
    const o2 = await postAged(dev, nadia, `${w3} old`, '100 days');
    const r2 = await postAged(dev, nadia, `${w3} new`, '1 minute');
    expect(ids(await find(rafi, w3))).toEqual([r2, o2]);
  });

  it('limit bounds each kind and is validated', async () => {
    const w1 = word();
    for (let i = 0; i < 4; i++) await post(nadia, dev, `${w1} item ${i}`);
    expect((await find(rafi, w1, '&limit=2')).messages).toHaveLength(2);
    expect((await w.call(rafi, 'GET', `/api/search?q=${w1}&limit=0`)).status).toBe(400);
    expect((await w.call(rafi, 'GET', `/api/search?q=${w1}&limit=51`)).status).toBe(400);
  });
});

describe('threads and files', () => {
  it('finds a thread by the title of its first message, with its reply count, only once it has replies', async () => {
    const w1 = word();
    const root = await post(nadia, dev, `${w1} deploy plan for the week`);
    expect((await find(rafi, w1, '&scope=threads')).threads).toEqual([]);
    await post(rafi, dev, 'on it', root);
    await post(nadia, dev, 'thanks', root);
    const t = (await find(rafi, w1, '&scope=threads')).threads;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ rootMessageId: root, replyCount: 2 });
    expect(t[0]?.channel).toMatchObject({ id: dev, name: 'dev' });
    expect((await find(rafi, w1.slice(0, 4) + w1.slice(5), '&scope=threads')).threads.map((x) => x.rootMessageId)).toEqual([root]);
    expect((await find(sameera, w1, '&scope=threads')).threads).toEqual([]);
  });

  it('files.search: a file name is found by a typo, as the readers of its channel only', async () => {
    const w1 = word();
    const up = await w.upload(nadia, dev, '%PDF-1.4', { name: `${w1}-quarterly-agenda.pdf`, type: 'application/pdf' });
    const file = ok<{ id: string }>(up, 201);
    const typed = await find(rafi, `${w1.slice(0, 4)}${w1.slice(5)}`, '&scope=files');
    expect(typed.files.map((f) => f.id)).toEqual([file.id]);
    expect(typed.files[0]).toMatchObject({ name: `${w1}-quarterly-agenda.pdf`, mime: 'application/pdf', folderPath: 'channels/dev/' });
    expect(typed.files[0]?.channel).toMatchObject({ id: dev, name: 'dev' });
    expect(typed.messages).toEqual([]);
    expect((await find(sameera, w1, '&scope=files')).files).toEqual([]);
    expect((await find(lena, w1, '&scope=files')).files).toEqual([]);
    ok(await w.call(nadia, 'DELETE', `/api/files/${file.id}`));
    expect((await find(rafi, w1, '&scope=files')).files).toEqual([]);
  });

  it('a file in a private channel is not found by the rest of the team', async () => {
    const w1 = word();
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: `srch-files-${n++}`, private: true }), 201);
    ok(await w.call(omar, 'POST', `/api/channels/${created.channel.id}/members`, { personId: rafi.personId }));
    ok(await w.upload(rafi, created.channel.id, 'x', { name: `${w1}-salaries.xlsx`, type: 'text/plain' }), 201);
    ok(await w.call(omar, 'DELETE', `/api/channels/${created.channel.id}/members/${omar.personId}`));
    expect((await find(rafi, w1, '&scope=files')).files).toHaveLength(1);
    for (const who of [nadia, priya, omar, sameera, lena]) expect((await find(who, w1, '&scope=files')).files, who.key).toEqual([]);
  });
});

describe('the request', () => {
  it('validates the query and needs a signed-in caller', async () => {
    expect((await w.call(rafi, 'GET', '/api/search')).status).toBe(400);
    expect((await w.call(rafi, 'GET', '/api/search?q=a')).status).toBe(400);
    expect((await w.call(rafi, 'GET', `/api/search?q=${'x'.repeat(201)}`)).status).toBe(400);
    expect((await w.call(rafi, 'GET', '/api/search?q=rollback&scope=everything')).status).toBe(400);
    expect((await w.call(rafi, 'GET', '/api/search?q=rollback&teamId=nope')).status).toBe(400);
    expect((await w.call(null, 'GET', '/api/search?q=rollback')).status).toBe(401);
    // Whitespace is collapsed, and the answer says what it searched for.
    expect((await find(rafi, '  roll    back  ')).query).toBe('roll back');
  });

  it('has no hits for nothing readable, with all three lists present', async () => {
    const hits = await find(sameera, word());
    expect(hits).toMatchObject({ messages: [], threads: [], files: [] });
  });

  it('survives hostile text: wildcards, quotes, backslashes and very long words are plain characters', async () => {
    for (const q of ["%%", '_ _', "'; DROP TABLE app.messages; --", '\\\\\\', 'a'.repeat(200), '日本語のテスト', '🙂🙂', '"quoted phrase"', '((((']) {
      const res = await w.call(rafi, 'GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect((await w.call(rafi, 'GET', '/api/channels')).status).not.toBe(500);
  });
});

// A caller who reads more than 6,000 messages gets the sliced plans (newest slices through the trigram index, then the whole history); below that
// the function compares every readable row. The tests above run on the small plan; these put Rafi and Nadia on the large one with filler.
describe('a caller who reads many messages (slices through the trigram index)', () => {
  beforeAll(async () => {
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, created_at)
         SELECT uuidv7(-(g * interval '60 minutes')), $1, $2, $3, 'filler ' || g || ' about nothing in particular', 'filler ' || g || ' about nothing in particular',
                now() - (g * interval '60 minutes')
           FROM generate_series(1, 6500) g`,
        [nadia.workspaceId, dev, nadia.actorId],
      );
      await tx.query('ANALYZE app.messages');
    });
  }, 120_000);

  it('is on the large plan: more than 6,000 messages are readable', async () => {
    const n = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.messages WHERE channel_id = $1', [dev])).rows[0]!.n);
    expect(n).toBeGreaterThan(6000);
  });

  it('typos, ranking and the privacy rule are the same on the large plan', async () => {
    const w1 = word();
    const typo = await post(nadia, dev, `${w1.slice(0, 4)}${w1.slice(5)} the misspelt one`);
    const exact = await post(nadia, dev, `${w1} exact`);
    const hits = (await find(rafi, w1)).messages;
    expect(hits.map((m) => m.id)).toEqual([exact, typo]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(ids(await find(sameera, w1))).toEqual([]);
    expect(ids(await find(lena, w1))).toEqual([]);
    ok(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: `srch-large-private-${n++}`, private: true }), 201);
  });

  it('a private channel stays invisible to a caller on the large plan', async () => {
    const w1 = word();
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: `srch-large-priv-${n++}`, private: true }), 201);
    ok(await w.call(omar, 'POST', `/api/channels/${created.channel.id}/members`, { personId: rafi.personId }));
    ok(await w.call(omar, 'DELETE', `/api/channels/${created.channel.id}/members/${omar.personId}`));
    const secret = await post(rafi, created.channel.id, `${w1} confidential`);
    for (const who of [nadia, priya, omar]) expect(ids(await find(who, w1)), who.key).not.toContain(secret);
    expect(ids(await find(rafi, w1))).toEqual([secret]);
  });

  it('answers from the newest slice when it holds enough hits, and from older history when it does not', async () => {
    const common = word();
    const old = await postAged(dev, nadia, `${common} old and exact`, '100 days');
    const recent: string[] = [];
    for (let i = 0; i < 25; i++) recent.push(await postAged(dev, nadia, `${common} recent number ${i}`, `${i + 1} minutes`));
    const hits = await find(rafi, common);
    expect(hits.messages).toHaveLength(20);
    expect(ids(hits)).not.toContain(old);
    expect(hits.messages.every((m) => recent.includes(m.id))).toBe(true);

    // 5 hits today, 30 in the 2 to 15 days before: the 16-day slice answers with the best 20 of the 35.
    const mid = word();
    const today: string[] = [];
    for (let i = 0; i < 5; i++) today.push(await postAged(dev, nadia, `${mid} today ${i}`, `${i + 1} hours`));
    const spread: string[] = [];
    for (let i = 0; i < 30; i++) spread.push(await postAged(dev, nadia, `${mid} spread ${i}`, `${2 + (i % 13)} days ${i} minutes`));
    const midHits = (await find(rafi, mid)).messages.map((m) => m.id);
    expect(midHits).toHaveLength(20);
    for (const id of today) expect(midHits).toContain(id);

    // Fewer than 20 in 16 days: the whole history, older hits included and newest first among equals.
    const few = word();
    const a = await postAged(dev, nadia, `${few} two hours ago`, '2 hours');
    const b = await postAged(dev, nadia, `${few} a month ago`, '30 days');
    const c = await postAged(dev, nadia, `${few} a year ago`, '400 days');
    expect(ids(await find(rafi, few))).toEqual([a, b, c]);
  });

  it('finds old messages: 200 days and 900 days back', async () => {
    const w1 = word();
    const w2 = word();
    const old = await postAged(dev, nadia, `${w1} from last spring`, '200 days');
    const ancient = await postAged(dev, nadia, `${w2} from long ago`, '900 days');
    expect(ids(await find(rafi, w1))).toEqual([old]);
    expect(ids(await find(rafi, w2))).toEqual([ancient]);
    expect(ids(await find(rafi, `${w1.slice(0, 5)}${w1.slice(6)}`))).toEqual([old]);
  });

  it('a phrase of three words or more is held to the stricter threshold but still found', async () => {
    const w1 = word();
    const w2 = word();
    const w3 = word();
    const id = await post(nadia, dev, `please ${w1} ${w2} ${w3} before friday`);
    expect(ids(await find(rafi, `${w1} ${w2} ${w3}`))).toEqual([id]);
    expect(ids(await find(rafi, `${w1} ${w2}`))).toContain(id);
  });
});

describe('the capabilities messages.search and files.search', () => {
  it('are declared by the manifest and answer as the transaction\'s actor', async () => {
    const { default: plugin } = await import('../src/index.ts');
    expect(plugin.manifest.capabilities.map((c) => c.name).sort()).toEqual(['files.search', 'messages.search']);
    expect(plugin.manifest.capabilities.every((c) => c.destructive === false)).toBe(true);
    const handlers = new Map<string, (input: Record<string, unknown>, tx: never) => Promise<unknown>>();
    await plugin.register({
      http: { route: () => undefined },
      capabilities: { register: (name: string, h: (input: Record<string, unknown>, tx: never) => Promise<unknown>) => void handlers.set(name, h) },
    } as never);
    const pool = createAppPool(w.server.db.appUrl, 2);
    try {
      const w1 = word();
      const id = await post(nadia, dev, `${w1} capability test`);
      ok(await w.upload(nadia, dev, '%PDF-1.4', { name: `${w1}-capability.pdf`, type: 'application/pdf' }), 201);
      const run = (name: string, who: typeof nadia, input: Record<string, unknown>): Promise<{ hits: { id: string }[] }> =>
        withActor(personaActor(who), async (tx) => (await handlers.get(name)!(input, tx as never)) as { hits: { id: string }[] }, { pool });
      expect((await run('messages.search', rafi, { query: w1 })).hits.map((h) => h.id)).toEqual([id]);
      expect((await run('messages.search', rafi, { query: w1.slice(0, 5) + w1.slice(6) })).hits.map((h) => h.id)).toEqual([id]);
      expect((await run('files.search', rafi, { query: w1 })).hits).toHaveLength(1);
      expect((await run('messages.search', sameera, { query: w1 })).hits).toEqual([]);
      expect((await run('files.search', sameera, { query: w1 })).hits).toEqual([]);
      await expect(run('messages.search', rafi, { query: 'x' })).rejects.toThrow();
      await expect(run('messages.search', rafi, { query: w1, limit: 500 })).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
