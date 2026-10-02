import { type APIRequestContext } from '@playwright/test';
import { personas, SEED_IDS, type Persona } from '@manythreads/test-utils';
import { expect, signedIn, test, useIsolatedStack } from '../support/isolated.ts';

/**
 * Seed v3 over HTTP, as signed-in people (PLAN P3-15; criteria 8 and 10): every persona sees the conversations the story gives them
 * and nothing else. The stack is seeded with `seedWorld(db, { content: true })`, the same call `pnpm seed --demo` makes.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'content' });

const sessions = new Map<string, APIRequestContext>();
async function as(playwright: Parameters<typeof signedIn>[0], p: Persona): Promise<APIRequestContext> {
  const have = sessions.get(p.key);
  if (have) return have;
  const ctx = await signedIn(playwright, await iso.start(), p.email);
  sessions.set(p.key, ctx);
  return ctx;
}
test.afterAll(async () => {
  for (const ctx of sessions.values()) await ctx.dispose();
});

interface Directory {
  groups: { name: string; channels: { id: string; name: string; unread?: number; unreadCount?: number }[] }[];
}
const names = async (ctx: APIRequestContext, team: string): Promise<string[]> =>
  ((await (await ctx.get(`/api/teams/${team}/channels`)).json()) as Directory).groups.flatMap((g) => g.channels.map((c) => c.name));

test('each team has its template channels exactly once, with the seed ids; Customer support has four', async ({ playwright }) => {
  const omar = await as(playwright, personas.omar);
  const eng = await names(omar, 'engineering');
  expect([...eng].sort()).toEqual(['alerts', 'dev', 'eng-leads', 'general', 'incidents', 'load-test', 'releases', 'standup']);
  const support = await names(await as(playwright, personas.sameera), 'customer-support');
  expect([...support].sort()).toEqual(['enquiries', 'escalations', 'kb-updates', 'support']);
  const marketing = await names(await as(playwright, personas.tariq), 'marketing');
  expect([...marketing].sort()).toEqual(['analytics', 'brand', 'campaigns', 'content', 'social']);
  // the directory request is also what applies a template: asking again, or five at once, creates nothing new
  await Promise.all(Array.from({ length: 5 }, () => (as(playwright, personas.sameera).then((c) => c.get('/api/teams/customer-support/channels')))));
  expect([...(await names(await as(playwright, personas.sameera), 'customer-support'))].sort()).toEqual(['enquiries', 'escalations', 'kb-updates', 'support']);
  const stack = await iso.start();
  const rows = await stack.sql<{ name: string; n: number }>("SELECT name, count(*)::int AS n FROM app.channels WHERE kind = 'channel' GROUP BY name HAVING count(*) > 1");
  expect(rows).toEqual([]);
  const dev = (await (await omar.get('/api/teams/engineering/channels')).json()) as Directory;
  expect(dev.groups.flatMap((g) => g.channels).find((c) => c.name === 'dev')?.id).toBe(SEED_IDS.channels['engineering/dev']);
});

test('#dev holds about forty messages and the Deploy plan thread has twelve replies from Nadia, Rafi and Omar', async ({ playwright }) => {
  const nadia = await as(playwright, personas.nadia);
  const dev = SEED_IDS.channels['engineering/dev'];
  const page = (await (await nadia.get(`/api/channels/${dev}/messages?limit=200`)).json()) as {
    items: { id: string; body: string; replyCount: number; attachments?: { name: string }[]; reactions: { emoji: string; count: number }[] }[];
  };
  expect(page.items.length).toBeGreaterThanOrEqual(38);
  expect(page.items.length).toBeLessThanOrEqual(46);
  const root = page.items.find((m) => m.body.startsWith('**Deploy plan'));
  expect(root).toBeTruthy();
  expect(root?.replyCount).toBe(12);
  expect(root?.attachments?.map((a) => a.name)).toEqual(['deploy-plan-v2.14.pdf']);
  expect(root?.reactions.map((r) => r.emoji).sort()).toEqual(['✅', '👍']);
  const thread = (await (await nadia.get(`/api/threads/${root?.id}?limit=50`)).json()) as { replies: { items: { authorId: string }[] }; thread: { replyCount: number; followed: boolean } };
  expect(thread.thread).toMatchObject({ replyCount: 12, followed: true });
  expect(new Set(thread.replies.items.map((r) => r.authorId))).toEqual(new Set([personas.nadia.actorId, personas.rafi.actorId, personas.omar.actorId]));
  const pdf = await nadia.get(`/api/files/${SEED_IDS.file}/content`);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('the private channel is Omar and Nadia; the DM is Nadia and Rafi; #load-test pages through 5,000 messages', async ({ playwright }) => {
  const leads = SEED_IDS.channels['engineering/eng-leads'];
  for (const [p, status] of [[personas.omar, 200], [personas.nadia, 200], [personas.rafi, 403], [personas.priya, 403], [personas.sameera, 403]] as const) {
    expect((await (await as(playwright, p)).get(`/api/channels/${leads}/messages?limit=1`)).status(), p.key).toBe(status);
  }
  const nadia = await as(playwright, personas.nadia);
  const dms = (await (await nadia.get('/api/dms')).json()) as { items: { channel: { id: string }; unreadCount: number; lastMessage: { preview: string } }[] };
  expect(dms.items).toHaveLength(1);
  expect(dms.items[0]).toMatchObject({ channel: { id: SEED_IDS.dm }, unreadCount: 1, lastMessage: { preview: 'Check the rota?' } });
  expect((await (await as(playwright, personas.omar)).get(`/api/channels/${SEED_IDS.dm}/messages`)).status()).toBe(403);

  const load = SEED_IDS.channels['engineering/load-test'];
  const rafi = await as(playwright, personas.rafi);
  let seen = 0;
  let before: string | null = null;
  for (let guard = 0; guard < 40; guard += 1) {
    const res = await rafi.get(`/api/channels/${load}/messages`, { params: { limit: '200', ...(before ? { before } : {}) } });
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    seen += body.items.length;
    if (!body.nextCursor) break;
    before = body.nextCursor;
  }
  expect(seen).toBe(5000);
});

test('Lena sees only #releases, with its announcements, and cannot post, search elsewhere or open a DM (criterion 8)', async ({ playwright }) => {
  const lena = await as(playwright, personas.lena);
  expect(await names(lena, 'engineering')).toEqual(['releases']);
  for (const team of ['customer-support', 'marketing']) expect(await names(lena, team)).toEqual(['releases']); // a guest's directory ignores the slug
  const releases = SEED_IDS.channels['engineering/releases'];
  const list = (await (await lena.get(`/api/channels/${releases}/messages?limit=50`)).json()) as { items: { body: string }[] };
  expect(list.items.length).toBeGreaterThanOrEqual(20);
  expect(list.items.some((m) => m.body.includes('v2.14.0'))).toBe(true);
  for (const ref of ['engineering/dev', 'engineering/general', 'engineering/eng-leads', 'engineering/load-test', 'customer-support/support', 'marketing/content'] as const) {
    expect((await lena.get(`/api/channels/${SEED_IDS.channels[ref]}/messages`)).status(), ref).toBe(403);
  }
  expect((await lena.get(`/api/channels/${SEED_IDS.dm}/messages`)).status()).toBe(403);
  // search as Lena: the word is in #dev and #incidents too, but only #releases can answer
  const search = (await (await lena.get('/api/search?q=rollback')).json()) as { messages: { channel: { id: string } }[] };
  expect(search.messages.length).toBeGreaterThan(0);
  for (const hit of search.messages) expect(hit.channel.id).toBe(releases);
});

test('Rafi has an unread mention and thread reply in the bell; Priya sees #dev but not #eng-leads; Sameera sees no Engineering', async ({ playwright }) => {
  const rafi = await as(playwright, personas.rafi);
  const summary = (await (await rafi.get('/api/notifications/summary')).json()) as { unreadCount: number };
  expect(summary.unreadCount).toBe(2);
  const inbox = (await (await rafi.get('/api/notifications?unread=true')).json()) as { items: { kind: string; actorName: string; preview: string }[] };
  expect(inbox.items.map((i) => i.kind).sort()).toEqual(['mention', 'reply']);
  expect(inbox.items.find((i) => i.kind === 'mention')?.preview).toContain('@rafi');
  const priya = await names(await as(playwright, personas.priya), 'engineering');
  expect(priya).toContain('dev');
  expect(priya).not.toContain('eng-leads');
  expect(await names(await as(playwright, personas.sameera), 'engineering')).toEqual([]);
  const inboxTab = (await (await rafi.get('/api/teams/engineering/threads?tab=unread')).json()) as { items: { title: string; unreadCount: number }[] };
  expect(inboxTab.items).toEqual([expect.objectContaining({ unreadCount: 1 })]);
});
