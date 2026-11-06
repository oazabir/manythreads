import { AddTeamMemberResponse, GetTeamRosterResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

/*
 * "Join as admin" (P21-18): a workspace admin who is not on a team opens one of its bots and is offered to join. There is no route of its own for
 * it. The button uses the ordinary roster route, so the same rule applies as for everyone: a team lead or a workspace admin may add people, and a
 * plain member may not (not even themselves).
 */

const { omar, nadia, priya } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('a workspace admin who is not on the team joins it', () => {
  it('adds themselves as a plain member, and the roster shows it', async () => {
    // Omar leads Engineering and is not on Marketing.
    const before = GetTeamRosterResponse.parse((await w.call(omar, 'GET', '/api/teams/marketing/roster')).body);
    expect(before.members.map((m) => m.displayName)).not.toContain('Omar');

    const res = await w.call(omar, 'POST', '/api/teams/marketing/members', { personId: omar.personId, role: 'member' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const joined = AddTeamMemberResponse.parse(res.body);
    expect(joined.added).toBe(true);
    expect(joined.member).toMatchObject({ displayName: 'Omar', role: 'member' });

    const after = GetTeamRosterResponse.parse((await w.call(omar, 'GET', '/api/teams/marketing/roster')).body);
    expect(after.members.find((m) => m.displayName === 'Omar')?.role).toBe('member');
  });

  it('asking again changes nothing (the page may be reloaded after joining)', async () => {
    const res = await w.call(omar, 'POST', '/api/teams/marketing/members', { personId: omar.personId, role: 'member' });
    expect(res.status).toBe(200);
    expect(AddTeamMemberResponse.parse(res.body).added).toBe(false);
  });

  it('writes the same audit event as any other addition', async () => {
    await w.system(async (tx) => {
      const rows = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM app.events WHERE type = 'team.member.added' AND payload->>'personId' = $1 AND payload->>'role' = 'member'",
        [omar.personId],
      );
      expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('a plain member cannot add themselves', () => {
  it('is refused with 403 on a team they are not on', async () => {
    // Nadia is a member of Engineering only; Priya is a member of Engineering and Marketing, not Customer support.
    expect((await w.call(nadia, 'POST', '/api/teams/marketing/members', { personId: nadia.personId, role: 'member' })).status).toBe(403);
    expect((await w.call(priya, 'POST', '/api/teams/customer-support/members', { personId: priya.personId, role: 'member' })).status).toBe(403);
    const roster = GetTeamRosterResponse.parse((await w.call(omar, 'GET', '/api/teams/customer-support/roster')).body);
    expect(roster.members.map((m) => m.displayName)).not.toContain('Priya');
  });
});
