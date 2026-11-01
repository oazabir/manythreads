import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOB_DEPS } from '../src/jobs.ts';
import type { SafeFetchDeps } from '../src/safe-fetch.ts';
import { createWorld, ensureChannels, eventually, personas, drained, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya, tariq } = personas;

// The whole path on a real server: a posted message queues the sync job, the job queues one fetch job per link, the fetch is refused for a private
// address (and recorded), cards made by the system are read, proxied and removed through the routes, and the settings are admin-only. No outside
// network: every address used here is a literal private address (refused before any socket opens), a name that cannot resolve, or a made-up public
// name that the test's own resolver points at a local fake site (see `fakeSite`).
//
// The feature is off by default under NODE_ENV=test (MANYTHREADS_LINK_PREVIEW), so this file switches it on for its own run and puts it back after.

let w: World;
let dev = '';
let privateChannel = '';
let marketing = '';
const savedSwitch = process.env['MANYTHREADS_LINK_PREVIEW'];
const savedFetchDeps = DEFAULT_JOB_DEPS.fetchDeps;
let site: Server;
let siteHits: string[] = [];
const sitePage = (): string => '<meta property="og:title" content="Fake title"><meta property="og:description" content="Fake description"><meta property="og:site_name" content="Totally Official Bank">';
beforeAll(async () => {
  process.env['MANYTHREADS_LINK_PREVIEW'] = 'on';
  site = createServer((req, res) => {
    siteHits.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(sitePage());
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const sitePort = (site.address() as AddressInfo).port;
  const fakeSite: SafeFetchDeps = {
    resolve: async (host) => {
      if (host.endsWith('.fake.example')) return [{ address: '93.184.216.34', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    dial: () => ({ host: '127.0.0.1', port: sitePort }),
  };
  // The server runs in this process and reads the same module, so the plugin's jobs use the fake resolver from here on. If this were ever not so,
  // the first test of "a card made by the fetch job" would fail loudly instead of reaching the real network (no name here resolves for real).
  DEFAULT_JOB_DEPS.fetchDeps = fakeSite;
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  const created = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'lp-private', private: true });
  expect(created.status).toBe(201);
  privateChannel = created.body.channel.id;
  const mkt = await w.call<{ channel: { id: string } }>(tariq, 'POST', '/api/teams/marketing/channels', { name: 'lp-marketing' });
  expect(mkt.status).toBe(201);
  marketing = mkt.body.channel.id;
}, 180_000);
afterAll(async () => {
  DEFAULT_JOB_DEPS.fetchDeps = savedFetchDeps;
  if (savedSwitch === undefined) delete process.env['MANYTHREADS_LINK_PREVIEW'];
  else process.env['MANYTHREADS_LINK_PREVIEW'] = savedSwitch;
  await w?.close();
  await new Promise<void>((resolve) => {
    site?.closeAllConnections();
    site?.close(() => resolve());
  });
});
beforeEach(() => {
  DEFAULT_JOB_DEPS.budget.reset();
  DEFAULT_JOB_DEPS.breaker.reset();
  siteHits = [];
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const cardsOfMessage = (messageId: string) =>
  w.system(async (tx) => (await tx.query<{ id: string; url: string; host: string; site_name: string | null }>('SELECT id, url, host, site_name FROM app.link_previews WHERE message_id = $1 AND removed_at IS NULL', [messageId])).rows);
const setRules = (rules: { enabled?: boolean; allow?: string[]; deny?: string[] }) =>
  w.call(omar, 'PUT', '/api/admin/link-previews', { enabled: true, allow: [], deny: [], ...rules });

const post = async (who: Persona, channelId: string, body: string): Promise<string> => {
  const res = await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await drained(w); // the job queued for the new message has run: a card the test inserts by hand next is not swept as one whose link is gone
  return res.body.id;
};

const addCard = (channelId: string, messageId: string, url: string, image: Buffer | null = null): Promise<string> =>
  w.system(async (tx) => {
    let imageId: string | null = null;
    if (image) {
      imageId = (await tx.query<{ id: string }>("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2) RETURNING id", [omar.workspaceId, image])).rows[0]!.id;
    }
    return (
      await tx.query<{ id: string }>(
        "INSERT INTO app.link_previews (workspace_id, channel_id, message_id, url, host, title, description, site_name, image_id) VALUES ($1, $2, $3, $4, 'a.example', 'A title', 'A description', 'Site', $5) RETURNING id",
        [omar.workspaceId, channelId, messageId, url, imageId],
      )
    ).rows[0]!.id;
  });

interface Card {
  id: string;
  messageId: string;
  title: string | null;
  hasImage: boolean;
  canRemove: boolean;
  url: string;
}
interface Listed {
  items: Card[];
  pending: string[];
  enabled: boolean;
}
const list = (who: Persona, channelId: string, messageIds: string[]) =>
  w.call<Listed>(who, 'GET', `/api/channels/${channelId}/link-previews?messageIds=${messageIds.join(',')}`);

describe('the fetch path', () => {
  it('a link to a private address makes no card, and the refusal is remembered', async () => {
    const id = await post(nadia, dev, 'look at http://127.0.0.1/admin and http://169.254.169.254/latest/meta-data/');
    await drained(w);
    // both refusals are remembered for an hour, as "blocked", with the reason
    const rows = await eventually(async () => {
      const found = await w.system(async (tx) => (await tx.query<{ url: string; status: string; reason: string }>("SELECT url, status, reason FROM app.link_preview_cache WHERE url LIKE 'http://127.0.0.1/%' OR url LIKE 'http://169.254.169.254/%' ORDER BY url")).rows);
      return found.length === 2 ? found : undefined;
    });
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ['blocked', 'blocked_address'],
      ['blocked', 'blocked_address'],
    ]);
    expect((await list(nadia, dev, [id])).body.items).toEqual([]);
  });

  it('a message with no link queues nothing', async () => {
    const before = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'link-preview.fetch'")).rows[0]!.n);
    await post(nadia, dev, 'just words, no links');
    await drained(w);
    const after = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'link-preview.fetch'")).rows[0]!.n);
    expect(after).toBe(before);
  });
});

describe('reading cards', () => {
  it('lists the cards of the asked messages, with canRemove only for the author', async () => {
    const mine = await post(nadia, dev, 'plain words');
    const theirs = await post(rafi, dev, 'other words');
    const c1 = await addCard(dev, mine, 'https://a.example/1');
    await addCard(dev, theirs, 'https://a.example/2');
    const asNadia = (await list(nadia, dev, [mine, theirs])).body.items;
    expect(asNadia.map((c) => c.url).sort()).toEqual(['https://a.example/1', 'https://a.example/2']);
    expect(asNadia.find((c) => c.id === c1)?.canRemove).toBe(true);
    expect(asNadia.find((c) => c.id !== c1)?.canRemove).toBe(false);
    expect(asNadia[0]).not.toHaveProperty('imageUrl');
  });

  it('answers 403 for a channel the caller cannot read, and 400 for a bad list', async () => {
    const m = await post(omar, privateChannel, 'secret words');
    await addCard(privateChannel, m, 'https://a.example/private');
    expect((await list(nadia, privateChannel, [m])).status).toBe(403);
    expect((await list(omar, privateChannel, [m])).body.items).toHaveLength(1);
    expect((await w.call(nadia, 'GET', `/api/channels/${dev}/link-previews?messageIds=not-an-id`)).status).toBe(400);
    expect((await w.call(nadia, 'GET', `/api/channels/${dev}/link-previews`)).status).toBe(400);
  });

  it('the per-message route returns the same cards', async () => {
    const m = await post(nadia, dev, 'words');
    await addCard(dev, m, 'https://a.example/one');
    const res = await w.call<{ items: Card[] }>(rafi, 'GET', `/api/channels/${dev}/messages/${m}/link-previews`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('a deleted message shows no card', async () => {
    const m = await post(nadia, dev, 'to delete');
    await addCard(dev, m, 'https://a.example/del');
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [m]));
    expect((await list(nadia, dev, [m])).body.items).toEqual([]);
  });
});

describe('the picture proxy', () => {
  const fetchImage = (who: Persona | null, cardId: string) =>
    fetch(`${w.server.url}/api/link-previews/${cardId}/image`, {
      headers: who ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) } : {},
    });

  it('serves the stored bytes with headers that stop a browser from guessing', async () => {
    const m = await post(nadia, dev, 'with a picture');
    const card = await addCard(dev, m, 'https://a.example/pic', PNG);
    const res = await fetchImage(rafi, card);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // the picture is not kept without asking again: access is decided on every request (a removed card or a new rule takes effect at once)
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await list(rafi, dev, [m])).body.items[0]?.hasImage).toBe(true);
  });

  it('refuses a caller who cannot read the channel, and anybody not signed in', async () => {
    const m = await post(omar, privateChannel, 'private picture');
    const card = await addCard(privateChannel, m, 'https://a.example/ppic', PNG);
    expect((await fetchImage(nadia, card)).status).toBe(404);
    expect((await fetchImage(null, card)).status).toBe(401);
    expect((await fetchImage(omar, card)).status).toBe(200);
  });

  it('never serves bytes that are no longer a picture, even from a stored row', async () => {
    const m = await post(nadia, dev, 'tampered');
    const card = await addCard(dev, m, 'https://a.example/tampered', PNG);
    // the CHECK on the type is not enough on its own: the route sniffs again
    await w.system((tx) =>
      tx.query('UPDATE app.link_preview_images SET bytes = $2 WHERE id = (SELECT image_id FROM app.link_previews WHERE id = $1)', [card, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')]),
    );
    expect((await fetchImage(rafi, card)).status).toBe(404);
  });

  it('a removed card has no picture', async () => {
    const m = await post(nadia, dev, 'removed picture');
    const card = await addCard(dev, m, 'https://a.example/rp', PNG);
    expect((await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${m}/link-previews/${card}`)).status).toBe(200);
    expect((await fetchImage(rafi, card)).status).toBe(404);
  });
});

describe('removing a card', () => {
  it('the author may; the card is gone from the list afterwards and stays gone', async () => {
    const m = await post(nadia, dev, 'remove me');
    const card = await addCard(dev, m, 'https://a.example/rm');
    const path = `/api/channels/${dev}/messages/${m}/link-previews/${card}`;
    expect((await w.call(rafi, 'DELETE', path)).status).toBe(403); // another reader
    expect((await w.call(tariq, 'DELETE', path)).status).toBe(403); // the lead of another team, who cannot even read this channel
    expect((await w.call<{ removed: boolean }>(nadia, 'DELETE', path)).body.removed).toBe(true);
    expect((await w.call<{ removed: boolean }>(nadia, 'DELETE', path)).body.removed).toBe(false); // twice: nothing more to do
    expect((await list(rafi, dev, [m])).body.items).toEqual([]);
    // the tombstone stays, so editing the message does not bring the card back
    const rows = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.link_previews WHERE id = $1 AND removed_at IS NOT NULL', [card])).rows);
    expect(rows).toHaveLength(1);
  });

  it('a workspace admin may remove an abusive card on somebody else\'s message, and canRemove says so', async () => {
    const m = await post(nadia, dev, 'admin removes');
    const card = await addCard(dev, m, 'https://a.example/admin');
    expect((await list(omar, dev, [m])).body.items[0]?.canRemove).toBe(true);
    expect((await list(rafi, dev, [m])).body.items[0]?.canRemove).toBe(false);
    const res = await w.call<{ removed: boolean }>(omar, 'DELETE', `/api/channels/${dev}/messages/${m}/link-previews/${card}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.removed).toBe(true);
    const row = (await w.system(async (tx) => (await tx.query<{ removed_by: string }>('SELECT removed_by FROM app.link_previews WHERE id = $1', [card])).rows[0]))!;
    expect(row.removed_by).toBe(omar.actorId); // the one who removed it, not the author
  });

  it('the lead of the channel\'s team may, though neither the author nor an admin; a plain member may not', async () => {
    const m = await post(priya, marketing, 'lead removes');
    const card = await addCard(marketing, m, 'https://a.example/lead');
    const path = `/api/channels/${marketing}/messages/${m}/link-previews/${card}`;
    const other = await post(tariq, marketing, 'a lead is not the author of this one');
    const otherCard = await addCard(marketing, other, 'https://a.example/lead2');
    { const l = await list(tariq, marketing, [m]); console.error('DBGLIST', l.status, JSON.stringify(l.body), card); expect(l.body.items[0]?.canRemove).toBe(true); }
    expect((await w.call(priya, 'DELETE', `/api/channels/${marketing}/messages/${other}/link-previews/${otherCard}`)).status).toBe(403);
    { const r = await w.call<{ removed: boolean }>(tariq, 'DELETE', path); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.removed).toBe(true); }
  });

  it('answers 404 for a card that does not exist, or one under another message', async () => {
    const m = await post(nadia, dev, 'a');
    const other = await post(nadia, dev, 'b');
    const card = await addCard(dev, other, 'https://a.example/other');
    expect((await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${m}/link-previews/${card}`)).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${m}/link-previews/00000000-0000-7000-8000-000000000999`)).status).toBe(404);
  });

  it('answers 403 on a channel the caller cannot read', async () => {
    const m = await post(omar, privateChannel, 'x');
    const card = await addCard(privateChannel, m, 'https://a.example/px');
    expect((await w.call(nadia, 'DELETE', `/api/channels/${privateChannel}/messages/${m}/link-previews/${card}`)).status).toBe(403);
  });
});

describe('settings', () => {
  it('belong to workspace admins', async () => {
    expect((await w.call(nadia, 'GET', '/api/admin/link-previews')).status).toBe(403);
    expect((await w.call(nadia, 'PUT', '/api/admin/link-previews', { enabled: true, allow: [], deny: [] })).status).toBe(403);
    const first = await w.call<{ enabled: boolean; allow: string[]; deny: string[]; updatedAt: string | null }>(omar, 'GET', '/api/admin/link-previews');
    expect(first.body).toMatchObject({ enabled: true, allow: [], deny: [], updatedAt: null });
    const set = await w.call<{ deny: string[]; updatedAt: string | null }>(omar, 'PUT', '/api/admin/link-previews', {
      enabled: true,
      allow: [],
      deny: ['https://Evil.example/path', 'bad.example', 'evil.example'],
    });
    expect(set.status).toBe(200);
    expect(set.body.deny).toEqual(['bad.example', 'evil.example']);
    expect(set.body.updatedAt).not.toBeNull();
  });

  it('refuse a list entry that is not a host name, and an unknown field', async () => {
    expect((await w.call(omar, 'PUT', '/api/admin/link-previews', { enabled: true, allow: ['not a host!'], deny: [] })).status).toBe(400);
    expect((await w.call(omar, 'PUT', '/api/admin/link-previews', { enabled: true, allow: [], deny: [], extra: 1 })).status).toBe(400);
  });

  it('a denied host gets no fetch job at all', async () => {
    await w.call(omar, 'PUT', '/api/admin/link-previews', { enabled: true, allow: [], deny: ['denied.example'] });
    const before = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.link_preview_cache WHERE url LIKE '%denied.example%'")).rows[0]!.n);
    await post(nadia, dev, 'see https://denied.example/page');
    await drained(w);
    const after = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.link_preview_cache WHERE url LIKE '%denied.example%'")).rows[0]!.n);
    expect(after).toBe(before);
  });

  it('switching previews off takes the cards away (the sweep the change queues), and an edit afterwards brings none back', async () => {
    const m = await post(nadia, dev, 'see https://a.example/off');
    await addCard(dev, m, 'https://a.example/off');
    await w.call(omar, 'PUT', '/api/admin/link-previews', { enabled: false, allow: [], deny: [] });
    const edited = await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${m}`, { body: 'see https://a.example/off again' });
    expect(edited.status).toBe(200);
    await drained(w);
    await eventually(async () => ((await list(nadia, dev, [m])).body.items.length === 0 ? true : undefined));
  });
});

describe('the picture revalidates', () => {
  const fetchImage = (who: Persona, cardId: string, headers: Record<string, string> = {}) =>
    fetch(`${w.server.url}/api/link-previews/${cardId}/image`, {
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), ...headers },
    });

  it('answers 304 to a browser that has the current picture, and 200 again once the bytes change', async () => {
    await setRules({});
    const m = await post(nadia, dev, 'etag picture');
    const card = await addCard(dev, m, 'https://a.example/etag', PNG);
    const first = await fetchImage(rafi, card);
    const etag = first.headers.get('etag') as string;
    const again = await fetchImage(rafi, card, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    await w.system((tx) => tx.query('UPDATE app.link_preview_images SET bytes = $2 WHERE id = (SELECT image_id FROM app.link_previews WHERE id = $1)', [card, Buffer.concat([PNG, Buffer.from([1])])]));
    expect((await fetchImage(rafi, card, { 'if-none-match': etag })).status).toBe(200);
  });

  it('a 304 is not given for a card the caller may no longer see', async () => {
    const m = await post(omar, privateChannel, 'private etag');
    const card = await addCard(privateChannel, m, 'https://a.example/petag', PNG);
    const etag = (await fetchImage(omar, card)).headers.get('etag') as string;
    expect((await fetchImage(nadia, card, { 'if-none-match': etag })).status).toBe(404);
  });
});

describe('a card made by the fetch job', () => {
  it('shows the real host, and a card whose site names itself something else keeps the real host beside it', async () => {
    await setRules({});
    const id = await post(nadia, dev, 'read http://card-one.fake.example/post');
    const [card] = await eventually(async () => {
      const rows = await cardsOfMessage(id);
      return rows.length > 0 ? rows : undefined;
    });
    expect(card?.host).toBe('card-one.fake.example'); // the host comes from the address, never from the page
    expect(card?.site_name).toBe('Totally Official Bank'); // the page's own claim is kept, and the client shows it second
    const listed = (await list(rafi, dev, [id])).body.items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ host: 'card-one.fake.example', title: 'Fake title' });
  });

  it('an edit right after posting that removes the link leaves no card (the job looks at the message again before it writes)', async () => {
    await setRules({});
    const id = await post(nadia, dev, 'wait for http://slow-edit.fake.example/page');
    const edited = await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'no link any more' });
    expect(edited.status).toBe(200);
    await drained(w);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await cardsOfMessage(id)).toEqual([]);
  });

  it('a read link is not charged to the budget twice: the second message with the same address reuses the kept read', async () => {
    await setRules({});
    const first = await post(nadia, dev, 'one http://reuse.fake.example/same');
    await eventually(async () => ((await cardsOfMessage(first)).length > 0 ? true : undefined));
    const hitsAfterFirst = siteHits.filter((h) => h.startsWith('reuse.fake.example')).length;
    const second = await post(rafi, dev, 'two http://reuse.fake.example/same');
    await eventually(async () => ((await cardsOfMessage(second)).length > 0 ? true : undefined));
    expect(siteHits.filter((h) => h.startsWith('reuse.fake.example')).length).toBe(hitsAfterFirst);
  });
});

describe('rules are not left behind', () => {
  it('denying a site removes its existing cards and kept reads, and the routes stop showing them at once', async () => {
    await setRules({});
    const id = await post(nadia, dev, 'see http://retro.fake.example/a');
    await eventually(async () => ((await cardsOfMessage(id)).length > 0 ? true : undefined));
    const card = (await cardsOfMessage(id))[0]!;
    const withImage = await addCard(dev, id, 'https://retro-image.fake.example/p', PNG);
    expect((await list(rafi, dev, [id])).body.items.length).toBeGreaterThanOrEqual(2);

    expect((await setRules({ deny: ['fake.example'] })).status).toBe(200);
    // at once, before the sweep runs: a card whose site is now denied is neither listed nor does its picture load
    expect((await list(rafi, dev, [id])).body.items).toEqual([]);
    const res = await fetch(`${w.server.url}/api/link-previews/${withImage}/image`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: rafi.actorId, workspaceId: rafi.workspaceId }) } });
    expect(res.status).toBe(404);
    // and then the sweep takes the rows themselves away
    await eventually(async () => {
      const left = await w.system(async (tx) => ({
        cards: (await tx.query('SELECT 1 FROM app.link_previews WHERE id = ANY ($1::uuid[]) AND removed_at IS NULL', [[card.id, withImage]])).rows.length,
        cache: (await tx.query("SELECT 1 FROM app.link_preview_cache WHERE url LIKE '%retro%'")).rows.length,
      }));
      return left.cards === 0 && left.cache === 0 ? true : undefined;
    });
    await setRules({});
  });

  it('switching previews off removes every card, and the list says the feature is off so the client keeps no room', async () => {
    await setRules({});
    const id = await post(nadia, dev, 'see http://off.fake.example/a');
    await eventually(async () => ((await cardsOfMessage(id)).length > 0 ? true : undefined));
    await setRules({ enabled: false });
    const listed = await list(rafi, dev, [id]);
    expect(listed.body).toMatchObject({ items: [], pending: [], enabled: false });
    await eventually(async () => ((await cardsOfMessage(id)).length === 0 ? true : undefined));
    await setRules({});
  });

  it('a cached read still passes the rules before it becomes a card', async () => {
    await setRules({});
    const first = await post(nadia, dev, 'one http://kept.fake.example/x');
    await eventually(async () => ((await cardsOfMessage(first)).length > 0 ? true : undefined));
    await setRules({ deny: ['kept.fake.example'] });
    await drained(w);
    const second = await post(rafi, dev, 'two http://kept.fake.example/x');
    await drained(w);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await cardsOfMessage(second)).toEqual([]);
    await setRules({});
  });
});

describe('the list says what is still coming', () => {
  it('a message with an allowed link and no card yet is pending; one with no link or a denied link is not', async () => {
    await setRules({});
    // stop the job from running by taking the switch off for the server while the message is posted
    process.env['MANYTHREADS_LINK_PREVIEW'] = 'off';
    let plain = '';
    let linked = '';
    try {
      linked = await post(nadia, dev, 'later http://pending.fake.example/a');
      plain = await post(nadia, dev, 'no link');
      await drained(w);
    } finally {
      process.env['MANYTHREADS_LINK_PREVIEW'] = 'on';
    }
    const res = (await list(rafi, dev, [linked, plain])).body;
    expect(res.enabled).toBe(true);
    expect(res.pending).toEqual([linked]);
  });

  it('is empty for a message older than the window, so the client stops waiting', async () => {
    const old = await post(nadia, dev, 'old http://old.fake.example/a');
    await drained(w);
    await w.system((tx) => tx.query("UPDATE app.messages SET created_at = now() - interval '10 minutes' WHERE id = $1", [old]));
    await w.system((tx) => tx.query("DELETE FROM app.link_previews WHERE message_id = $1", [old]));
    expect((await list(rafi, dev, [old])).body.pending).toEqual([]);
  });
});

describe('what the jobs leave alone', () => {
  it('a removed card (tombstone) survives an edit that keeps its link, and is not made again', async () => {
    await setRules({});
    const id = await post(nadia, dev, 'keep http://tomb.fake.example/a');
    await eventually(async () => ((await cardsOfMessage(id)).length > 0 ? true : undefined));
    const card = (await cardsOfMessage(id))[0]!;
    expect((await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}/link-previews/${card.id}`)).status).toBe(200);
    await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'keep http://tomb.fake.example/a and more' });
    await drained(w);
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await w.system(async (tx) => (await tx.query('SELECT removed_at FROM app.link_previews WHERE id = $1', [card.id])).rows);
    expect(rows).toHaveLength(1); // the tombstone was not pruned
    expect(await cardsOfMessage(id)).toEqual([]);
  });

  it('with the switch off in the server environment, a posted link queues no job at all', async () => {
    await setRules({});
    process.env['MANYTHREADS_LINK_PREVIEW'] = 'off';
    try {
      const before = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue LIKE 'link-preview.%' AND queue <> 'link-preview.purge'")).rows[0]!.n);
      await post(nadia, dev, 'ignored http://switch-off.fake.example/a');
      await drained(w);
      const after = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.jobs WHERE queue LIKE 'link-preview.%' AND queue <> 'link-preview.purge'")).rows[0]!.n);
      expect(after).toBe(before);
    } finally {
      process.env['MANYTHREADS_LINK_PREVIEW'] = 'on';
    }
  });
});

describe('the rules are written to the audit log', () => {
  it('a change is recorded once with the numbers, a save that changes nothing is not', async () => {
    const audited = async (): Promise<{ category: string; actor_id: string | null; reason: string | null }[]> =>
      (await w.system((tx) => tx.query<{ category: string; actor_id: string | null; reason: string | null }>("SELECT category, actor_id, reason FROM app.audit_events WHERE action = 'linkpreview.settings_changed' ORDER BY created_at, id"))).rows;
    await setRules({}); // start from the empty rules, whatever the tests before left
    await drained(w);
    const before = (await audited()).length;
    await setRules({ deny: ['audit-one.example'] });
    await drained(w);
    const rows = await eventually(async () => {
      const found = await audited();
      return found.length > before ? found : undefined;
    });
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({ category: 'settings', actor_id: omar.personId });
    expect(last.reason).toMatch(/blocked site/);
    const count = rows.length;
    await setRules({ deny: ['audit-one.example'] }); // the same again
    await drained(w);
    expect((await audited()).length).toBe(count);
    await setRules({});
  });

  it('the settings route stays admin-only to read, though every member can read the rows', async () => {
    expect((await w.call(nadia, 'GET', '/api/admin/link-previews')).status).toBe(403);
    expect((await w.call(omar, 'GET', '/api/admin/link-previews')).status).toBe(200);
  });
});
