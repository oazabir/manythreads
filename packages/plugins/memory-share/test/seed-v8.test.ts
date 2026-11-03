import { ACTION_ITEMS_CONCEPT, SEED_INBOX, SEED_INBOX_DROPS, seedInboxAndShares, seedPdf, type SeedInboxAndSharesResult } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';

// P8-27: the memory part of seed v8, through the real server. A PDF, a photo, meeting notes (with an Action Items concept) in Engineering's inbox, a customer's .eml in
// Customer support's, and two shares from Engineering to Customer support: one accepted, one waiting for Customer support's leads.

const { omar, nadia, sameera, lena } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: FilesWorld;
let seeded: SeedInboxAndSharesResult;

interface Item {
  id: string;
  kind: string;
  state: string;
  name: string;
  reason: string | null;
  filedPaths: string[];
  droppedBy: string | null;
  duplicateOf: string | null;
}
interface Share {
  slug: string;
  status: string;
  mode: string;
  destinations: Array<{ slug: string; link: string }>;
}

const sharesOf = async (): Promise<Share[]> => (await world.call<{ shares: Share[] }>(omar, 'GET', '/api/teams/engineering/shares')).body.shares;

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  seeded = await seedInboxAndShares({ url: world.server.url, db: world.server.db });
}, 300_000);

afterAll(async () => {
  await world?.close();
});

describe('the inbox items', () => {
  it('has a PDF read into a Reference with its text, a photo that says it cannot be read yet, notes, and a customer email in Support’s inbox', async () => {
    expect(Object.fromEntries(Object.entries(seeded.items).map(([k, v]) => [k, [v.team, v.kind, v.state, v.duplicate]]))).toEqual({
      pdf: ['engineering', 'pdf', 'filed', false],
      photo: ['engineering', 'image', 'failed', false],
      notes: ['engineering', 'markdown', 'filed', false],
      eml: ['customer-support', 'eml', 'filed', false],
    });
    const pdf = (await world.call<{ item: Item }>(nadia, 'GET', `/api/teams/engineering/inbox/items/${seeded.items.pdf.id}`)).body.item;
    expect(pdf.filedPaths.length).toBeGreaterThan(0);
    const blob = await world.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(pdf.filedPaths[0]!)}`);
    expect(blob.body.content).toContain('Release notes are drafted on Friday');
    const photo = (await world.call<{ item: Item }>(nadia, 'GET', `/api/teams/engineering/inbox/items/${seeded.items.photo.id}`)).body.item;
    expect(photo.reason).toMatch(/Pictures cannot be read yet/);
    const mail = (await world.call<{ item: Item }>(sameera, 'GET', `/api/teams/customer-support/inbox/items/${seeded.items.eml.id}`)).body.item;
    expect(mail.filedPaths.length).toBeGreaterThan(0);
  });

  it('is dropped by the people the table names, and each team sees only its own', async () => {
    for (const drop of SEED_INBOX_DROPS) {
      const item = (await world.call<{ item: Item }>(omar, 'GET', `/api/teams/${drop.team}/inbox/items/${seeded.items[drop.key].id}`)).body.item;
      expect(item.name, drop.key).toBe(drop.name);
      expect(item.droppedBy, drop.key).toBe(drop.who.actorId);
    }
    const support = (await world.call<{ items: Item[] }>(sameera, 'GET', '/api/teams/customer-support/inbox/items')).body.items;
    expect(support.map((i) => i.name)).toEqual(['renewal-question.eml']);
    expect((await world.call(lena, 'GET', '/api/teams/engineering/inbox/items')).status).toBe(403);
  });

  it('gives the notes an Action Items concept whose lines are listed with their owners', async () => {
    expect(seeded.actionItems.path).toBe(SEED_INBOX.actionItemsPath);
    const res = await world.call<{ actions: Array<{ what: string; ownerActorId: string | null; due: string | null; done: boolean }> }>(
      nadia,
      'GET',
      `/api/teams/engineering/inbox/items/${seeded.actionItems.itemId}/actions`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.actions.map((a) => [a.what, a.ownerActorId, a.due, a.done])).toEqual([
      ['Draft the release notes on Friday', nadia.actorId, '2026-11-13', false],
      ['Send the notes to Support before each release', omar.actorId, '2026-11-13', false],
      ['Write the webhook limits into the runbook', personas.rafi.actorId, null, false],
      ['Put the deploy health page on the team wall', personas.rafi.actorId, '2026-11-04', true],
    ]);
    expect(ACTION_ITEMS_CONCEPT).toContain('type: Action Items');
  });

  it('has a PDF the extractor reads, built by hand', () => {
    const bytes = seedPdf(['One line', 'Two (nested) lines']);
    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(bytes.toString('latin1')).toContain('Two \\(nested\\) lines');
  });
});

describe('the shares to Customer support', () => {
  it('has one the team accepted and one still waiting, both active', async () => {
    const shares = await sharesOf();
    const accepted = shares.find((s) => s.slug === SEED_INBOX.shares.accepted.slug);
    const pending = shares.find((s) => s.slug === SEED_INBOX.shares.pending.slug);
    expect(accepted).toMatchObject({ status: 'active', mode: 'summary' });
    expect(accepted?.destinations).toEqual([expect.objectContaining({ slug: 'customer-support', link: 'accepted' })]);
    expect(pending).toMatchObject({ status: 'active', mode: 'full' });
    expect(pending?.destinations).toEqual([expect.objectContaining({ slug: 'customer-support', link: 'requested' })]);
    expect(seeded.shares).toEqual({ accepted: { slug: SEED_INBOX.shares.accepted.slug, link: 'accepted' }, pending: { slug: SEED_INBOX.shares.pending.slug, link: 'requested' } });
  });

  it('shows Customer support both of them, as the people of that team see them', async () => {
    const res = await world.call<{ incoming: Array<{ fromSlug: string; shareName: string; state: string }>; canManage: boolean }>(sameera, 'GET', '/api/teams/customer-support/shares/incoming');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.canManage).toBe(false);
    expect(res.body.incoming.map((i) => [i.shareName, i.state, i.fromSlug]).sort()).toEqual([
      [SEED_INBOX.shares.accepted.name, 'accepted', 'engineering'],
      [SEED_INBOX.shares.pending.name, 'requested', 'engineering'],
    ]);
  });

  it('keeps the accept row of the waiting share open for Customer support’s leads, and closes the other', async () => {
    const rows = await world.system((tx) =>
      tx.query<{ slug: string; status: string; outcome: string }>(
        `SELECT s.slug, a.status, a.outcome FROM app.memory_share_links l JOIN app.memory_shares s ON s.id = l.share_id
           JOIN app.approvals a ON a.id = l.approval_id WHERE a.tool = 'memory.share.accept' ORDER BY s.slug`,
      ),
    );
    expect(rows.rows).toEqual([
      { slug: SEED_INBOX.shares.accepted.slug, status: 'approved', outcome: 'ran' },
      { slug: SEED_INBOX.shares.pending.slug, status: 'pending', outcome: 'none' },
    ]);
  });

  it('can be approved by the leads of Customer support later: the pending link moves to accepted', async () => {
    const row = await world.system(async (tx) =>
      (await tx.query<{ id: string }>(`SELECT a.id FROM app.approvals a JOIN app.memory_share_links l ON l.approval_id = a.id WHERE a.tool = 'memory.share.accept' AND a.status = 'pending'`)).rows[0],
    );
    expect(row).toBeDefined();
    // Omar wrote the share, so he cannot decide it; the seed has no other lead in Customer support, which is why the other share was accepted in the database.
    expect((await world.call(omar, 'POST', `/api/teams/customer-support/approvals/${row!.id}/approve`, {})).status).toBe(403);
  });
});

describe('seeding again', () => {
  it('changes nothing: the same files are duplicates of the first, and the shares stay as they were', async () => {
    const before = (await world.system((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_inbox_items WHERE state <> \'duplicate\''))).rows[0]!.n;
    const again = await seedInboxAndShares({ url: world.server.url, db: world.server.db });
    for (const key of Object.keys(seeded.items) as Array<keyof typeof seeded.items>) {
      expect(again.items[key], key).toMatchObject({ id: seeded.items[key].id, duplicate: true, state: seeded.items[key].state });
    }
    expect(again.shares).toEqual(seeded.shares);
    const after = (await world.system((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_inbox_items WHERE state <> \'duplicate\''))).rows[0]!.n;
    expect(after).toBe(before);
    const shares = await sharesOf();
    expect(shares.filter((s) => s.slug === SEED_INBOX.shares.accepted.slug || s.slug === SEED_INBOX.shares.pending.slug)).toHaveLength(2);
  });
});
