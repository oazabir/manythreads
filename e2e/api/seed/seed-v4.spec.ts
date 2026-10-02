import { type APIRequestContext } from '@playwright/test';
import { GetRepoTreeResponse, ErrorEnvelope } from '@manythreads/shared';
import { personas, SEED_IDS, SEED_REPO_IDS, type Persona } from '@manythreads/test-utils';
import { expect, signedIn, test, useIsolatedStack } from '../support/isolated.ts';

/**
 * Seed v4 over HTTP (PLAN P4-13, criteria 1 and 6): each template team's repository holds its pages, a CSV, a Mermaid diagram, an embedded
 * app, memory and a bot placeholder (committed by the right people through the writer), `#dev` holds a PDF, a PNG, an MP4 and an Office
 * file, and the ACL is what the tree promises: Lena gets 403 on `#dev` attachments, Nadia on Marketing's repository.
 * The stack is seeded with `seedWorld(db, { content: true, repo: true })`, the call `pnpm seed --demo` makes.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'repo' });

const sessions = new Map<string, APIRequestContext>();
async function as(playwright: Parameters<typeof signedIn>[0], p: Persona): Promise<APIRequestContext> {
  const have = sessions.get(p.key);
  if (have) return have;
  const ctx = await signedIn(playwright, await iso.start(), p.email);
  sessions.set(p.key, ctx);
  return ctx;
}
test.afterAll(async () => {
  for (const ctx of sessions.values()) await ctx.dispose();
});

const names = async (ctx: APIRequestContext, team: string, path = ''): Promise<string[]> => {
  const res = await ctx.get(`/api/teams/${team}/repo/tree`, { params: { path } });
  expect(res.status(), `${team}/${path}`).toBe(200);
  return GetRepoTreeResponse.parse(await res.json()).entries.map((e) => e.name);
};
const text = async (ctx: APIRequestContext, team: string, path: string): Promise<string> => {
  const res = await ctx.get(`/api/teams/${team}/repo/blob`, { params: { path } });
  expect(res.status(), path).toBe(200);
  const body = (await res.json()) as { content: string; encoding: string };
  expect(body.encoding).toBe('utf8');
  return body.content;
};

test('Engineering: the §5.1 layout with pages, an app, memory with two subfolders and a bot placeholder', async ({ playwright }) => {
  const nadia = await as(playwright, personas.nadia);
  expect(await names(nadia, 'engineering')).toEqual(expect.arrayContaining(['TEAM.md', 'apps', 'bots', 'knowledge', 'memory', 'pages', 'routines', 'skills']));
  expect(await names(nadia, 'engineering', 'pages')).toEqual(expect.arrayContaining(['runbook.md', 'reports', 'diagrams', 'weekly-digest.md', 'changelog.md']));
  expect(await names(nadia, 'engineering', 'pages/reports')).toEqual(['signups.csv']);
  expect(await names(nadia, 'engineering', 'pages/diagrams')).toEqual(['dispatch.mmd']);
  expect(await names(nadia, 'engineering', 'memory')).toEqual(['facts', 'journal']);
  expect((await names(nadia, 'engineering', 'memory/facts')).filter((n) => n.endsWith('.md')).length).toBeGreaterThanOrEqual(2);
  expect((await names(nadia, 'engineering', 'memory/journal')).filter((n) => n.endsWith('.md')).length).toBe(1);
  expect(await names(nadia, 'engineering', 'apps/release-checklist')).toEqual(['index.html']);
  expect(await names(nadia, 'engineering', 'bots/coder')).toEqual(['BOT.md', 'lessons.md', 'memory.md']);
  expect(await text(nadia, 'engineering', 'pages/runbook.md')).toContain('## Rollback');
  expect(await text(nadia, 'engineering', 'pages/reports/signups.csv')).toMatch(/^week,signups,churn\n/);
  expect(await text(nadia, 'engineering', 'apps/release-checklist/index.html')).toContain('__manythreads.js');
  expect(await text(nadia, 'engineering', 'TEAM.md')).toContain('template: engineering');
});

test('the runbook has two commits by two people; the history of each team starts with the system commit', async ({ playwright }) => {
  await as(playwright, personas.nadia);
  const stack = await iso.start();
  const rows = await stack.sql<{ slug: string; author: string | null; message: string }>(
    `SELECT t.slug, c.author_id AS author, c.message FROM app.repo_commits c JOIN app.teams t ON t.id = c.team_id
      WHERE c.paths @> ARRAY['pages/runbook.md'] ORDER BY t.slug, c.committed_at, c.seq`,
  );
  const by = (slug: string): (string | null)[] => rows.filter((r) => r.slug === slug).map((r) => r.author);
  expect(by('engineering')).toEqual([personas.rafi.actorId, personas.nadia.actorId]);
  expect(by('marketing')).toEqual([personas.tariq.actorId, personas.priya.actorId]);
  expect(by('customer-support')).toEqual([personas.sameera.actorId, personas.sameera.actorId]);
  const first = await stack.sql<{ n: number }>(`SELECT count(*)::int AS n FROM app.repo_commits WHERE parent_sha IS NULL AND author_id IS NULL`);
  expect(first[0]?.n).toBe(3);
});

test('Marketing and Customer support have their own pages; Nadia gets 403 on the Marketing tree, Lena on every tree (criterion 6)', async ({ playwright }) => {
  const tariq = await as(playwright, personas.tariq);
  expect(await text(tariq, 'marketing', 'pages/runbook.md')).toContain('# Campaign launch runbook');
  expect(await names(tariq, 'marketing', 'bots')).toContain('content-drafter');
  const sameera = await as(playwright, personas.sameera);
  expect(await text(sameera, 'customer-support', 'pages/runbook.md')).toContain('# Escalation runbook');
  expect(await names(sameera, 'customer-support', 'bots')).toContain('support-responder');

  const nadia = await as(playwright, personas.nadia);
  const denied = await nadia.get('/api/teams/marketing/repo/tree');
  expect(denied.status()).toBe(403);
  ErrorEnvelope.parse(await denied.json());
  const lena = await as(playwright, personas.lena);
  for (const team of ['engineering', 'marketing', 'customer-support']) expect((await lena.get(`/api/teams/${team}/repo/tree`)).status(), team).toBe(403);
});

test('#dev holds a PDF, a PNG, an MP4 and an Office file: Nadia downloads them, Lena and Sameera get 403', async ({ playwright }) => {
  const nadia = await as(playwright, personas.nadia);
  const list = (await (await nadia.get(`/api/channels/${SEED_IDS.channels['engineering/dev']}/files`)).json()) as { items: { id: string; name: string; mime: string }[] };
  expect(list.items.map((f) => f.name).sort()).toEqual(['canary-rollout.mp4', 'deploy-plan-v2.14.pdf', 'latency-before-after.png', 'release-notes-v2.14.docx']);
  const magic: [string, (b: Buffer) => boolean][] = [
    [SEED_IDS.file, (b) => b.subarray(0, 5).toString() === '%PDF-'],
    [SEED_REPO_IDS.png, (b) => b.subarray(1, 4).toString() === 'PNG'],
    [SEED_REPO_IDS.mp4, (b) => b.subarray(4, 8).toString() === 'ftyp'],
    [SEED_REPO_IDS.docx, (b) => b.subarray(0, 2).toString() === 'PK'],
  ];
  for (const [id, check] of magic) {
    const res = await nadia.get(`/api/files/${id}/content`);
    expect(res.status(), id).toBe(200);
    expect(check(await res.body()), id).toBe(true);
    for (const p of [personas.lena, personas.sameera]) expect((await (await as(playwright, p)).get(`/api/files/${id}/content`)).status(), `${p.key} ${id}`).toBe(403);
  }
});
