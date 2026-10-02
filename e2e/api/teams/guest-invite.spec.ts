import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { AcceptInvitationResponse, CreateInvitationResponse } from '@manythreads/shared';
import { personas, SEED_IDS, type Persona } from '@manythreads/test-utils';
import { csrf } from '../../fixtures/stack.ts';
import { expect, signedIn, test, useIsolatedStack } from '../support/isolated.ts';

/**
 * PLAN criterion 3 (P3-16), API level: a guest invitation's channel grant is applied when it is accepted, and the new guest sees
 * exactly that channel (read only unless the grant says post), nothing else. Runs on seed v3 so #releases has its announcements and
 * #dev, #eng-leads, a DM and 5,000 messages exist to be refused. The spec accepts as a new address, so it never touches Lena.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'content' });
const { omar } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

async function inviteAndAccept(request: APIRequestContext, email: string, channels: unknown[]): Promise<{ email: string }> {
  const created = await request.post('/api/invitations', { headers: as(omar), data: { email, role: 'guest', channels } });
  expect(created.status(), await created.text()).toBe(201);
  const { token } = CreateInvitationResponse.parse(await created.json());
  const accepted = await request.post(`/api/invitations/${token}/accept`, { data: { name: 'Visiting Reader' } });
  expect(accepted.status(), await accepted.text()).toBe(200);
  expect(AcceptInvitationResponse.parse(await accepted.json())).toMatchObject({ workspaceRole: 'guest', teamId: null, createdPerson: true });
  return { email };
}
const channelNames = async (ctx: APIRequestContext): Promise<string[]> => {
  const res = await ctx.get('/api/teams/engineering/channels');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { groups: { channels: { name: string }[] }[] }).groups.flatMap((g) => g.channels.map((c) => c.name));
};

test('the guest sees #releases and its announcements, and nothing else', async ({ request, playwright }) => {
  const stack = await iso.start();
  const { email } = await inviteAndAccept(request, `reader-${randomUUID().slice(0, 8)}@partner.example`, [{ teamSlug: 'engineering', channel: '#releases' }]);
  const guest = await signedIn(playwright, stack, email);

  expect(await channelNames(guest)).toEqual(['releases']);
  expect(await channelNames(guest)).not.toContain('dev');
  const releases = SEED_IDS.channels['engineering/releases'];
  const list = await guest.get(`/api/channels/${releases}/messages?limit=3`);
  expect(list.status()).toBe(200);
  expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(3);
  expect(((await (await guest.get(`/api/channels/${releases}`)).json()) as { canPost: boolean }).canPost).toBe(false);

  // read only: no post, no reaction
  const post = await guest.post(`/api/channels/${releases}/messages`, { data: { channelId: releases, body: 'hello', threadRootId: null }, headers: await csrf(guest) });
  expect(post.status()).toBe(403);
  // every other channel, the private one, the 5,000-message one, the DM, the members and the files are closed
  for (const ref of ['engineering/dev', 'engineering/eng-leads', 'engineering/load-test', 'customer-support/support', 'marketing/content'] as const) {
    const id = SEED_IDS.channels[ref];
    expect((await guest.get(`/api/channels/${id}`)).status(), ref).toBe(403);
    expect((await guest.get(`/api/channels/${id}/messages`)).status(), ref).toBe(403);
  }
  expect((await guest.get(`/api/channels/${SEED_IDS.dm}/messages`)).status()).toBe(403);
  expect((await guest.get(`/api/channels/${releases}/members`)).status()).toBe(403);
  expect((await guest.get(`/api/files/${SEED_IDS.file}`)).status()).toBe(403);
  expect((await guest.get(`/api/files/${SEED_IDS.file}/content`)).status()).toBe(403);
  expect(((await (await guest.get('/api/dms')).json()) as { items: unknown[] }).items).toEqual([]);
  await guest.dispose();
});

test('a grant that says post lets the guest post in that channel only', async ({ request, playwright }) => {
  const stack = await iso.start();
  const { email } = await inviteAndAccept(request, `poster-${randomUUID().slice(0, 8)}@partner.example`, [
    { teamSlug: 'engineering', channel: '#releases', permission: 'post' },
  ]);
  const guest = await signedIn(playwright, stack, email);
  const releases = SEED_IDS.channels['engineering/releases'];
  expect(((await (await guest.get(`/api/channels/${releases}`)).json()) as { canPost: boolean }).canPost).toBe(true);
  const ok = await guest.post(`/api/channels/${releases}/messages`, { data: { channelId: releases, body: 'Thanks for the update', threadRootId: null }, headers: await csrf(guest) });
  expect(ok.status(), await ok.text()).toBe(201);
  const dev = SEED_IDS.channels['engineering/dev'];
  const refused = await guest.post(`/api/channels/${dev}/messages`, { data: { channelId: dev, body: 'sneak', threadRootId: null }, headers: await csrf(guest) });
  expect(refused.status()).toBe(403);
  await guest.dispose();
});

test('nothing is granted before the invitation is accepted, and a used token grants nothing twice', async ({ request }) => {
  const stack = await iso.start();
  const email = `later-${randomUUID().slice(0, 8)}@partner.example`;
  const created = await request.post('/api/invitations', { headers: as(omar), data: { email, role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#releases' }] } });
  const { token } = CreateInvitationResponse.parse(await created.json());
  const before = await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM app.acl_entries WHERE resource_type = 'channel'");
  expect((await request.post(`/api/invitations/${token}/accept`, { data: {} })).status()).toBe(200);
  const after = await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM app.acl_entries WHERE resource_type = 'channel'");
  expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
  expect((await request.post(`/api/invitations/${token}/accept`, { data: {} })).status()).toBe(410);
  expect((await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM app.acl_entries WHERE resource_type = 'channel'"))[0]?.n).toBe(after[0]?.n);
});
