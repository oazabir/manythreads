import { randomUUID } from 'node:crypto';
import { withActor } from '@manythreads/kernel';
import type { ActorId } from '@manythreads/shared';
import {
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  createPersonas,
  ownerSql,
  personas,
  startTestServer,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SPEC §8 / PLAN P6-10, the rules variant: twenty bots, one counter card. Each bot claims the card, adds one to the counter and releases
 * it; when every bot has had a turn the log must read 1 to 20 exactly, with no duplicate and no gap, and the card must never have two
 * owners. No model is called: claim, add and release are the same SQL doors the tools use.
 */
const { nadia } = personas;
const TEAM = TEAM_IDS.Engineering;
const BOTS = 20;

let server: TestServer;
const bots: { actorId: ActorId }[] = [];

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  for (let i = 0; i < BOTS; i++) {
    const botId = randomUUID();
    const actorId = randomUUID();
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $4, $4, 'automation', 'rules', 'team', $5, 'active')`,
      [botId, KAHF_WORKSPACE_ID, TEAM, `counter-${i}`, 'b'.repeat(64)],
    );
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, KAHF_WORKSPACE_ID, botId]);
    bots.push({ actorId: actorId as ActorId });
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [TEAM, actorId, KAHF_WORKSPACE_ID]);
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const call = async (who: { kind: 'person' | 'bot'; actorId: string }, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = {
    'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind, id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};

/** Add one to the shared counter as this bot (the team-scoped row every member may write). */
async function addOne(bot: { actorId: ActorId }): Promise<number> {
  return withActor(
    { kind: 'bot', id: bot.actorId, workspaceId: KAHF_WORKSPACE_ID },
    async (tx) => {
      const row = (
        await tx.query<{ value: number }>(
          `INSERT INTO app.scoped_kv (plugin, scope_type, scope_id, key, value)
           VALUES ('bench', 'team', $1, 'counter', '1'::jsonb)
           ON CONFLICT (plugin, scope_type, scope_id, key)
           DO UPDATE SET value = to_jsonb((app.scoped_kv.value)::text::int + 1), updated_at = now()
           RETURNING value`,
          [TEAM],
        )
      ).rows[0];
      return Number(row?.value ?? 0);
    },
    { pool: server.pools.app },
  );
}

describe('counting benchmark (rules variant)', () => {
  it('lets exactly one owner at a time and reads 1 to 20 with no duplicate or gap', async () => {
    const started = Date.now();
    const taskRes = await call({ kind: 'person', actorId: nadia.actorId }, 'POST', '/api/teams/engineering/tasks', { title: 'Counter', branch: 'bench/counter', kind: 'other' });
    expect(taskRes.status).toBe(201);
    const taskId = String((taskRes.body['task'] as Record<string, unknown>)['id']);
    const seen: number[] = [];

    // Round one: all twenty bots race for the card at the same moment. Exactly one wins.
    const race = await Promise.all(bots.map((b) => call({ kind: 'bot', actorId: b.actorId }, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`)));
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    expect(race.filter((r) => r.status === 409)).toHaveLength(BOTS - 1);

    // The winner of the race takes the first turn; then every other bot claims, adds one and releases, in turn.
    const winner = race.findIndex((r) => r.status === 200);
    seen.push(await addOne(bots[winner]!));
    expect((await call({ kind: 'bot', actorId: bots[winner]!.actorId }, 'POST', `/api/teams/engineering/tasks/${taskId}/release`)).status).toBe(200);
    for (const [i, bot] of bots.entries()) {
      if (i === winner) continue;
      let claimed = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const res = await call({ kind: 'bot', actorId: bot.actorId }, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`);
        if (res.status === 200) {
          claimed = true;
          break;
        }
        expect(res.status).toBe(409);
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(claimed, `bot ${i} never claimed the card`).toBe(true);
      seen.push(await addOne(bot));
      const released = await call({ kind: 'bot', actorId: bot.actorId }, 'POST', `/api/teams/engineering/tasks/${taskId}/release`);
      expect(released.status, `bot ${i} release: ${JSON.stringify(released.body)}`).toBe(200);
    }

    expect(seen).toHaveLength(BOTS);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: BOTS }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(BOTS);

    // The card's own history is the same story: twenty claims, twenty releases, one owner per moment.
    const events = await ownerSql(server.db.ownerUrl, 'SELECT type, actor_id FROM app.task_events WHERE task_id = $1 ORDER BY id', [taskId]);
    const claimed = events.filter((e) => e['type'] === 'claimed');
    const released = events.filter((e) => e['type'] === 'released');
    expect(claimed).toHaveLength(BOTS);
    expect(released).toHaveLength(BOTS);
    expect(new Set(claimed.map((e) => e['actor_id'])).size).toBe(BOTS);
    // No two claims of one actor, and every claim's actor released before anyone else claimed again: the log alternates.
    const types = events.map((e) => e['type']).filter((t) => t === 'claimed' || t === 'released');
    for (let i = 0; i < types.length; i++) expect(types[i]).toBe(i % 2 === 0 ? 'claimed' : 'released');

    const final = (await ownerSql(server.db.ownerUrl, `SELECT value FROM app.scoped_kv WHERE plugin = 'bench' AND scope_type = 'team' AND key = 'counter'`))[0]?.['value'];
    expect(Number(final)).toBe(BOTS);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
