import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool, emit } from '@manythreads/kernel';
import type { PluginRuns } from '@manythreads/sdk';
import { McpRunMintResponse } from '@manythreads/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHindsight, type FakeHindsight } from '../../../../../tools/fake-hindsight/src/server.ts';
import { createWorld, ensureChannels, personas, type World } from '../../../channels/test/world.ts';

// `pnpm test:memory-cross-team`, the feeding half (PLAN P5-13, P5-15; SPEC 12.1): what the platform feeds into team memory lands in the bank of
// the team it belongs to and in no other — whatever an event claims — and never carries a private channel, a DM or a person-scoped run. The
// engine is tools/fake-hindsight, which records which bank every request named, so "team A's feed never reaches team B's bank" is checked against
// every request that was made, not against what one recall returned.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

const A = 'engineering';
const B = 'customer-support';
let BANK_A = '';
let BANK_B = '';

let world: World;
let fake: FakeHindsight;
let appPool: pg.Pool;
let systemPool: pg.Pool;
let runs: PluginRuns;
const teamIds: Record<string, string> = {};
const botIds: Record<string, string> = {};
const pairing: Record<string, string> = {};

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
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
const idle = () => until(async () => world.system(async (tx) => ((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_feed_pending')).rows[0]!.n === 0 ? true : null)), 'the work list to empty');

async function channelOf(team: string, kind: 'public' | 'private'): Promise<string> {
  if (kind === 'public') {
    return world.system(async (tx) =>
      (await tx.query<{ id: string }>("SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = $1 AND c.kind = 'channel' AND NOT c.private ORDER BY c.name LIMIT 1", [team])).rows[0]!.id,
    );
  }
  return world.system(async (tx) => {
    const channel = await tx.query<{ id: string }>(
      "INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'inner-circle', 'channel', true) RETURNING id",
      [omar.workspaceId, teamIds[team]],
    );
    return channel.rows[0]!.id;
  });
}

async function post(who: typeof omar, channelId: string, body: string): Promise<string> {
  const res = await world.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function makeBot(team: string, slug: string): Promise<void> {
  const teamId = teamIds[team]!;
  const bot = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId, slug],
    );
    const id = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [teamId, actor.rows[0]!.id, omar.workspaceId]);
    await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'memory.recall', false, '{}')", [teamId, actor.rows[0]!.id]);
    return id;
  });
  botIds[team] = bot;
  const minted = await world.call(omar, 'POST', `/api/teams/${team}/bots/${slug}/pairing-tokens`, {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  pairing[team] = (minted.body as { token: string }).token;
}

async function recallAs(team: string, query: string): Promise<string[]> {
  const opened = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: pairing[team] });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const run = McpRunMintResponse.parse(opened.body);
  const res = await fetch(`${world.server.url}${new URL(run.url).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory.recall', arguments: { query, limit: 50 } } }),
  });
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
  const answer = JSON.parse(body.result.content[0]!.text) as { ok: boolean; data?: { facts: Array<{ text: string }> } };
  expect(answer.ok).toBe(true);
  return (answer.data?.facts ?? []).map((f) => f.text);
}

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
  for (const slug of [A, B]) teamIds[slug] = await world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0]!.id);
  await makeBot(A, 'feed-a');
  await makeBot(B, 'feed-b');

  appPool = createAppPool(world.server.db.appUrl, 4);
  systemPool = createSystemPool(world.server.db.systemUrl, 4);
  const registry = new CapabilityRegistry();
  runs = createRunService({ pool: appPool, systemPool, registry, broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
}, 240_000);

afterAll(async () => {
  for (const name of ['MANYTHREADS_HINDSIGHT_URL', 'MANYTHREADS_MEMORY_DEBOUNCE_MS', 'MANYTHREADS_MEMORY_DEFER_MS', 'MANYTHREADS_MIRROR_DEBOUNCE_MS']) delete process.env[name];
  await appPool?.end();
  await systemPool?.end();
  await world?.close();
  await fake?.close();
});

describe('team A’s feed never lands in team B’s bank', () => {
  const SECRET_A = 'Falconwing launches on 9 March under codename Nightjar';
  const SECRET_B = 'Customer Halcyon churns unless the refund ships Tuesday';
  const PRIVATE_A = 'Layoffs at Falconwing are planned for June';
  const PAGE_A = 'Falconwing runbook: rotate the Kestrel keys monthly';
  let messageA = '';
  let channelA = '';

  it('each team’s public messages go to that team’s own bank, and every request names only its own team’s content', async () => {
    channelA = await channelOf(A, 'public');
    const channelB = await channelOf(B, 'public');
    messageA = await post(omar, channelA, SECRET_A);
    await post(sameera, channelB, SECRET_B);
    await until(async () => (inBank(BANK_A, 'Nightjar') && inBank(BANK_B, 'Halcyon') ? true : null), 'both teams’ messages');
    await idle();

    expect(inBank(BANK_A, 'Halcyon')).toBe(false);
    expect(inBank(BANK_B, 'Nightjar')).toBe(false);
    expect(sentTo(BANK_A)).not.toContain('Halcyon');
    expect(sentTo(BANK_B)).not.toContain('Nightjar');
    expect(fake.banksTouched().sort()).toEqual([BANK_A, BANK_B].sort());
  });

  it('a private channel of team A is in no bank, not even team A’s; nor is a person-scoped run of A', async () => {
    const priv = await channelOf(A, 'private');
    const secret = await world.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          "INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4) RETURNING id",
          [omar.workspaceId, priv, omar.actorId, PRIVATE_A],
        )
      ).rows[0]!.id,
    );
    // the event a real post would have written
    await world.system((tx) =>
      emit(tx, { type: 'channel.message.posted', schemaVersion: 1, workspaceId: omar.workspaceId, channelId: priv, teamId: teamIds[A], messageId: secret, authorId: omar.actorId, threadRootId: null }),
    );

    const { run } = await runs.open({ botId: botIds[A]!, teamId: teamIds[A]!, workspaceId: omar.workspaceId, trigger: 'mention', askerActorId: nadia.actorId });
    await world.system((tx) =>
      tx.query("INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 0, 'drive', 'finance/q3.xlsx', 'person')", [run.runId]),
    );
    await runs.close(run.runId, 'done');
    await until(async () => world.system(async (tx) => ((await tx.query("SELECT 1 FROM app.memory_retain_log WHERE run_id = $1 AND outcome = 'withheld'", [run.runId])).rows.length > 0 ? true : null)), 'the withheld line');

    // a public message behind both: when it is in the bank, the earlier events have been handled
    await post(omar, channelA, 'Control note for team A: standup at ten.');
    await until(async () => inBank(BANK_A, 'Control note'), 'the control note');
    await idle();
    const sent = JSON.stringify(fake.state.calls);
    expect(sent).not.toContain('Layoffs');
    expect(sent).not.toContain(run.runId);
    expect(sent).not.toContain('finance/q3.xlsx');
  });

  it('a page and a run summary of team A go to team A’s bank only', async () => {
    const written = await world.call(omar, 'POST', `/api/teams/${A}/pages/write`, { mode: 'create', path: 'pages/falconwing-runbook.md', content: `# Runbook\n\n${PAGE_A}\n` });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    const { run } = await runs.open({ botId: botIds[A]!, teamId: teamIds[A]!, workspaceId: omar.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: channelA });
    await runs.close(run.runId, 'done');
    await until(async () => (inBank(BANK_A, 'Kestrel keys') && inBank(BANK_A, 'The bot feed-a of team engineering') ? true : null), 'the page and the run summary');
    await idle();
    expect(inBank(BANK_B, 'Kestrel')).toBe(false);
    expect(inBank(BANK_B, 'feed-a')).toBe(false);
    expect(sentTo(BANK_B)).not.toMatch(/Kestrel|feed-a|Falconwing/);
  });

  it('an event that names the wrong team changes nothing: the team comes from the database, not from the event', async () => {
    const before = fake.state.calls.length;
    await world.system(async (tx) => {
      // team A's message, announced as team B's
      await emit(tx, { type: 'channel.message.edited', schemaVersion: 1, workspaceId: omar.workspaceId, channelId: channelA, teamId: teamIds[B], messageId: messageA, editorId: omar.actorId, threadRootId: null });
      // a run of team A, announced as closing for team B
      const { run } = await runs.open({ botId: botIds[A]!, teamId: teamIds[A]!, workspaceId: omar.workspaceId, trigger: 'routine' });
      await runs.close(run.runId, 'done');
      await emit(tx, { type: 'bots.run.closed', schemaVersion: 1, workspaceId: omar.workspaceId, teamId: teamIds[B], botId: botIds[A], runId: run.runId, trigger: 'routine', status: 'done' });
    });
    await post(omar, channelA, 'Control note after the forged events.');
    await until(async () => inBank(BANK_A, 'after the forged events'), 'the control note');
    await idle();
    const calls = fake.state.calls.slice(before);
    expect(calls.filter((c) => c.bank === BANK_B)).toEqual([]);
    expect(inBank(BANK_B, 'Nightjar')).toBe(false);
  });

  it('a bot of team B recalling the very words of team A’s feed gets none of them', async () => {
    const stolen = await recallAs(B, 'Falconwing launches Nightjar codename March runbook Kestrel keys standup');
    expect(stolen.join('\n')).not.toMatch(/Nightjar|Falconwing|Kestrel|standup/);
    const own = await recallAs(B, 'Halcyon refund churns Tuesday');
    expect(own.join('\n')).toContain('Halcyon');
    const mine = await recallAs(A, 'Falconwing launches Nightjar codename');
    expect(mine.join('\n')).toContain('Nightjar');
  });

  it('team A’s bank holds nothing of team B’s, and each run summary names only its own team', async () => {
    expect(textsOf(BANK_A).join('\n')).not.toMatch(/Halcyon/);
    for (const f of fake.state.banks.get(BANK_B) ?? []) {
      expect(f.metadata['team']).toBe(B);
    }
    for (const f of fake.state.banks.get(BANK_A) ?? []) {
      expect(f.metadata['team']).toBe(A);
    }
  });
});

describe('team A’s memory/ concepts (the git mirror) never land in team B’s bank', () => {
  const CONCEPT_A = 'Falconwing keeps the Merlin escrow keys in the Osprey vault';
  const CONCEPT_B = 'Halcyon renewals are handled by the Lanner desk on Thursdays';
  const path = 'memory/facts/escrow.md';
  const concept = (text: string): string => `---\ntype: Fact\ntitle: Escrow\n---\n\n${text}\n`;
  const mirrorIdle = () =>
    until(async () => world.system(async (tx) => ((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.memory_mirror_pending')).rows[0]!.n === 0 ? true : null)), 'the mirror work list to empty');

  it('a concept committed to team A’s repo is in team A’s bank, typed and tagged, and in no other bank', async () => {
    const res = await world.call(omar, 'POST', `/api/teams/${A}/repo/commit`, { changes: [{ op: 'put', path, content: concept(CONCEPT_A) }], message: 'Record the escrow facts' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => inBank(BANK_A, 'Osprey vault'), 'the concept in team A’s bank');
    await mirrorIdle();
    const fact = (fake.state.banks.get(BANK_A) ?? []).find((f) => f.text.includes('Osprey vault'))!;
    expect(fact.metadata).toMatchObject({ team: A, feed_kind: 'concept', concept_path: path, concept_type: 'Fact' });
    expect(fact.tags).toContain('type:fact');
    expect(inBank(BANK_B, 'Osprey')).toBe(false);
    expect(sentTo(BANK_B)).not.toMatch(/Osprey|Merlin|escrow/i);
  });

  it('an event that names the wrong team changes nothing: the path is read from the team the event names, so team B reads nothing', async () => {
    const before = fake.state.calls.length;
    await world.system((tx) =>
      emit(tx, {
        type: 'repo.repo.committed',
        schemaVersion: 1,
        workspaceId: omar.workspaceId,
        teamId: teamIds[B],
        sha: 'a'.repeat(40),
        parentSha: null,
        authorId: null,
        coAuthorIds: [],
        subject: 'forged',
        paths: [{ path, op: 'put' }],
      }),
    );
    // a concept of team B's own behind it: when it is in team B's bank, the forged event has been handled
    const own = await world.call(sameera, 'POST', `/api/teams/${B}/repo/commit`, { changes: [{ op: 'put', path: 'memory/facts/renewals.md', content: concept(CONCEPT_B) }], message: 'Record the renewals desk' });
    expect(own.status, JSON.stringify(own.body)).toBeLessThan(300);
    await until(async () => inBank(BANK_B, 'Lanner desk'), 'team B’s own concept');
    await mirrorIdle();
    const calls = fake.state.calls.slice(before);
    expect(calls.filter((c) => c.bank === BANK_B).every((c) => !JSON.stringify(c.body).includes('Osprey'))).toBe(true);
    expect(inBank(BANK_B, 'Osprey')).toBe(false);
    expect(inBank(BANK_A, 'Lanner')).toBe(false);
    expect(sentTo(BANK_A)).not.toMatch(/Lanner|Halcyon renewals/);
  });

  it('each team’s bundle root is written to its own repository', async () => {
    for (const team of [A, B]) {
      const root = await until(async () => {
        const res = await world.call(omar, 'GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent('memory/index.md')}&ref=main`);
        return res.status === 200 ? (res.body as { content: string }).content : null;
      }, `the bundle root of ${team}`);
      expect(root).toContain('okf_version');
    }
  });

  it('every concept in each bank names its own team', async () => {
    for (const [bank, team] of [[BANK_A, A], [BANK_B, B]] as const) {
      for (const f of fake.state.banks.get(bank) ?? []) {
        if (f.metadata['feed_kind'] === 'concept') expect(f.metadata['team']).toBe(team);
      }
    }
  });
});
