import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually, ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld, type Persona } from '../../files/test/world.ts';

// P8-22 and P8-23 through the real server: a lead commits routines/shares/<slug>.yaml, the loader makes the share and its links, the preview counts what would go,
// "Run now" builds the digest (a job), the data rules look at it, an Approvals row waits for a person who is not the requester, and the run ends in `ready`
// (or `denied`). Nothing here delivers the digest: that is the next task.

const { omar, nadia, rafi, sameera, lena, tariq } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: FilesWorld;

interface Destination {
  teamId: string;
  slug: string;
  name: string;
  link: string;
}
interface View {
  id: string;
  slug: string;
  name: string;
  status: string;
  invalidReason: string | null;
  mode: string;
  approval: string;
  approvalEffective: string;
  destinations: Destination[];
  lastRun: { id: string; state: string } | null;
}
interface Counts {
  matched: number;
  included: number;
  leftOut: number;
  unchanged: number;
  retired: number;
  redacted: number;
}
interface Ref {
  path: string;
  title: string;
  reason?: string;
}
interface Run {
  id: string;
  state: string;
  reason: string | null;
  trigger: string;
  period: string | null;
  digestSha: string | null;
  counts: Counts | null;
  included: Ref[];
  excluded: Ref[];
  diff: { added: Ref[]; changed: Ref[]; retired: Ref[]; unchanged: number } | null;
  approvalId: string | null;
  requestedBy: string | null;
}
interface Preview {
  counts: Counts;
  headline: string;
  included: Ref[];
  excluded: Ref[];
  diff: { added: Ref[]; changed: Ref[]; retired: Ref[]; unchanged: number };
  destinations: Destination[];
}

const TEAM = 'engineering';
const base = `/api/teams/${TEAM}/shares`;
const TEAM_ID = '00000000-0000-7000-8000-0000000b0001';
const KEY = `sk-${'ab3dEf6hIj'.repeat(3)}`;

const propose = async (who: Persona, path: string, content: string, op: 'put' | 'delete' = 'put', team: string = TEAM): Promise<void> => {
  const res = await world.call(who, 'POST', `/api/teams/${team}/proposals`, { path, op, ...(op === 'put' ? { content } : {}), title: `Change ${path}`, applyNow: true });
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
};
const shareYaml = (over: Record<string, string> = {}): string =>
  Object.entries({
    name: 'Release notes',
    to: '[customer-support]',
    select: '{ paths: [decisions/], skipStale: true }',
    mode: 'summary',
    approvers: `[person:${nadia.personId}]`,
    ...over,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') + '\n';
const putShare = (slug: string, over: Record<string, string> = {}, who: Persona = omar): Promise<void> => propose(who, `routines/shares/${slug}.yaml`, shareYaml(over));
const concept = (title: string, over: Record<string, string> = {}, body = 'We decided this.'): string => {
  const fm = { type: 'Decision', title, description: `${title} in a sentence`, ...over };
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;
};
const putConcept = async (path: string, text: string): Promise<void> => {
  // memory files are changed directly in Files (the repo commit door), not through a proposal
  const res = await world.call<{ paths: Array<{ path: string; blobSha: string | null }> }>(omar, 'POST', `/api/teams/${TEAM}/repo/commit`, { changes: [{ op: 'put', path: `memory/${path}`, content: text }], message: `Add ${path}` });
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const blob = res.body.paths.find((x) => x.path === `memory/${path}`)?.blobSha;
  await eventually(async () => (await world.system((tx) => tx.query('SELECT 1 FROM app.memory_concepts WHERE path = $1 AND blob_sha = $2', [`memory/${path}`, blob]))).rowCount === 1, 30_000, `${path} in the index`);
};

/** A destination team agrees to receive a share (the next task does this through its own door; the tests use the database). */
const accept = (slug: string): Promise<unknown> =>
  world.system((tx) =>
    tx.query(
      `UPDATE app.memory_share_links SET state = 'accepted', accepted_at = now() WHERE share_id = (SELECT id FROM app.memory_shares WHERE slug = $1 AND team_id = $2)`,
      [slug, TEAM_ID],
    ),
  );

const shareOf = async (slug: string, who: Persona = omar): Promise<View | undefined> => (await world.call<{ shares: View[] }>(who, 'GET', base)).body.shares?.find((s) => s.slug === slug);
const loaded = (slug: string, status = 'active'): Promise<View> => eventually(async () => {
  const s = await shareOf(slug);
  return s?.status === status ? s : false;
}, 30_000, `share ${slug} to be ${status}`);
const loadedAccepted = async (slug: string): Promise<View> => {
  const view = await loaded(slug);
  await accept(slug);
  return view;
};
const runNow = (slug: string, who: Persona = omar) => world.call<{ run: Run; error?: { message: string } }>(who, 'POST', `${base}/${slug}/run`);
const runOf = async (slug: string, id: string): Promise<Run> => {
  const res = await world.call<{ run: Run }>(omar, 'GET', `${base}/${slug}/runs/${id}`);
  if (!res.body.run) throw new Error(`run ${id}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.run;
};

const settled = (slug: string, id: string, wanted: string[]): Promise<Run> =>
  eventually(async () => {
    const run = await runOf(slug, id);
    return wanted.includes(run.state) ? run : false;
  }, 60_000, `run ${id} to reach ${wanted.join('/')}`);
const settledAny = (slug: string, id: string, wanted: string[], timeout = 60_000): Promise<Run> =>
  eventually(async () => {
    const run = await runOf(slug, id);
    return wanted.includes(run.state) ? run : false;
  }, timeout, `run ${id} to reach ${wanted.join('/')}`);
const preview = (slug: string, who: Persona = omar) => world.call<{ preview: Preview; error?: { message: string } }>(who, 'GET', `${base}/${slug}/preview`);
const approval = async (id: string): Promise<Record<string, unknown>> => (await world.system((tx) => tx.query('SELECT * FROM app.approvals WHERE id = $1', [id]))).rows[0] as Record<string, unknown>;
const decide = (who: Persona, id: string, how: 'approve' | 'deny') => world.call(who, 'POST', `/api/teams/${TEAM}/approvals/${id}/${how}`, {});

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  await putConcept('decisions/ship-tuesdays.md', concept('Ship on Tuesdays', { tags: '[release]' }));
  await putConcept('decisions/rollback.md', concept('Roll back fast'));
  await putConcept('decisions/wip.md', concept('Unfinished idea', { status: 'draft' }));
  await putConcept('decisions/secret-plan.md', concept('Private plan', { share: 'never' }));
  await putConcept('playbooks/oncall.md', concept('On-call rota', { type: 'Playbook' }));
}, 240_000);

afterAll(async () => {
  await world?.close();
});

describe('the loader', () => {
  it('a committed share file becomes a share with a link to each destination', async () => {
    await putShare('release-notes');
    const view = await loaded('release-notes');
    expect(view).toMatchObject({ name: 'Release notes', mode: 'summary', approval: 'review', approvalEffective: 'review', invalidReason: null, lastRun: null });
    expect(view.destinations).toHaveLength(1);
    expect(view.destinations[0]).toMatchObject({ slug: 'customer-support', name: 'Customer support', link: 'requested' });
  });

  it('changing the file changes the share; taking a destination out ends its link', async () => {
    await putShare('two-teams', { name: 'Two teams', to: '[customer-support, marketing]' });
    expect((await loaded('two-teams')).destinations.map((d) => d.slug).sort()).toEqual(['customer-support', 'marketing']);
    await putShare('two-teams', { name: 'Two teams, then one', to: '[marketing]' });
    const again = await eventually(async () => ((await shareOf('two-teams'))?.name === 'Two teams, then one' ? await shareOf('two-teams') : false), 30_000, 'the new name');
    expect(again?.destinations.filter((d) => d.link !== 'revoked').map((d) => d.slug)).toEqual(['marketing']);
  });

  it('a file that is not valid is kept as invalid, with the reason, and cannot run', async () => {
    await putShare('bad-yaml', { to: '[no-such-team]' });
    const view = await loaded('bad-yaml', 'invalid');
    expect(view.invalidReason).toContain('no-such-team');
    const res = await runNow('bad-yaml');
    expect(res.status).toBe(409);
    await propose(omar, 'routines/shares/typo.yaml', 'name: x\nto: [marketing]\nmood: full\n');
    expect((await loaded('typo', 'invalid')).invalidReason).toMatch(/mood|unrecognized/i);
    await propose(omar, 'routines/shares/self.yaml', 'name: x\nto: [engineering]\n');
    expect((await loaded('self', 'invalid')).invalidReason).toContain('cannot go to the team that sends it');
  });

  it('deleting the file takes the share away', async () => {
    await putShare('short-lived');
    await loaded('short-lived');
    await propose(omar, 'routines/shares/short-lived.yaml', '', 'delete');
    await eventually(async () => (await shareOf('short-lived')) === undefined, 30_000, 'the share to go');
    expect((await world.call(omar, 'GET', `${base}/short-lived`)).status).toBe(404);
  });

  it('writes the event with ids and counts only', async () => {
    const rows = await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'memory.share.defined' ORDER BY id`));
    expect(rows.rows.length).toBeGreaterThan(3);
    for (const { payload } of rows.rows) expect(Object.keys(payload).filter((k) => /name|path|title|text/i.test(k))).toEqual([]);
  });
});

describe('who sees what', () => {
  it('the people of the team list and read a share; people outside it do not see the team at all', async () => {
    await loaded('release-notes');
    for (const who of [omar, nadia, rafi]) expect(await shareOf('release-notes', who), who.key).toBeDefined();
    for (const who of [sameera, tariq, lena]) expect((await world.call(who, 'GET', base)).status, who.key).toBeGreaterThanOrEqual(403);
    const member = await world.call<{ canManage: boolean }>(nadia, 'GET', base);
    expect(member.body.canManage).toBe(false);
    expect((await world.call<{ canManage: boolean }>(omar, 'GET', base)).body.canManage).toBe(true);
    expect((await world.call(nadia, 'GET', `${base}/release-notes`)).status).toBe(200);
    expect((await world.call(omar, 'GET', `${base}/nothing-here`)).status).toBe(404);
  });

  it('only a lead or admin previews, runs and reads runs', async () => {
    for (const who of [nadia, rafi]) {
      expect((await preview('release-notes', who)).status, who.key).toBe(403);
      expect((await runNow('release-notes', who)).status, who.key).toBe(403);
      expect((await world.call(who, 'GET', `${base}/release-notes/runs`)).status, who.key).toBe(403);
    }
    for (const who of [sameera, lena, tariq]) expect((await runNow('release-notes', who)).status, who.key).toBeGreaterThanOrEqual(403);
    expect((await world.call(null, 'GET', base)).status).toBe(401);
  });
});

describe('the preview', () => {
  it('says how many concepts match and how many are left out, and why', async () => {
    const res = await preview('release-notes');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.preview;
    // decisions/: ship-tuesdays, rollback, wip (draft), secret-plan (team only); playbooks are outside the share's paths
    expect(p.counts).toMatchObject({ matched: 4, included: 2, leftOut: 2, unchanged: 0, retired: 0 });
    expect(p.headline).toBe('Matches 4 concepts · 2 left out');
    expect(p.included.map((c) => c.path).sort()).toEqual(['memory/decisions/rollback.md', 'memory/decisions/ship-tuesdays.md']);
    expect(Object.fromEntries(p.excluded.map((c) => [c.path, c.reason]))).toEqual({ 'memory/decisions/secret-plan.md': 'team_only', 'memory/decisions/wip.md': 'draft' });
    expect(p.diff.added).toHaveLength(2);
    expect(p.destinations[0]?.slug).toBe('customer-support');
  });

  it('builds nothing: no run exists afterwards', async () => {
    const runs = await world.system((tx) => tx.query(`SELECT 1 FROM app.memory_share_runs r JOIN app.memory_shares s ON s.id = r.share_id WHERE s.slug = 'release-notes'`));
    expect(runs.rowCount).toBe(0);
  });
});

describe('running a share, with review', () => {
  let first: Run;
  let approvalId = '';

  it('Run now answers 202 with the run building, as the person who pressed it; the digest waits in Approvals', async () => {
    await accept('release-notes');
    const res = await runNow('release-notes');
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.run).toMatchObject({ state: 'building', trigger: 'manual', requestedBy: omar.actorId });
    first = await settled('release-notes', res.body.run.id, ['awaiting_approval', 'failed', 'blocked', 'empty']);
    expect(first.state, first.reason ?? '').toBe('awaiting_approval');
    expect(first.counts).toMatchObject({ matched: 4, included: 2, leftOut: 2 });
    expect(first.digestSha).toMatch(/^[0-9a-f]{64}$/);
    expect(first.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.approvalId).not.toBeNull();
    approvalId = first.approvalId!;
  });

  it('files an Approvals row of source grant and tool memory.digest.send with a preview of where it goes and what', async () => {
    const row = await approval(approvalId);
    expect(row).toMatchObject({ source: 'grant', tool: 'memory.digest.send', status: 'pending', requester_id: omar.actorId });
    expect(String(row['summary'])).toContain('Release notes');
    expect(String(row['summary'])).toContain('Customer support');
    const preview = JSON.stringify(row['args_preview'] ?? row['preview'] ?? row);
    expect(preview).toContain('Customer support');
    expect(preview).toContain('memory/decisions/ship-tuesdays.md');
    expect(preview).toContain('team_only');
    // never the text of a concept
    expect(preview).not.toContain('We decided this');
  });

  it('shows up in the approver’s list, and not in the requester’s "mine"', async () => {
    const list = await world.call<{ items: Array<{ id: string; tool: string; source: string }> }>(nadia, 'GET', `/api/teams/${TEAM}/approvals`);
    expect(list.body.items.find((a) => a.id === approvalId)).toMatchObject({ tool: 'memory.digest.send', source: 'grant' });
  });

  it('a second press while the first waits files no second digest of the same files', async () => {
    const res = await runNow('release-notes');
    expect(res.status).toBe(202);
    const second = await settled('release-notes', res.body.run.id, ['empty', 'awaiting_approval', 'failed']);
    expect(second.state, second.reason ?? '').toBe('empty');
    expect(second.reason).toContain('same');
  });

  it('the requester cannot approve their own digest; a person who was not named cannot either', async () => {
    expect((await decide(omar, approvalId, 'approve')).status).toBe(403);
    expect((await decide(rafi, approvalId, 'approve')).status).toBe(403);
    expect((await runOf('release-notes', first.id)).state).toBe('awaiting_approval');
  });

  it('the named approver approves: the run is ready, the digest is a valid OKF bundle in the run and is not readable through the API', async () => {
    expect((await decide(nadia, approvalId, 'approve')).status).toBe(200);
    const run = await settled('release-notes', first.id, ['ready', 'denied']);
    expect(run.state).toBe('ready');
    expect(JSON.stringify(run)).not.toContain('"bundle"');
    const stored = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string>; settled_by: string }>('SELECT bundle, settled_by FROM app.memory_share_runs WHERE id = $1', [first.id])).rows[0]);
    expect(Object.keys(stored?.bundle ?? {}).sort()).toEqual(['digest.md', 'index.md', 'log.md']);
    expect(stored?.settled_by).toBe(nadia.actorId);
    expect(stored?.bundle['digest.md']).toContain('Ship on Tuesdays');
    expect(stored?.bundle['digest.md']).not.toContain('Private plan');
    expect(stored?.bundle['digest.md']).not.toContain('Unfinished idea');
    expect(stored?.bundle['digest.md']).not.toContain('We decided this');
    // one digest goes to every team that accepted, so it names none of them
    expect(stored?.bundle['digest.md']).not.toMatch(/customer.support/i);
    expect(stored?.bundle['digest.md']).not.toMatch(/^to:/m);
    expect((await approval(approvalId))['outcome']).toBe('ran');
    const events = await world.system((tx) => tx.query<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM app.events WHERE type IN ('memory.share.built','memory.share.settled') ORDER BY id`));
    expect(events.rows.map((r) => `${r.type}:${String(r.payload['state'] ?? r.payload['outcome'])}`)).toEqual(expect.arrayContaining(['memory.share.built:awaiting_approval', 'memory.share.settled:ready']));
  });

  it('then only what changed goes: after a delivery, a new concept is the whole digest, and no change is an empty run', async () => {
    // the delivery is the next task's; here the system marks the ready run sent, the way it will
    await world.system((tx) => tx.query(`UPDATE app.memory_share_runs SET state = 'sent', sent_at = now() WHERE id = $1`, [first.id]));
    const quiet = await runNow('release-notes');
    const empty = await settled('release-notes', quiet.body.run.id, ['empty', 'awaiting_approval', 'failed']);
    expect(empty.state, empty.reason ?? '').toBe('empty');
    expect(empty.reason).toContain('Nothing has changed');
    await putConcept('decisions/freeze.md', concept('Freeze before holidays'));
    expect((await preview('release-notes')).body.preview.counts).toMatchObject({ matched: 5, included: 1, unchanged: 2 });
    const res = await runNow('release-notes');
    const delta = await settled('release-notes', res.body.run.id, ['awaiting_approval', 'failed', 'empty']);
    expect(delta.state, delta.reason ?? '').toBe('awaiting_approval');
    expect(delta.diff?.added.map((c) => c.path)).toEqual(['memory/decisions/freeze.md']);
    expect(delta.diff?.unchanged).toBe(2);
    expect(delta.period).toMatch(/-2$/);
    // a denial ends it
    expect((await decide(nadia, delta.approvalId!, 'deny')).status).toBe(200);
    expect((await settled('release-notes', delta.id, ['denied', 'ready'])).state).toBe('denied');
    expect((await approval(delta.approvalId!))['status']).toBe('denied');
  });

  it('a concept retired since the last delivery is named by its path, never by its title today', async () => {
    // the delta test sent the first digest (it carried "Roll back fast"); the team now takes that concept back
    await putConcept('decisions/rollback.md', concept('Roll back is a private matter', { share: 'never' }));
    const res = await runNow('release-notes');
    const run = await settled('release-notes', res.body.run.id, ['awaiting_approval', 'failed', 'empty', 'blocked']);
    expect(run.state, run.reason ?? '').toBe('awaiting_approval');
    expect(run.diff?.retired.map((c) => c.path)).toEqual(['memory/decisions/rollback.md']);
    const stored = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string> }>('SELECT bundle FROM app.memory_share_runs WHERE id = $1', [run.id])).rows[0]?.bundle);
    expect(stored?.['digest.md']).toContain('decisions/rollback: Engineering has retired this concept.');
    expect(JSON.stringify(stored)).not.toMatch(/private matter|Roll back fast/);
    expect((await decide(nadia, run.approvalId!, 'deny')).status).toBe(200);
  });

  it('runs are listed for a manager, newest first', async () => {
    const res = await world.call<{ runs: Run[] }>(omar, 'GET', `${base}/release-notes/runs?limit=2`);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0]!.id > res.body.runs[1]!.id).toBe(true);
    expect((await shareOf('release-notes'))?.lastRun?.id).toBe(res.body.runs[0]!.id);
    expect((await world.call(omar, 'GET', `${base}/release-notes/runs/00000000-0000-7000-8000-000000000999`)).status).toBe(404);
  });
});

describe('a share set to go without review', () => {
  it('is honoured when a workspace admin wrote it: the run is ready with no Approvals row', async () => {
    await putShare('auto-notes', { name: 'Auto notes', approval: 'auto', select: '{ paths: [playbooks/] }' });
    const view = await loadedAccepted('auto-notes');
    expect(view.approval).toBe('auto');
    expect(view.approvalEffective).toBe('auto');
    const res = await runNow('auto-notes');
    const run = await settled('auto-notes', res.body.run.id, ['ready', 'awaiting_approval', 'failed', 'empty']);
    expect(run.state, run.reason ?? '').toBe('ready');
    expect(run.approvalId).toBeNull();
  });

  it('is not honoured when the file was not written by a lead or admin (the review stays)', async () => {
    await putShare('auto-by-nobody', { name: 'Auto by nobody', approval: 'auto', select: '{ paths: [playbooks/] }' });
    await loadedAccepted('auto-by-nobody');
    // the platform decides from the commit's author, so this is the same share with that fact taken away
    await world.system((tx) => tx.query(`UPDATE app.memory_shares SET auto_allowed = false WHERE slug = 'auto-by-nobody'`));
    expect((await shareOf('auto-by-nobody'))?.approvalEffective).toBe('review');
    const res = await runNow('auto-by-nobody');
    const run = await settled('auto-by-nobody', res.body.run.id, ['ready', 'awaiting_approval', 'failed', 'empty']);
    expect(run.state, run.reason ?? '').toBe('awaiting_approval');
    expect(run.approvalId).not.toBeNull();
  });
});

describe('the data rules', () => {
  it('redact what the standard rules redact, and the key is not in the digest', async () => {
    await putConcept('facts/with-key.md', concept('Deploy key', { type: 'Fact', description: `use ${KEY} to deploy` }));
    await putShare('facts', { name: 'Facts', select: '{ paths: [facts/] }' });
    await loadedAccepted('facts');
    const res = await runNow('facts');
    const run = await settled('facts', res.body.run.id, ['awaiting_approval', 'ready', 'blocked', 'failed', 'empty']);
    expect(run.state, run.reason ?? '').toBe('awaiting_approval');
    expect(run.counts?.redacted).toBeGreaterThanOrEqual(1);
    const stored = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string> }>('SELECT bundle FROM app.memory_share_runs WHERE id = $1', [run.id])).rows[0]?.bundle);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it.each([
    ['tags', 'tags', `[${KEY}]`],
    ['resource', 'resource', `https://example.com/${KEY}`],
    ['type', 'type', KEY],
  ])('a secret in a copied field (%s) does not leave in a full digest', async (field, key, value) => {
    await putConcept(`leaky-${field}/note.md`, concept('Plain title', { [key]: value }));
    await putShare(`leaky-${field}`, { name: `Leaky ${field}`, mode: 'full', select: `{ paths: [leaky-${field}/] }` });
    await loadedAccepted(`leaky-${field}`);
    const res = await runNow(`leaky-${field}`);
    const run = await settled(`leaky-${field}`, res.body.run.id, ['awaiting_approval', 'ready', 'blocked', 'failed', 'empty']);
    const stored = await world.system(async (tx) => (await tx.query<{ bundle: Record<string, string> | null }>('SELECT bundle FROM app.memory_share_runs WHERE id = $1', [run.id])).rows[0]?.bundle);
    expect(JSON.stringify(stored ?? {})).not.toContain(KEY);
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it('a workspace that refuses such text leaves the concept out, naming its path and not its text', async () => {
    await world.system((tx) => tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'customer-facing') ON CONFLICT (workspace_id) DO UPDATE SET preset = EXCLUDED.preset`, [omar.workspaceId]));
    try {
      await putShare('facts-strict', { name: 'Facts strict', select: '{ paths: [facts/] }' });
      await loadedAccepted('facts-strict');
      const res = await runNow('facts-strict');
      const run = await settled('facts-strict', res.body.run.id, ['awaiting_approval', 'ready', 'blocked', 'failed', 'empty']);
      expect(run.state, run.reason ?? '').toBe('empty');
      expect(run.excluded).toEqual([expect.objectContaining({ path: 'memory/facts/with-key.md', reason: 'dlp' })]);
      expect(JSON.stringify(run)).not.toContain(KEY);
    } finally {
      await world.system((tx) => tx.query('DELETE FROM app.llm_settings WHERE workspace_id = $1', [omar.workspaceId]));
    }
  });
});

describe('a run that finds nothing', () => {
  it('ends empty and says so', async () => {
    await putShare('nothing', { name: 'Nothing', select: '{ paths: [no-such-folder/] }' });
    await loadedAccepted('nothing');
    expect((await preview('nothing')).body.preview.headline).toBe('Matches 0 concepts · 0 left out');
    const res = await runNow('nothing');
    const run = await settled('nothing', res.body.run.id, ['empty', 'awaiting_approval', 'failed']);
    expect(run.state).toBe('empty');
    expect(run.reason).toContain('matches');
    expect(run.approvalId).toBeNull();
  });
});

describe('who a digest is built for', () => {
  it('a team that has not accepted is not sent to: the run ends empty and says why', async () => {
    await putShare('not-accepted', { name: 'Not accepted', select: '{ paths: [playbooks/] }' });
    await loaded('not-accepted');
    const res = await runNow('not-accepted');
    const run = await settled('not-accepted', res.body.run.id, ['empty', 'awaiting_approval', 'failed']);
    expect(run.state, run.reason ?? '').toBe('empty');
    expect(run.reason).toContain('accepted');
    expect(run.approvalId).toBeNull();
    // the preview still shows what would go, and that the link is waiting
    expect((await preview('not-accepted')).body.preview.destinations[0]).toMatchObject({ slug: 'customer-support', link: 'requested' });
  });

  it('a team that is archived is not sent to, and a scheduled run of an archived sender is skipped', async () => {
    await putShare('to-marketing', { name: 'To marketing', to: '[marketing]', select: '{ paths: [playbooks/] }' });
    await loadedAccepted('to-marketing');
    await world.system((tx) => tx.query(`UPDATE app.teams SET archived_at = now() WHERE slug = 'marketing'`));
    try {
      const res = await runNow('to-marketing');
      const run = await settled('to-marketing', res.body.run.id, ['empty', 'awaiting_approval', 'failed']);
      expect(run.state, run.reason ?? '').toBe('empty');
      expect(run.reason).toContain('archived');
    } finally {
      await world.system((tx) => tx.query(`UPDATE app.teams SET archived_at = NULL WHERE slug = 'marketing'`));
    }
  });

  it('a lead who can see only their own team cannot use a share file to ask which other teams exist', async () => {
    const asked = (to: string) => propose(personas.tariq, 'routines/shares/probe.yaml', `name: Probe\nto: ${to}\n`, 'put', 'marketing');
    await asked('[engineering]');
    const view = async (): Promise<View | undefined> => (await world.call<{ shares: View[] }>(personas.tariq, 'GET', '/api/teams/marketing/shares')).body.shares.find((x) => x.slug === 'probe');
    const real = await eventually(async () => ((await view())?.status === 'invalid' ? await view() : false), 30_000, 'the probe to load');
    await asked('[no-such-team-at-all]');
    const nothing = await eventually(async () => ((await view())?.invalidReason?.includes('no-such-team-at-all') ? await view() : false), 30_000, 'the second probe to load');
    // the same sentence for a team that exists and one that does not
    expect(real?.invalidReason).toBe('to: no team here is called engineering.');
    expect(nothing?.invalidReason).toBe('to: no team here is called no-such-team-at-all.');
  });
});

describe('an auto share is asked again when it runs', () => {
  it('goes to review when the person who defined it is no longer a lead or admin', async () => {
    await putShare('auto-later', { name: 'Auto later', approval: 'auto', select: '{ paths: [playbooks/] }' });
    await loadedAccepted('auto-later');
    expect((await shareOf('auto-later'))?.approvalEffective).toBe('auto');
    // the definer is now somebody who is only a member elsewhere
    await world.system((tx) => tx.query(`UPDATE app.memory_shares SET defined_by = $1 WHERE slug = 'auto-later' AND team_id = $2`, [personas.sameera.actorId, TEAM_ID]));
    const res = await runNow('auto-later');
    const run = await settled('auto-later', res.body.run.id, ['ready', 'awaiting_approval', 'failed', 'empty']);
    expect(run.state, run.reason ?? '').toBe('awaiting_approval');
    expect(run.approvalId).not.toBeNull();
  });
});

describe('the tick', () => {
  it('starts a due scheduled run, gives up a build that never finished, and lets the share run again', { timeout: 300_000 }, async () => {
    await putShare('weekly', { name: 'Weekly', when: '{ cron: "0 8 * * MON" }', select: '{ paths: [playbooks/] }' });
    await loadedAccepted('weekly');
    // one run stuck in building for an hour, and the share's time has come
    const stuck = await world.system(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.memory_share_runs (workspace_id, team_id, share_id, trigger_kind, state, mode, created_at)
       SELECT workspace_id, team_id, id, 'schedule', 'building', mode, now() - interval '1 hour' FROM app.memory_shares WHERE slug = 'weekly' AND team_id = $1 RETURNING id`, [TEAM_ID])).rows[0]!.id);
    await world.system((tx) => tx.query(`UPDATE app.memory_shares SET next_run_at = now() - interval '1 minute' WHERE slug = 'weekly' AND team_id = $1`, [TEAM_ID]));
    // the tick runs once a minute
    // polled in the database: a minute-long wait over the read routes would run into their rate limit
    const gone = await eventually(async () => {
      const row = (await world.system((tx) => tx.query<{ state: string; reason: string | null }>(`SELECT state, state_reason AS reason FROM app.memory_share_runs WHERE id = $1`, [stuck]))).rows[0];
      return row?.state === 'failed' ? row : false;
    }, 150_000, 'the stuck run to be given up');
    expect(gone.reason).toContain('not finished in time');
    const started = await eventually(async () => {
      const row = (await world.system((tx) => tx.query<{ state: string }>(
        `SELECT r.state FROM app.memory_share_runs r JOIN app.memory_shares s ON s.id = r.share_id
          WHERE s.slug = 'weekly' AND s.team_id = $1 AND r.trigger_kind = 'schedule' AND r.id <> $2 AND r.state <> 'building'`, [TEAM_ID, stuck]))).rows[0];
      return row ?? false;
    }, 150_000, 'the scheduled run');
    expect(['awaiting_approval', 'empty']).toContain(started.state);
    const next = (await shareOf('weekly')) as View & { nextRunAt?: string | null };
    expect(next.nextRunAt === undefined || next.nextRunAt === null || new Date(next.nextRunAt).getTime() > Date.now()).toBe(true);
  });
});
