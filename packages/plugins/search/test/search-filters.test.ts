import { SavedSearch, SearchResponse } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// P14-11: filter words, filters-only searches, pages, saved searches, and the rule behind all of them: a filter only narrows, a name only
// resolves among what the asker may know, and no answer (not even "there are more") says anything about a row the asker cannot read.
const { omar, nadia, rafi, sameera, priya, lena } = personas;

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
const post = async (who: typeof nadia, channelId: string, body: string, extra: Record<string, unknown> = {}): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null, ...extra }), 201).id;
const find = async (who: typeof nadia | null, q: string, extra = ''): Promise<SearchResponse> =>
  SearchResponse.parse(ok(await w.call(who, 'GET', `/api/search?q=${encodeURIComponent(q)}${extra}`)));
const ids = (r: SearchResponse): string[] => r.messages.map((m) => m.id);
const aged = (channelId: string, author: typeof nadia, body: string, age: string): Promise<string> =>
  w.system(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, created_at)
       VALUES (uuidv7(-$5::interval), $1, $2, $3, $4, $4, now() - $5::interval) RETURNING id`,
      [author.workspaceId, channelId, author.actorId, body, age],
    );
    return r.rows[0]!.id;
  });
let n = 0;
const word = (): string => {
  let out = '';
  while (out.length < 10) {
    const c = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]!;
    if (c !== out[out.length - 1]) out += c;
  }
  return out;
};
const privateChannel = async (members: (typeof nadia)[]): Promise<string> => {
  const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: `srch-flt-${n++}`, private: true }), 201);
  for (const m of members) ok(await w.call(omar, 'POST', `/api/channels/${created.channel.id}/members`, { personId: m.personId }));
  ok(await w.call(omar, 'DELETE', `/api/channels/${created.channel.id}/members/${omar.personId}`));
  return created.channel.id;
};

describe('from:', () => {
  it('finds what one person wrote, by first name, by last word of the name, quoted full name, and me', async () => {
    const w1 = word();
    const byNadia = await post(nadia, dev, `${w1} by nadia`);
    const byRafi = await post(rafi, dev, `${w1} by rafi`);
    expect(ids(await find(priya, `from:nadia ${w1}`))).toEqual([byNadia]);
    expect(ids(await find(priya, `${w1} from:RAFI`))).toEqual([byRafi]);
    expect(ids(await find(rafi, `from:me ${w1}`))).toEqual([byRafi]);
    const named = await find(priya, `from:nadia ${w1}`);
    expect(named.filters.from).toEqual(['nadia']);
    expect(named.query).toBe(w1);
    expect(named.unmatched).toEqual([]);
  });

  it('a name nobody has finds nothing and says so; it is not read as text', async () => {
    const w1 = word();
    await post(nadia, dev, `${w1} hello`);
    const res = await find(rafi, `from:zzqx ${w1}`);
    expect(res.messages).toEqual([]);
    expect(res.unmatched).toEqual(['from:zzqx']);
  });

  it('a guest resolves only themself: from:nadia is unmatched for Lena, from:me works', async () => {
    const w1 = word();
    await post(nadia, releases, `${w1} in releases`);
    await w.grant(releases, lena, 'read');
    try {
      const res = await find(lena, `from:nadia ${w1}`);
      expect(res.messages).toEqual([]);
      expect(res.unmatched).toEqual(['from:nadia']);
      expect(ids(await find(lena, w1)).length).toBe(1);
      expect((await find(lena, `from:me ${w1}`)).messages).toEqual([]);
    } finally {
      await w.revoke(releases, lena);
    }
  });
});

describe('in:', () => {
  it('narrows to a channel by name (with or without #) and never widens', async () => {
    const w1 = word();
    const inDev = await post(nadia, dev, `${w1} in dev`);
    const inRel = await post(nadia, releases, `${w1} in releases`);
    expect(ids(await find(rafi, `in:dev ${w1}`))).toEqual([inDev]);
    expect(ids(await find(rafi, `in:#releases ${w1}`))).toEqual([inRel]);
    expect(ids(await find(rafi, `in:dev in:releases ${w1}`)).sort()).toEqual([inDev, inRel].sort());
  });

  it('a private channel: a non-member gets the same answer as for a channel that does not exist', async () => {
    const w1 = word();
    const secret = await privateChannel([rafi]);
    const channelName = (await w.system((tx) => tx.query<{ name: string }>('SELECT name FROM app.channels WHERE id = $1', [secret]))).rows[0]!.name;
    const hidden = await post(rafi, secret, `${w1} the layoff list`);
    // the member finds it, by text and by channel name
    expect(ids(await find(rafi, `in:${channelName} ${w1}`))).toEqual([hidden]);
    // everybody else: nothing, and "no such channel" exactly as for a made-up name
    for (const who of [nadia, priya, sameera, lena, omar]) {
      const real = await find(who, `in:${channelName} ${w1}`);
      const fake = await find(who, `in:no-such-channel-${n} ${w1}`);
      expect(real.messages, who.key).toEqual([]);
      expect(real.unmatched, who.key).toEqual([`in:${channelName}`]);
      expect(fake.unmatched, who.key).toEqual([`in:no-such-channel-${n}`]);
      expect(JSON.stringify(real), who.key).not.toContain('layoff');
    }
  });
});

describe('has:, is:, before:, after:', () => {
  it('has:link and has:file', async () => {
    const w1 = word();
    const plain = await post(nadia, dev, `${w1} plain`);
    const link = await post(nadia, dev, `${w1} see [the doc](https://example.com/spec) please`);
    const bare = await post(nadia, dev, `${w1} read http://example.org/x`);
    const up = ok<{ id: string }>(await w.upload(nadia, dev, 'hello', { name: `${w1}.txt`, type: 'text/plain' }), 201);
    const withFile = await post(nadia, dev, `${w1} attached`, { attachments: [up.id] });
    expect(ids(await find(rafi, `has:link ${w1}`)).sort()).toEqual([link, bare].sort());
    expect(ids(await find(rafi, `has:file ${w1}`))).toEqual([withFile]);
    expect(ids(await find(rafi, `has:file has:link ${w1}`))).toEqual([]);
    expect(ids(await find(rafi, w1))).toContain(plain);
  });

  it('is:thread: replies and roots with replies', async () => {
    const w1 = word();
    const root = await post(nadia, dev, `${w1} root`);
    const lone = await post(nadia, dev, `${w1} lone`);
    const reply = await post(rafi, dev, `${w1} reply`, { threadRootId: root });
    expect(ids(await find(priya, `is:thread ${w1}`)).sort()).toEqual([root, reply].sort());
    expect(ids(await find(priya, w1))).toContain(lone);
  });

  it('before: and after: are days in UTC, after: means after the whole day', async () => {
    const w1 = word();
    const old = await aged(dev, nadia, `${w1} long ago`, '40 days');
    const recent = await aged(dev, nadia, `${w1} lately`, '2 days');
    const day = (ago: number): string => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    expect(ids(await find(rafi, `${w1} before:${day(10)}`))).toEqual([old]);
    expect(ids(await find(rafi, `${w1} after:${day(10)}`))).toEqual([recent]);
    expect(ids(await find(rafi, `${w1} after:${day(60)} before:${day(10)}`))).toEqual([old]);
    // not a day: left in the text, nothing is filtered
    const bad = await find(rafi, `${w1} before:2026-02-30`);
    expect(bad.filters.before).toBeNull();
    expect(bad.query).toContain('before:2026-02-30');
  });

  it('a day the database cannot write (year 0000, the end of 9999-12-31) or a NUL character is plain text, never a server error', async () => {
    for (const q of ['before:0000-01-01 hello', 'after:0000-01-01 hello', 'after:9999-12-31 hello', 'before:9999-12-31 hello']) {
      const res = await find(rafi, q);
      expect(res.filters.before, q).toBeNull();
      expect(res.filters.after, q).toBeNull();
    }
    for (const q of ['hello%00x', 'from:a%00b hello', 'in:a%00b hello']) {
      const raw = await w.call(rafi, 'GET', `/api/search?q=${q}`);
      expect(raw.status, q).toBe(200);
    }
  });

  it('has:pin stays plain text (pins do not exist yet)', async () => {
    const res = await find(rafi, 'has:pin release');
    expect(res.filters.has).toEqual([]);
    expect(res.query).toBe('has:pin release');
  });
});

describe('a search that is only filters', () => {
  it('lists newest first, with no ranking, and says when there is more', async () => {
    const w1 = word();
    const first = await post(nadia, dev, `${w1} one`);
    const second = await post(nadia, dev, `${w1} two`);
    const third = await post(nadia, dev, `${w1} three`);
    const res = await find(rafi, 'from:nadia in:dev is:thread has:link');
    expect(res.query).toBe('');
    const all = await find(rafi, 'from:nadia in:dev', '&scope=messages&limit=2');
    expect(ids(all)).toEqual([third, second]);
    expect(all.more.messages).toBe(true);
    expect(first).toBeTruthy();
    expect(all.messages.every((m) => m.score === 0)).toBe(true);
  });

  it('reaches old messages: a filter-only search is not limited to the last day', async () => {
    const w1 = word();
    const old = await aged(dev, priya, `${w1} ancient`, '300 days');
    const res = await find(rafi, 'from:priya before:' + new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10), '&scope=messages');
    expect(ids(res)).toContain(old);
  });
});

describe('a hit count never reveals hidden hits', () => {
  it('twenty-five hidden hits: the outsider sees no hit, no "more", and the same answer as for a word nobody wrote', async () => {
    const w1 = word();
    const secret = await privateChannel([rafi, nadia]);
    for (let i = 0; i < 25; i++) await post(rafi, secret, `${w1} hidden number ${i}`);
    await post(nadia, dev, `${w1} one open note`);
    const outsider = await find(sameera, w1, '&limit=5');
    expect(outsider.messages).toEqual([]);
    expect(outsider.more).toEqual({ messages: false, threads: false, files: false, pages: false });
    const nothing = await find(sameera, word(), '&limit=5');
    const bare = (r: SearchResponse): string => JSON.stringify({ ...r, query: '', filters: { ...r.filters, text: '' } });
    expect(bare(outsider)).toBe(bare(nothing));
    // a team member outside the private channel sees only the open note, and no "more"
    const teammate = await find(priya, w1, '&limit=5');
    expect(teammate.messages).toHaveLength(1);
    expect(teammate.more.messages).toBe(false);
    // a member does see that there is more
    const member = await find(rafi, w1, '&limit=5');
    expect(member.messages).toHaveLength(5);
    expect(member.more.messages).toBe(true);
    // the same with filters, files and threads
    for (const q of [`from:rafi ${w1}`, `in:dev ${w1}`, `is:thread ${w1}`, `has:link ${w1}`]) {
      const res = await find(sameera, q, '&limit=5');
      expect(res.messages, q).toEqual([]);
      expect(res.more.messages, q).toBe(false);
    }
  });

  it('a file in a private channel is not counted for others, with filters', async () => {
    const w1 = word();
    const secret = await privateChannel([rafi]);
    ok(await w.upload(rafi, secret, 'x', { name: `${w1}-secret.txt`, type: 'text/plain' }), 201);
    expect((await find(rafi, `from:rafi ${w1}`, '&scope=files')).files).toHaveLength(1);
    expect((await find(rafi, `in:srch ${w1}`, '&scope=files')).files).toEqual([]);
    for (const who of [nadia, priya, sameera, lena, omar]) {
      const res = await find(who, `from:rafi ${w1}`, '&scope=files');
      expect(res.files, who.key).toEqual([]);
      expect(res.more.files, who.key).toBe(false);
    }
  });
});

describe('pages', () => {
  const write = (team: string, path: string, text: string, author: typeof nadia, when = 'now()'): Promise<void> =>
    w.system(async (tx) => {
      const sha = (Math.random().toString(16).slice(2) + '0'.repeat(40)).slice(0, 40);
      await tx.query(
        `INSERT INTO app.repo_commits (team_id, sha, author_id, message, committed_at, paths) VALUES ($1, $2, $3, 'write', ${when}, ARRAY[$4]::text[])`,
        [team, sha, author.actorId, path],
      );
      await tx.query('INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain) VALUES ($1, $2, $3, 10, $4, $5)', [team, path, sha, sha, text]);
    });

  it('a page is found by its text and its name, by the team that reads it only', async () => {
    const w1 = word();
    await write(TEAM_IDS.Engineering, `pages/runbooks/${w1}-restore.md`, `# Restore\nStep one: ${w1}${w1} pause the writers`, nadia);
    const hit = (await find(rafi, `${w1}`, '&scope=pages')).pages;
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ teamId: TEAM_IDS.Engineering, path: `pages/runbooks/${w1}-restore.md`, name: `${w1}-restore` });
    // a typo, and by text alone
    expect((await find(rafi, `${w1.slice(0, 4)}${w1.slice(5)}`, '&scope=pages')).pages).toHaveLength(1);
    for (const who of [sameera, lena]) {
      const res = await find(who, w1, '&scope=pages');
      expect(res.pages, who.key).toEqual([]);
      expect(res.more.pages, who.key).toBe(false);
    }
  });

  it('is part of one answer with messages and files, and filters apply: from: is who last saved, in:/has: leave pages out', async () => {
    const w1 = word();
    await write(TEAM_IDS.Engineering, `pages/${w1}-plan.md`, `plan for ${w1}`, nadia);
    const msg = await post(nadia, dev, `${w1} discussed`);
    const all = await find(rafi, w1);
    expect(ids(all)).toContain(msg);
    expect(all.pages.map((p) => p.path)).toEqual([`pages/${w1}-plan.md`]);
    expect((await find(rafi, `from:nadia ${w1}`)).pages).toHaveLength(1);
    expect((await find(rafi, `from:priya ${w1}`)).pages).toEqual([]);
    expect((await find(rafi, `in:dev ${w1}`)).pages).toEqual([]);
    expect((await find(rafi, `has:link ${w1}`)).pages).toEqual([]);
    expect((await find(rafi, `before:2001-01-01 ${w1}`)).pages).toEqual([]);
  });

  it('only pages/ : a file elsewhere in the repository is not a page', async () => {
    const w1 = word();
    await write(TEAM_IDS.Engineering, `memory/${w1}.md`, `secret ${w1}`, nadia);
    expect((await find(rafi, w1, '&scope=pages')).pages).toEqual([]);
  });
});

describe('saved searches', () => {
  const save = (who: typeof nadia, name: string, query: string): Promise<ApiResult> => w.call(who, 'POST', '/api/search/saved', { name, query });
  const list = async (who: typeof nadia): Promise<SavedSearch[]> => ok<{ items: SavedSearch[] }>(await w.call(who, 'GET', '/api/search/saved')).items;

  it('are the person\'s own: saved, listed, run again, removed; nobody else sees or removes them', async () => {
    const name = `Releases ${word()}`;
    const created = SavedSearch.parse(ok(await save(nadia, name, 'from:rafi in:releases has:link'), 201));
    expect(created).toMatchObject({ name, query: 'from:rafi in:releases has:link' });
    expect((await list(nadia)).map((s) => s.id)).toContain(created.id);
    for (const who of [rafi, priya, omar, sameera, lena]) {
      expect((await list(who)).map((s) => s.id), who.key).not.toContain(created.id);
      expect(ok<{ removed: boolean }>(await w.call(who, 'DELETE', `/api/search/saved/${created.id}`)).removed, who.key).toBe(false);
    }
    expect((await list(nadia)).map((s) => s.id)).toContain(created.id);
    expect(ok<{ removed: boolean }>(await w.call(nadia, 'DELETE', `/api/search/saved/${created.id}`)).removed).toBe(true);
    expect((await list(nadia)).map((s) => s.id)).not.toContain(created.id);
  });

  it('one name per person (any letter case), and each person has their own list', async () => {
    const name = `Mine ${word()}`;
    ok(await save(nadia, name, 'rollback'), 201);
    expect((await save(nadia, name.toUpperCase(), 'other words')).status).toBe(409);
    ok(await save(rafi, name, 'rollback'), 201);
  });

  it('validates the name and the text, and is refused without a sign-in', async () => {
    expect((await save(nadia, '', 'rollback')).status).toBe(400);
    expect((await save(nadia, 'x'.repeat(81), 'rollback')).status).toBe(400);
    expect((await save(nadia, 'ok', 'a')).status).toBe(400);
    expect((await save(nadia, 'ok\u0000', 'rollback')).status).toBe(400);
    expect((await save(nadia, 'ok', 'roll\u0000back')).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/search/saved', { name: 'ok', query: 'rollback', extra: 1 })).status).toBe(400);
    expect((await w.call(null, 'GET', '/api/search/saved')).status).toBe(401);
  });

  it('the stored text runs as the reader: a private channel named in it finds nothing once access is gone', async () => {
    const w1 = word();
    const secret = await privateChannel([rafi]);
    const channelName = (await w.system((tx) => tx.query<{ name: string }>('SELECT name FROM app.channels WHERE id = $1', [secret]))).rows[0]!.name;
    await post(rafi, secret, `${w1} budget`);
    const q = `in:${channelName} ${w1}`;
    ok(await save(rafi, `Budget ${word()}`, q), 201);
    expect((await find(rafi, q)).messages).toHaveLength(1);
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: omar.personId }));
    ok(await w.call(omar, 'DELETE', `/api/channels/${secret}/members/${rafi.personId}`));
    expect((await find(rafi, q)).messages).toEqual([]);
  });

  it('keeps at most 50', async () => {
    const who = priya;
    const have = (await list(who)).length;
    for (let i = have; i < 50; i++) ok(await save(who, `Cap ${i} ${word()}`, 'rollback'), 201);
    expect((await save(who, 'one too many', 'rollback')).status).toBe(409);
    expect(await list(who)).toHaveLength(50);
  });
});

describe('the capabilities keep their shape', () => {
  it('support channel and the other team are untouched by filters: Sameera from:nadia in:dev finds nothing', async () => {
    const w1 = word();
    await post(nadia, dev, `${w1} eng`);
    await post(sameera, supportChannel, `${w1} support`);
    const res = await find(sameera, `from:nadia in:dev ${w1}`);
    expect(res.messages).toEqual([]);
    expect(res.unmatched).toEqual(expect.arrayContaining(['in:dev']));
  });
});
