import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { personas, type Persona } from '@manythreads/test-utils';

/**
 * Cursor pagination of a 5,000-message channel (PLAN criterion 9, spec e2e/api/messages/pagination.spec.ts): newest first,
 * `before` is the id of the oldest message the client holds, every message appears exactly once, none is missed.
 */

const { omar, rafi } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

interface Page {
  items: { id: string }[];
  nextCursor: string | null;
}

test('5,000 messages page through by cursor with no gaps and no repeats', async ({ request }) => {
  test.setTimeout(120_000);
  const created = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name: `busy-${randomUUID().slice(0, 8)}` } });
  expect(created.status()).toBe(201);
  const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
  const bulk = await request.post('/api/test/bulk-messages', { headers: as(omar), data: { channelId, count: 5000 } });
  expect(bulk.status(), await bulk.text()).toBe(200);

  const walk = async (limit: number): Promise<string[]> => {
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 5000; guard += 1) {
      const res = await request.get(`/api/channels/${channelId}/messages`, {
        headers: as(rafi),
        params: { limit: String(limit), ...(before ? { before } : {}) },
      });
      expect(res.status()).toBe(200);
      const page = (await res.json()) as Page;
      seen.push(...page.items.map((m) => m.id));
      if (!page.nextCursor) return seen;
      expect(page.items).toHaveLength(limit);
      expect(page.nextCursor).toBe(page.items[limit - 1]?.id);
      before = page.nextCursor;
    }
    throw new Error('pagination did not end');
  };

  const bySize = await walk(200);
  expect(bySize).toHaveLength(5000);
  expect(new Set(bySize).size).toBe(5000);
  expect([...bySize].sort().reverse()).toEqual(bySize);   // uuid v7 ids: newest first is descending id order

  const odd = await walk(137);                              // a page size that does not divide 5,000: the last page is short
  expect(odd).toEqual(bySize);

  // A client that already holds the newest messages asks only for what is older than its oldest.
  const newest = (await (await request.get(`/api/channels/${channelId}/messages`, { headers: as(rafi), params: { limit: '10' } })).json()) as Page;
  expect(newest.items.map((m) => m.id)).toEqual(bySize.slice(0, 10));
  expect(newest.nextCursor).toBe(bySize[9]);
  const next = (await (await request.get(`/api/channels/${channelId}/messages`, { headers: as(rafi), params: { limit: '10', before: newest.nextCursor! } })).json()) as Page;
  expect(next.items.map((m) => m.id)).toEqual(bySize.slice(10, 20));

  // Nothing leaks: Sameera cannot page through it.
  const outsider = await request.get(`/api/channels/${channelId}/messages`, { headers: as(personas.sameera) });
  expect(outsider.status()).toBe(403);
});
