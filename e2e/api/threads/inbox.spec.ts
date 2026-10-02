import { randomUUID } from 'node:crypto';
import { ListThreadsResponse, GetThreadResponse } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes data (channels, messages, ...): its own server and database for this file (api/support/isolated.ts).
useIsolatedStack();

/**
 * The Threads inbox over HTTP (PLAN criterion 4, spec e2e/threads/inbox.spec.ts, API level): follow, reply by another, then the three
 * tabs. Followed lists what a person follows, Unread what has replies they have not read, Mine what they started.
 */

const { omar, nadia, rafi, priya } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

test('follow, reply by another, and the three tabs list exactly the right threads', async ({ request }) => {
  const created = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name: `inbox-${randomUUID().slice(0, 8)}` } });
  expect(created.status(), await created.text()).toBe(201);
  const dev = ((await created.json()) as { channel: { id: string } }).channel.id;
  const post = async (who: Persona, body: string, threadRootId: string | null = null): Promise<string> => {
    const res = await request.post(`/api/channels/${dev}/messages`, { headers: as(who), data: { channelId: dev, body, threadRootId } });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const tab = async (who: Persona, name: string): Promise<string[]> => {
    const res = await request.get(`/api/teams/engineering/threads?tab=${name}&limit=100`, { headers: as(who) });
    expect(res.status()).toBe(200);
    return ListThreadsResponse.parse(await res.json()).items.map((i) => i.rootMessageId);
  };

  const root = await post(nadia, `Inbox spec ${Date.now()}`);
  expect((await request.post(`/api/threads/${root}/follow`, { headers: as(priya) })).status()).toBe(200);
  expect(await tab(priya, 'followed')).not.toContain(root);        // nothing to show until the first reply
  await post(rafi, 'a reply from someone else', root);

  expect(await tab(priya, 'followed')).toContain(root);
  expect(await tab(priya, 'unread')).toContain(root);
  expect(await tab(priya, 'mine')).not.toContain(root);
  expect(await tab(nadia, 'mine')).toContain(root);
  expect(await tab(nadia, 'unread')).toContain(root);
  expect(await tab(rafi, 'followed')).toContain(root);
  expect(await tab(rafi, 'unread')).not.toContain(root);

  const opened = GetThreadResponse.parse(await (await request.get(`/api/threads/${root}`, { headers: as(priya) })).json());
  expect(opened.thread).toMatchObject({ followed: true, unreadCount: 1, replyCount: 1 });
  const read = await request.post('/api/read-state/mark', { headers: as(priya), data: { targetType: 'thread', targetId: root, upTo: opened.replies.items[0]!.id } });
  expect(read.status(), await read.text()).toBe(200);
  expect(await tab(priya, 'unread')).not.toContain(root);
  expect(await tab(priya, 'followed')).toContain(root);

  expect((await request.post(`/api/threads/${root}/unfollow`, { headers: as(priya) })).status()).toBe(200);
  expect(await tab(priya, 'followed')).not.toContain(root);
});
