import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHindsight, type FakeHindsight } from '../../../../../tools/fake-hindsight/src/server.ts';
import { ensureChannels, eventually } from '../../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld, type Persona } from '../../../files/test/world.ts';

// `pnpm test:memory-cross-team`, the sharing half (PLAN P8-27; SPEC 12.1, 12.3): what a team passes on on purpose reaches the teams that accepted and no one else.
// Engineering shares with Customer support (accepted) and Marketing (still waiting). The engine is tools/fake-hindsight, which records which bank every request
// named, so "Marketing's bank never saw it" is checked against every request that was made. Engineering's `share: never` concept and its other folders stay home.

const { omar, nadia, sameera, tariq, lena } = personas;
vi.setConfig({ testTimeout: 240_000 });

const A = 'engineering';
const B = 'customer-support';
const C = 'marketing';
const TEAM_ID = '00000000-0000-7000-8000-0000000b0001';
const SUPPORT_ID = '00000000-0000-7000-8000-0000000b0002';
const MARKETING_ID = '00000000-0000-7000-8000-0000000b0003';
let BANK_A = '';
let BANK_B = '';
let BANK_C = '';

const SHARED_TITLE = 'Kestrel ships on Tuesdays';
const LATER_TITLE = 'Nighthawk freeze before holidays';
const HOME_TITLE = 'Heron payroll plan';
const PLAYBOOK_TITLE = 'Osprey on-call rota';

let world: FilesWorld;
let fake: FakeHindsight;

interface Run {
  id: string;
  state: string;
  reason: string | null;
  approvalId: string | null;
}

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 60_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const textsOf = (bank: string): string[] => (fake.state.banks.get(bank) ?? []).map((f) => f.text);
const inBank = (bank: string, needle: string): boolean => textsOf(bank).some((t) => t.includes(needle));
/** Every request that named `bank`, as one string: what that bank was ever sent. */
const sentTo = (bank: string): string => JSON.stringify(fake.state.calls.filter((c) => c.bank === bank).map((c) => c.body));
const mirrorIdle = () => until(async () => world.system(async (tx) => ((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_mirror_pending')).rows[0]!.n === 0 ? true : null)), 'the mirror work list to empty');

const concept = (title: string, over: Record<string, string> = {}): string => {
  const fm = { type: 'Decision', title, description: `${title} in a sentence`, ...over };
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\nWe decided this.\n`;
};
const putConcept = async (team: string, who: Persona, path: string, text: string): Promise<void> => {
  const res = await world.call<{ paths: Array<{ path: string; blobSha: string | null }> }>(who, 'POST', `/api/teams/${team}/repo/commit`, { changes: [{ op: 'put', path: `memory/${path}`, content: text }], message: `Add ${path}` });
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const blob = res.body.paths.find((x) => x.path === `memory/${path}`)?.blobSha;
  await eventually(async () => (await world.system((tx) => tx.query('SELECT 1 FROM app.memory_concepts WHERE path = $1 AND blob_sha = $2', [`memory/${path}`, blob]))).rowCount === 1, 30_000, `${path} in the index`);
};
const propose = async (team: string, who: Persona, path: string, content: string): Promise<void> => {
  const res = await world.call(who, 'POST', `/api/teams/${team}/proposals`, { path, op: 'put', content, title: `Change ${path}`, applyNow: true });
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
};
const linkOf = async (shareSlug: string, destId: string, teamId = TEAM_ID): Promise<{ id: string; state: string }> =>
  until(
    async () =>
      (await world.system((tx) =>
        tx.query<{ id: string; state: string }>(
          'SELECT l.id, l.state FROM app.memory_share_links l JOIN app.memory_shares s ON s.id = l.share_id WHERE s.slug = $1 AND s.team_id = $2 AND l.dest_team_id = $3',
          [shareSlug, teamId, destId],
        ),
      )).rows[0] ?? false,
    `the link of ${shareSlug}`,
  );
const linkState = async (id: string): Promise<string> => (await world.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.memory_share_links WHERE id = $1', [id])).rows[0]))?.state ?? '';
/** The destination's decision, as its leads would make it on the Approvals row: the seed's workspace has no second lead, so the state is set in the database. */
const accept = (id: string): Promise<unknown> => world.system((tx) => tx.query(`UPDATE app.memory_share_links SET state = 'accepted', accepted_at = now() WHERE id = $1`, [id]));

const base = `/api/teams/${A}/shares`;
const runOf = async (slug: string, id: string): Promise<Run> => (await world.call<{ run: Run }>(omar, 'GET', `${base}/${slug}/runs/${id}`)).body.run;
const runToEnd = async (slug: string, wanted: string[]): Promise<Run> => {
  const started = await world.call<{ run: Run }>(omar, 'POST', `${base}/${slug}/run`);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  return until(async () => {
    const run = await runOf(slug, started.body.run.id);
    return wanted.includes(run.state) ? run : false;
  }, `run of ${slug} to reach ${wanted.join('/')}`);
};
/** Runs the share, lets the named approver (not the requester) approve, and waits for the digest to be sent. */
async function send(slug: string): Promise<Run> {
  const waiting = await runToEnd(slug, ['awaiting_approval', 'empty', 'failed', 'blocked']);
  expect(waiting.state, waiting.reason ?? '').toBe('awaiting_approval');
  expect((await world.call(nadia, 'POST', `/api/teams/${A}/approvals/${waiting.approvalId}/approve`, {})).status).toBe(200);
  return until(async () => {
    const run = await runOf(slug, waiting.id);
    return run.state === 'sent' || run.state === 'failed' ? run : false;
  }, 'the digest to be sent');
}
const deliveries = async (runId: string): Promise<string[]> =>
  (await world.system((tx) => tx.query<{ dest_team_id: string }>('SELECT dest_team_id FROM app.memory_share_deliveries WHERE run_id = $1 ORDER BY dest_team_id', [runId]))).rows.map((r) => r.dest_team_id);

beforeAll(async () => {
  fake = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
  process.env['MANYTHREADS_MEMORY_DEBOUNCE_MS'] = '0';
  process.env['MANYTHREADS_MEMORY_DEFER_MS'] = '300';
  process.env['MANYTHREADS_MIRROR_DEBOUNCE_MS'] = '0';
  world = await createWorld();
  await ensureChannels(world);
  const workspaceSlug = await world.system(async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.workspaces LIMIT 1')).rows[0]!.slug);
  BANK_A = `team:${workspaceSlug}:${A}`;
  BANK_B = `team:${workspaceSlug}:${B}`;
  BANK_C = `team:${workspaceSlug}:${C}`;
  await putConcept(A, omar, 'decisions/ship-tuesdays.md', concept(SHARED_TITLE));
  await putConcept(A, omar, 'decisions/payroll-plan.md', concept(HOME_TITLE, { share: 'never' }));
  await putConcept(A, omar, 'playbooks/oncall.md', concept(PLAYBOOK_TITLE, { type: 'Playbook' }));
  await propose(A, omar, 'routines/shares/decisions-digest.yaml', `name: Decisions\nto: [customer-support, marketing]\nselect: { paths: [decisions/], skipStale: true }\nmode: summary\napprovers: [person:${nadia.personId}]\n`);
}, 300_000);

afterAll(async () => {
  for (const name of ['MANYTHREADS_HINDSIGHT_URL', 'MANYTHREADS_MEMORY_DEBOUNCE_MS', 'MANYTHREADS_MEMORY_DEFER_MS', 'MANYTHREADS_MIRROR_DEBOUNCE_MS']) delete process.env[name];
  await world?.close();
  await fake?.close();
});

const SLUG = 'decisions-digest';
let supportLink = { id: '', state: '' };
let marketingLink = { id: '', state: '' };

describe('a team that has not accepted gets nothing', () => {
  it('opens one link for each team named, both waiting; Support accepts, Marketing does not', async () => {
    supportLink = await linkOf(SLUG, SUPPORT_ID);
    marketingLink = await linkOf(SLUG, MARKETING_ID);
    expect([supportLink.state, marketingLink.state]).toEqual(['requested', 'requested']);
    await accept(supportLink.id);
    expect(await linkState(supportLink.id)).toBe('accepted');
    expect(await linkState(marketingLink.id)).toBe('requested');
  });

  it('sends one digest and delivers it to Support alone: no delivery, no inbox item and no concept for Marketing', async () => {
    const run = await send(SLUG);
    expect(run.state, run.reason ?? '').toBe('sent');
    expect(await deliveries(run.id)).toEqual([SUPPORT_ID]);
    const items = await world.system((tx) => tx.query<{ team_id: string; origin: string }>("SELECT team_id, origin FROM app.memory_inbox_items WHERE origin = 'share' ORDER BY team_id"));
    expect(items.rows).toEqual([{ team_id: SUPPORT_ID, origin: 'share' }]);
    const marketing = await world.system((tx) => tx.query("SELECT 1 FROM app.memory_concepts WHERE team_id = $1 AND (path LIKE 'memory/shared/%' OR origin = 'share')", [MARKETING_ID]));
    expect(marketing.rowCount).toBe(0);
  });
});

describe('what arrives, arrives in one bank', () => {
  it('Support’s own memory gets the digest under memory/shared/team-engineering/, unverified, and its bank is fed it', async () => {
    const row = await until(
      async () =>
        (await world.system((tx) => tx.query<{ origin: string; trust_tier: string; from_team: string | null }>("SELECT origin, trust_tier, from_team FROM app.memory_concepts WHERE team_id = $1 AND path = 'memory/shared/team-engineering/digest.md'", [SUPPORT_ID]))).rows[0] ?? false,
      'the digest in Support’s memory',
    );
    expect(row).toMatchObject({ origin: 'share', trust_tier: 'unverified', from_team: TEAM_ID });
    await until(async () => inBank(BANK_B, SHARED_TITLE), 'the digest in Support’s bank');
    await mirrorIdle();
    const fact = (fake.state.banks.get(BANK_B) ?? []).find((f) => f.text.includes(SHARED_TITLE))!;
    expect(fact.metadata).toMatchObject({ team: B, feed_kind: 'concept', concept_path: 'memory/shared/team-engineering/digest.md' });
  });

  it('is in no other bank: Marketing’s bank was never sent a word of it, and Engineering’s holds no copy under Support’s name', async () => {
    expect(inBank(BANK_C, 'Kestrel')).toBe(false);
    expect(sentTo(BANK_C)).not.toMatch(/Kestrel|digest/i);
    for (const f of fake.state.banks.get(BANK_A) ?? []) if (f.metadata['feed_kind'] === 'concept') expect(String(f.metadata['concept_path']), f.text).not.toMatch(/^memory\/shared\//);
  });

  it('keeps what the sender kept: the share: never concept and the folder the share did not name reach no bank but Engineering’s', async () => {
    await until(async () => inBank(BANK_A, 'Heron payroll'), 'the sender’s own concept in its own bank');
    for (const [needle, banks] of [[HOME_TITLE, [BANK_B, BANK_C]], [PLAYBOOK_TITLE, [BANK_B, BANK_C]]] as const) {
      for (const bank of banks) {
        expect(inBank(bank, needle.split(' ')[0]!), `${needle} in ${bank}`).toBe(false);
        expect(sentTo(bank), `${needle} sent to ${bank}`).not.toContain(needle.split(' ')[0]!);
      }
    }
    const bundle = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string> }>('SELECT bundle FROM app.memory_share_runs WHERE share_id = (SELECT id FROM app.memory_shares WHERE slug = $1 AND team_id = $2) ORDER BY id DESC LIMIT 1', [SLUG, TEAM_ID])).rows[0]?.bundle);
    expect(JSON.stringify(bundle)).not.toMatch(/Heron|Osprey/);
    expect(bundle?.['digest.md']).toContain(SHARED_TITLE);
  });

  it('every concept in each bank names its own team, and none is a copy of another team’s file', async () => {
    for (const [bank, team] of [[BANK_A, A], [BANK_B, B], [BANK_C, C]] as const) {
      for (const f of fake.state.banks.get(bank) ?? []) {
        if (f.metadata['feed_kind'] === 'concept') expect(f.metadata['team'], f.text).toBe(team);
      }
    }
  });
});

describe('who can see the delivery', () => {
  it('Marketing’s lead cannot read Support’s inbox or its incoming shares, and Support’s people cannot read Engineering’s shares', async () => {
    expect((await world.call(tariq, 'GET', `/api/teams/${B}/inbox/items`)).status).toBeGreaterThanOrEqual(403);
    expect((await world.call(tariq, 'GET', `/api/teams/${B}/shares/incoming`)).status).toBeGreaterThanOrEqual(403);
    expect((await world.call(sameera, 'GET', `/api/teams/${A}/shares`)).status).toBeGreaterThanOrEqual(403);
    expect((await world.call(lena, 'GET', `/api/teams/${B}/shares/incoming`)).status).toBeGreaterThanOrEqual(403);
  });

  it('Marketing sees its own waiting link and nothing of Support’s; Support sees its accepted one', async () => {
    const marketing = await world.call<{ incoming: Array<{ id: string; state: string; fromSlug: string }> }>(tariq, 'GET', `/api/teams/${C}/shares/incoming`);
    expect(marketing.body.incoming.map((i) => [i.id, i.state, i.fromSlug])).toEqual([[marketingLink.id, 'requested', A]]);
    const support = await world.call<{ incoming: Array<{ id: string; state: string }> }>(sameera, 'GET', `/api/teams/${B}/shares/incoming`);
    expect(support.body.incoming.map((i) => [i.id, i.state])).toEqual([[supportLink.id, 'accepted']]);
  });

  it('the digest names neither team that receives it', async () => {
    const stored = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string> }>('SELECT bundle FROM app.memory_share_runs WHERE share_id = (SELECT id FROM app.memory_shares WHERE slug = $1 AND team_id = $2) ORDER BY id DESC LIMIT 1', [SLUG, TEAM_ID])).rows[0]?.bundle);
    expect(JSON.stringify(stored)).not.toMatch(/customer.support|marketing/i);
  });
});

describe('the receiving team can stop it', () => {
  const act = (action: string) => world.call<{ link: { state: string } }>(omar, 'POST', `/api/teams/${B}/shares/incoming/${supportLink.id}/${action}`, {});

  it('a paused link delivers nothing: the next run has no one to go to, and the new concept reaches no bank of another team', async () => {
    expect((await act('pause')).body.link.state).toBe('paused');
    await putConcept(A, omar, 'decisions/freeze.md', concept(LATER_TITLE));
    const run = await runToEnd(SLUG, ['empty', 'awaiting_approval', 'failed', 'blocked']);
    expect(run.state, run.reason ?? '').toBe('empty');
    expect(await deliveries(run.id)).toEqual([]);
    await mirrorIdle();
    for (const bank of [BANK_B, BANK_C]) {
      expect(inBank(bank, 'Nighthawk'), bank).toBe(false);
      expect(sentTo(bank), bank).not.toContain('Nighthawk');
    }
  });

  it('a resumed link delivers again, with what changed', async () => {
    expect((await act('resume')).body.link.state).toBe('accepted');
    const run = await send(SLUG);
    expect(run.state, run.reason ?? '').toBe('sent');
    expect(await deliveries(run.id)).toEqual([SUPPORT_ID]);
    await until(async () => inBank(BANK_B, LATER_TITLE), 'the later digest in Support’s bank');
    expect(inBank(BANK_C, 'Nighthawk')).toBe(false);
  });

  it('an ended link stays ended: a new run goes to no one, and naming the team in the file again does not reopen it', async () => {
    expect((await act('revoke')).body.link.state).toBe('revoked');
    await propose(A, omar, `routines/shares/${SLUG}.yaml`, `name: Decisions again\nto: [customer-support, marketing]\nselect: { paths: [decisions/], skipStale: true }\nmode: summary\napprovers: [person:${nadia.personId}]\n`);
    await eventually(async () => (await world.call<{ shares: Array<{ slug: string; name: string }> }>(omar, 'GET', base)).body.shares.some((s) => s.slug === SLUG && s.name === 'Decisions again'), 30_000, 'the changed file');
    expect(await linkState(supportLink.id)).toBe('revoked');
    expect(await linkState(marketingLink.id)).toBe('requested');
  });
});

describe('a digest is never passed on', () => {
  it('Support cannot forward what Engineering sent: a share that names memory/shared/ leaves it out as received', async () => {
    await propose(B, omar, 'routines/shares/forward.yaml', 'name: Forward\nto: [marketing]\nselect: { paths: [shared/] }\nmode: full\n');
    await until(async () => (await world.call<{ shares: Array<{ slug: string; status: string }> }>(omar, 'GET', `/api/teams/${B}/shares`)).body.shares.find((s) => s.slug === 'forward')?.status === 'active', 'the forward share');
    const res = await world.call<{ preview: { counts: { matched: number; included: number; leftOut: number }; excluded: Array<{ path: string; reason?: string }> } }>(omar, 'GET', `/api/teams/${B}/shares/forward/preview`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.preview.counts.included).toBe(0);
    expect(res.body.preview.excluded.length).toBeGreaterThan(0);
    for (const e of res.body.preview.excluded) expect(e.reason, e.path).toBe('received');
  });
});
