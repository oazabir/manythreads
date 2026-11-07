import { ownerSql, seedRepo } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ListBotConsentsResponse, SetBotConsentResponse } from '@manythreads/shared';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P20-09: the Account page's two routes. GET lists the bots the caller can see with the answer in force (a bot whose definition does not list
// `personal.read` shows `canAsk: false`); PUT sets the caller's own answer and emits `bots.personal_consent.changed`. A guest has no Personal space and no list.

const { omar, nadia, rafi, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
  await seedRepo(w.server.db, { attachments: false });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the loader');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const md = (name: string, native: string): string => `---
schema: 1
name: ${name}
role: Tests the consent page
kind: agent
runtime: hermes
triggers:
  - type: conversation
capabilities:
  native: [${native}]
---

# ${name}
`;
const list = (who: typeof omar) => w.call<ListBotConsentsResponse>(who, 'GET', '/api/me/bot-consents');
const set = (who: typeof omar, botId: string, allowed: boolean) => w.call<SetBotConsentResponse>(who, 'PUT', `/api/me/bot-consents/${botId}`, { allowed });

describe('GET/PUT /api/me/bot-consents', () => {
  it('lists the bots a person can see, says which ask for Personal, and keeps the person\'s own answer', async () => {
    await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/consent-asker/BOT.md', content: md('Asker', 'messages.post, personal.read') }], 'Add Asker');
    await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/consent-quiet/BOT.md', content: md('Quiet', 'messages.post') }], 'Add Quiet');
    const asker = await until(async () => (await list(nadia)).body.items.find((i) => i.botSlug === 'consent-asker'), 10_000);
    await until(async () => (await list(nadia)).body.items.find((i) => i.botSlug === 'consent-quiet'), 10_000);
    const quiet = (await list(nadia)).body.items.find((i) => i.botSlug === 'consent-quiet')!;
    expect(asker).toMatchObject({ canAsk: true, allowed: false, isDefault: true, changedAt: null });
    expect(quiet).toMatchObject({ canAsk: false, allowed: false, isDefault: true });

    const res = await set(nadia, asker.botId, true);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ botId: asker.botId, allowed: true, isDefault: false });
    expect(res.body.item.changedAt).not.toBeNull();
    // it is Nadia's own answer: Rafi still sees the default, and the event carries ids and the answer only
    expect((await list(rafi)).body.items.find((i) => i.botSlug === 'consent-asker')).toMatchObject({ allowed: false, isDefault: true });
    const events = await ownerSql(w.server.db.ownerUrl, `SELECT payload FROM app.events WHERE type = 'bots.personal_consent.changed'`, []);
    expect(events).toHaveLength(1);
    expect(events[0]?.['payload']).toMatchObject({ botId: asker.botId, allowed: true });
    // withdrawn
    expect((await set(nadia, asker.botId, false)).body.item).toMatchObject({ allowed: false, isDefault: false });
  });

  it('refuses a guest and a bot nobody can see', async () => {
    expect((await list(lena)).body.items).toEqual([]);
    expect([403, 404]).toContain((await set(lena, '00000000-0000-7000-8000-000000000999', true)).status);
    expect((await set(nadia, '00000000-0000-7000-8000-000000000999', true)).status).toBe(404);
  });
});
