import { ListWorkspaceMembersResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

const { omar, nadia, priya } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const members = async () => {
  const res = await w.call(omar, 'GET', '/api/workspace/members');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListWorkspaceMembersResponse.parse(res.body).members;
};

describe('Members: last active', () => {
  it('is null for a person who has never signed in', async () => {
    const list = await members();
    expect(list.find((m) => m.personId === priya.personId)?.lastActiveAt).toBeNull();
  });

  it('is the newest time one of their sessions was used here', async () => {
    await w.system(async (tx) => {
      for (const [ago, who] of [['3 days', nadia], ['2 hours', nadia]] as const) {
        await tx.query(
          `INSERT INTO app.sessions (workspace_id, person_id, last_seen_at, expires_at) VALUES ($1, $2, now() - $3::interval, now() + interval '30 days')`,
          [who.workspaceId, who.personId, ago],
        );
      }
    });
    const list = await members();
    const at = list.find((m) => m.personId === nadia.personId)?.lastActiveAt;
    expect(at).not.toBeNull();
    const ageMs = Date.now() - new Date(at ?? 0).getTime();
    expect(ageMs).toBeGreaterThan(60 * 60 * 1000);
    expect(ageMs).toBeLessThan(3 * 60 * 60 * 1000);
  });

  it('is still 404 for a member', async () => {
    expect((await w.call(nadia, 'GET', '/api/workspace/members')).status).toBe(404);
  });
});
