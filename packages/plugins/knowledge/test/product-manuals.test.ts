import { PRODUCT_MANUALS, PRODUCT_MANUALS_QUESTIONS, PRODUCT_MANUALS_SLUG, seedProductManuals } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';

// P8-12: the `product-manuals` base of the seed. Four manuals go in through the knowledge routes, and every question of the fixture finds its one document first.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;

interface Hit { documentName: string; text: string; score: number }

beforeAll(async () => {
  world = await createWorld();
}, 180_000);

afterAll(async () => {
  await world?.close();
});

describe('the product-manuals base', () => {
  it('is made by a lead through the routes, indexed, and made again without change', async () => {
    const first = await seedProductManuals({ url: world.server.url, lead: omar });
    expect(first.base).toBe(PRODUCT_MANUALS_SLUG);
    expect(first.documents.map((d) => d.name)).toEqual(PRODUCT_MANUALS.map((d) => d.name));
    for (const d of first.documents) expect(d, d.name).toMatchObject({ status: 'indexed' });
    for (const d of first.documents) expect(d.chunkCount, d.name).toBeGreaterThan(0);
    const again = await seedProductManuals({ url: world.server.url, lead: omar });
    expect(again.documents).toEqual(first.documents);
    const detail = await world.call<{ base: { documentCount: number; failedCount: number } }>(nadia, 'GET', `/api/teams/engineering/knowledge/${PRODUCT_MANUALS_SLUG}`);
    expect(detail.body.base).toMatchObject({ documentCount: 4, failedCount: 0 });
  });

  it.each(PRODUCT_MANUALS_QUESTIONS.map((q) => [q.question, q] as const))('“%s” finds its manual first', async (_name, q) => {
    const res = await world.call<{ hits: Hit[] }>(nadia, 'GET', `/api/teams/engineering/knowledge/${PRODUCT_MANUALS_SLUG}/search?q=${encodeURIComponent(q.question)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const top = res.body.hits[0]!;
    expect(top.documentName).toBe(q.document);
    expect(top.text).toContain(q.answerHas);
  });

  it('answers nothing for a question the manuals do not cover', async () => {
    const res = await world.call<{ hits: Hit[] }>(nadia, 'GET', `/api/teams/engineering/knowledge/${PRODUCT_MANUALS_SLUG}/search?q=${encodeURIComponent('what is the weather in Lisbon')}`);
    expect(res.body.hits).toEqual([]);
  });
});
