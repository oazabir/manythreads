import { randomUUID } from 'node:crypto';
import { createEntityLinkService, withActor } from '@manythreads/kernel';
import { ListLinksResponse, type EntityRef } from '@manythreads/shared';
import { createPersonas, personaActor, personas, startTestServer, TEAM_IDS, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { nadia, priya, sameera, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let server: TestServer;
let links: ReturnType<typeof createEntityLinkService>;
/** Entities by id: `team` is the team whose members may see it (what an RLS-filtered lookup would answer). */
const known = new Map<string, { team: string; title: string }>();

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  links = createEntityLinkService({ resolvers: server.host.registries.entityResolvers, plugin: 'test' });
  // Stand-ins for the owning plugins: a resolver answers from its own RLS-filtered query, here "is the caller on the team".
  for (const type of ['message', 'page', 'task'] as const) {
    links.registerResolver(type, async (tx, id) => {
      const entity = known.get(id);
      if (!entity) return null;
      const mine = (await tx.query<{ ok: boolean }>('SELECT $1::uuid = ANY (app.readable_team_ids($2)) AS ok', [entity.team, 'read'])).rows[0]?.ok;
      return mine ? { title: entity.title, subtitle: type, href: `/${type}/${id}` } : null;
    });
  }
}, 120_000);
afterAll(async () => {
  await server?.close();
});

const call = async (who: Persona | null, path: string) => {
  const headers: Record<string, string> = {};
  if (who) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
  const res = await fetch(`${server.url}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
};
const entity = (type: EntityRef['type'], team: string, title: string): EntityRef => {
  const id = randomUUID();
  known.set(id, { team, title });
  return { type, id };
};
const link = (as: Persona, teamId: string, src: EntityRef, dst: EntityRef, kind = 'mentions') =>
  withActor(personaActor(as), (tx) => links.create(tx as never, { teamId, src, dst, kind }), { pool: server.pools.app });
const q = (ref: EntityRef, extra = '') => `/api/links?type=${ref.type}&id=${ref.id}${extra}`;

describe('GET /api/links', () => {
  it('needs a signed-in person and a valid type and id', async () => {
    const ref = entity('message', ENG, 'm');
    expect((await call(null, q(ref))).status).toBe(401);
    expect((await call(nadia, '/api/links?type=event&id=' + ref.id)).status).toBe(400);
    expect((await call(nadia, '/api/links?type=message&id=nope')).status).toBe(400);
    expect((await call(nadia, '/api/links?type=message')).status).toBe(400);
    expect((await call(nadia, q(ref, '&direction=sideways'))).status).toBe(400);
    expect((await call(nadia, q(ref, '&nope=1'))).status).toBe(400);
    expect((await call(nadia, q(ref, '&limit=0'))).status).toBe(400);
  });

  it('returns each link with the entity at the other end resolved, direction from the asked entity', async () => {
    const msg = entity('message', ENG, 'Deploy plan');
    const page = entity('page', ENG, 'Runbook');
    const task = entity('task', ENG, 'Fix rota');
    await link(nadia, ENG, msg, page, 'mentions');
    await link(nadia, ENG, task, msg, 'created_from');
    const res = await call(nadia, q(msg));
    expect(res.status).toBe(200);
    const { links: listed } = ListLinksResponse.parse(res.body);
    expect(listed.map((l) => [l.direction, l.link.kind, l.other.title, l.other.type])).toEqual([
      ['in', 'created_from', 'Fix rota', 'task'],
      ['out', 'mentions', 'Runbook', 'page'],
    ]);
    expect(listed[1]?.other).toEqual({ type: 'page', id: page.id, title: 'Runbook', subtitle: 'page', href: `/page/${page.id}` });
    const out = ListLinksResponse.parse((await call(nadia, q(msg, '&direction=out&kind=mentions'))).body);
    expect(out.links).toHaveLength(1);
    expect(ListLinksResponse.parse((await call(nadia, q(msg, '&limit=1'))).body).links).toHaveLength(1);
  });

  it("leaves out a link whose other end the caller can't see, and every link of an entity they can't see", async () => {
    const msg = entity('message', ENG, 'Launch thread');
    const visible = entity('page', ENG, 'Plan');
    const secret = entity('page', MKT, 'Campaign brief'); // Priya is on both teams, Nadia only on Engineering
    await link(priya, ENG, msg, visible);
    await link(priya, ENG, msg, secret, 'related');
    const seenBy = async (p: Persona, ref: EntityRef) => ListLinksResponse.parse((await call(p, q(ref))).body).links.map((l) => l.other.title).sort();
    expect(await seenBy(priya, msg)).toEqual(['Campaign brief', 'Plan']);
    expect(await seenBy(nadia, msg)).toEqual(['Plan']);
    // Sameera is not on the team: no links, and no clue that any exist
    expect(await seenBy(sameera, msg)).toEqual([]);
    // Tariq is on Marketing only: he cannot see the Engineering message, so its links stay hidden even though the page is his team's
    expect(await seenBy(tariq, msg)).toEqual([]);
    expect(await seenBy(tariq, secret)).toEqual([]);
    // an entity nobody knows
    expect(await seenBy(nadia, { type: 'message', id: randomUUID() })).toEqual([]);
  });

  it('a type without a resolver cannot be listed', async () => {
    const bot: EntityRef = { type: 'bot', id: randomUUID() };
    expect(ListLinksResponse.parse((await call(nadia, q(bot))).body).links).toEqual([]);
  });
});
