import { AcceptInvitationResponse, CreateInvitationResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ActingAs, type World } from './world.ts';

// P3-16, PLAN criterion 3: a guest invitation's channel grants are applied when it is accepted. The guest then sees exactly
// that channel (read, and post only if the grant says so), and nothing else.

const { omar, nadia } = personas;
const TEAM = 'engineering';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: { status: number; body: unknown }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const channel = async (name: string, isPrivate = false): Promise<string> =>
  ok<{ channel: { id: string } }>(await w.call(omar, 'POST', `/api/teams/${TEAM}/channels`, { name, private: isPrivate }), 201).channel.id;

async function invite(email: string, channels: unknown[], by = omar): Promise<string> {
  return CreateInvitationResponse.parse(ok(await w.call(by, 'POST', '/api/invitations', { email, role: 'guest', channels }), 201)).token;
}
async function accept(token: string, name: string): Promise<ActingAs & { personId: string }> {
  const accepted = AcceptInvitationResponse.parse(ok(await w.call(null, 'POST', `/api/invitations/${token}/accept`, { name })));
  const actorId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1", [accepted.personId])).rows[0]?.id as string);
  return { actorId, workspaceId: accepted.workspaceId, personId: accepted.personId };
}
const visible = async (who: ActingAs): Promise<string[]> =>
  ok<{ groups: { channels: { name: string }[] }[] }>(await w.call(who, 'GET', `/api/teams/${TEAM}/channels`)).groups.flatMap((g) => g.channels.map((c) => c.name));
const grantsOf = (personId: string) =>
  w.system(async (tx) => (await tx.query<{ permission: string; name: string }>(
    `SELECT e.permission, c.name FROM app.acl_entries e JOIN app.channels c ON c.id = e.resource_id WHERE e.subject_id = $1 ORDER BY 1, 2`, [personId])).rows);

describe('a guest invitation grants its channels on accept', () => {
  it('Lena-style: the guest sees exactly the granted channel, read only; every other channel and DM is closed', async () => {
    const releases = await channel('releases');
    const dev = await channel('dev');
    const leads = await channel('eng-leads', true);
    ok(await w.call(omar, 'POST', `/api/channels/${releases}/messages`, { channelId: releases, body: 'v2.14 shipped', threadRootId: null }), 201);

    const token = await invite('Visitor@Partner.example', [{ teamSlug: TEAM, channel: '#releases' }]);
    // Nothing is granted before the invitation is accepted.
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.acl_entries')).rowCount)).toBe(0);
    const guest = await accept(token, 'Visitor');

    expect(await grantsOf(guest.personId)).toEqual([{ permission: 'read', name: 'releases' }]);
    expect(await visible(guest)).toEqual(['releases']);
    const list = ok<{ items: { body: string }[] }>(await w.call(guest, 'GET', `/api/channels/${releases}/messages`));
    expect(list.items.map((m) => m.body)).toEqual(['v2.14 shipped']);
    const detail = ok<{ canPost: boolean }>(await w.call(guest, 'GET', `/api/channels/${releases}`));
    expect(detail.canPost).toBe(false);
    expect((await w.call(guest, 'POST', `/api/channels/${releases}/messages`, { channelId: releases, body: 'hi', threadRootId: null })).status).toBe(403);
    for (const other of [dev, leads]) {
      expect((await w.call(guest, 'GET', `/api/channels/${other}`)).status).toBe(403);
      expect((await w.call(guest, 'GET', `/api/channels/${other}/messages`)).status).toBe(403);
    }
    expect((await w.call(guest, 'GET', `/api/channels/${releases}/members`)).status).toBe(403);
    expect((await w.call(guest, 'POST', '/api/dms', { personIds: [nadia.personId] })).status).toBe(403);
  });

  it('a grant that says post lets the guest post there and nowhere else', async () => {
    const announce = await channel('announce');
    const other = await channel('quiet');
    const guest = await accept(await invite('poster@partner.example', [{ teamSlug: TEAM, channel: '#announce', permission: 'post' }]), 'Poster');
    expect(await grantsOf(guest.personId)).toEqual([{ permission: 'post', name: 'announce' }, { permission: 'read', name: 'announce' }]);
    expect((await w.call(guest, 'POST', `/api/channels/${announce}/messages`, { channelId: announce, body: 'Thanks for the update', threadRootId: null })).status).toBe(201);
    expect((await w.call(guest, 'POST', `/api/channels/${other}/messages`, { channelId: other, body: 'sneak', threadRootId: null })).status).toBe(403);
  });

  it('applies several channels at once, skips a channel that does not exist and a private one is granted like any other', async () => {
    const one = await channel('guest-one');
    await channel('guest-two', true);
    const guest = await accept(
      await invite('many@partner.example', [
        { teamSlug: TEAM, channel: '#guest-one' },
        { teamSlug: TEAM, channel: '#guest-two' },
        { teamSlug: TEAM, channel: '#not-yet-made' },
      ]),
      'Many',
    );
    expect(await grantsOf(guest.personId)).toEqual([{ permission: 'read', name: 'guest-one' }, { permission: 'read', name: 'guest-two' }]);
    expect((await visible(guest)).sort()).toEqual(['guest-one', 'guest-two']);
    expect((await w.call(guest, 'GET', `/api/channels/${one}/messages`)).status).toBe(200);
  });

  it('a second accept changes nothing (the token is spent), and an expired invitation grants nothing', async () => {
    await channel('once');
    const token = await invite('twice@partner.example', [{ teamSlug: TEAM, channel: '#once' }]);
    const guest = await accept(token, 'Twice');
    const before = await grantsOf(guest.personId);
    expect((await w.call(null, 'POST', `/api/invitations/${token}/accept`, {})).status).toBe(410);
    expect(await grantsOf(guest.personId)).toEqual(before);

    const late = await invite('late@partner.example', [{ teamSlug: TEAM, channel: '#once' }]);
    await w.system((tx) => tx.query("UPDATE app.invitations SET expires_at = now() - interval '1 minute' WHERE email = 'late@partner.example'"));
    expect((await w.call(null, 'POST', `/api/invitations/${late}/accept`, {})).status).toBe(410);
    expect(await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.people WHERE primary_email = 'late@partner.example'")).rowCount)).toBe(0);
  });

  it('an inviter who is no longer an admin at accept time grants nothing (the guest still joins, seeing no channel)', async () => {
    await channel('revoked');
    // Nadia is promoted to admin by the owner, invites, and is demoted again before the guest accepts.
    ok(await w.call(omar, 'PATCH', `/api/workspace/members/${nadia.personId}`, { role: 'admin' }));
    const token = await invite('orphan@partner.example', [{ teamSlug: TEAM, channel: '#revoked' }], nadia);
    ok(await w.call(omar, 'PATCH', `/api/workspace/members/${nadia.personId}`, { role: 'member' }));
    const guest = await accept(token, 'Orphan');
    expect(await grantsOf(guest.personId)).toEqual([]);
    expect(await visible(guest)).toEqual([]);
  });

  it('is only for a guest invitation: a member invitation never carries channels', async () => {
    expect((await w.call(omar, 'POST', '/api/invitations', { email: 'm@partner.example', role: 'member', channels: [{ teamSlug: TEAM, channel: '#dev' }] })).status).toBe(400);
  });
});
