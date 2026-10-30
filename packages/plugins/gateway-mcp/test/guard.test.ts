import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// P10-04: the data-loss check at the MCP gateway, against the real server. A bot that carries a key (or a word the workspace marked as private) in a tool
// call, or reads one back, is held to what the workspace's policy says: redact, wait for a person, or refuse. The key text is built here from two halves
// so the file itself holds no key-shaped string; what matters is that it never reaches a stored card, an approval, an event or an answer.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

const KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;
let world: World;
let teamId: string;
let devChannelId: string;
let runToken: string;
let runUrlPath: string;

type ToolAnswer = { isError: boolean | undefined; answer: Record<string, unknown>; raw: string };

async function call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const res = await fetch(`${world.server.url}${runUrlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const raw = body.result.content[0]!.text;
  return { isError: body.result.isError, answer: JSON.parse(raw) as Record<string, unknown>, raw };
}

const setDetector = async (name: string, action: string): Promise<void> => {
  const res = await world.call(omar, 'PUT', `/api/admin/guardrails/dlp/detectors/${name}`, { action });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const addRule = async (name: string, pattern: string, action: string): Promise<string> => {
  const res = await world.call(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name, pattern, action });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { rule: { id: string } }).rule.id;
};
const taskCount = (): Promise<number> => world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.tasks WHERE team_id = $1', [teamId])).rows[0]!.n);
const mcpDecisions = (): Promise<Array<{ payload: Record<string, unknown> }>> =>
  world.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'guardrails.dlp.decided' AND payload->>'destination' LIKE 'mcp%' ORDER BY id")).rows);

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  devChannelId = await world.channelId('engineering', 'dev');
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  await world.system(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'guarded', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, b.rows[0]!.id]);
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, a.rows[0]!.id, omar.workspaceId]);
    for (const [capability, needsApproval] of [['messages.search', false], ['tasks.create', false], ['pages.write', true]] as const) {
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, $4, '{}')`, [teamId, a.rows[0]!.id, capability, needsApproval]);
    }
  });
  const minted = await world.call(omar, 'POST', '/api/teams/engineering/bots/guarded/pairing-tokens', {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const run = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: (minted.body as { token: string }).token });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const opened = run.body as { runId: string; token: string };
  runToken = opened.token;
  runUrlPath = `/api/mcp/runs/${opened.runId}`;
  const posted = await world.call(nadia, 'POST', `/api/channels/${devChannelId}/messages`, { channelId: devChannelId, body: `The zebraquartz deploy token is ${KEY} for now.`, threadRootId: null });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
});

afterAll(async () => {
  await world?.close();
});

describe('data-loss check at the MCP gateway (P10-04)', () => {
  it('redacts a key in a write by default: the card is made with a marker, and nothing stored or emitted holds the key', async () => {
    const res = await call('tasks.create', { title: `Rotate ${KEY} soon`, branch: 'fix/rotate', kind: 'code', priority: 'high' });
    expect(res.isError, res.raw).toBeFalsy();
    expect(res.raw).not.toContain(KEY);
    expect((res.answer['task'] as { title: string }).title).toBe('Rotate [redacted:api-key] soon');
    const decisions = await mcpDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ destination: 'mcp', outcome: 'redact', rules: ['api-key'] });
    // no card, card history or guardrail/task event copies the key (the message the test posted is the one place it lives)
    const copies = await world.system(async (tx) =>
      (
        await tx.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM app.tasks t WHERE t::text LIKE $1)
                + (SELECT count(*) FROM app.task_events t WHERE t::text LIKE $1)
                + (SELECT count(*) FROM app.events e WHERE (e.type LIKE 'guardrails.%' OR e.type LIKE 'tasks.%') AND e.payload::text LIKE $1) AS n`,
          [`%${KEY}%`],
        )
      ).rows[0]!.n,
    );
    expect(Number(copies)).toBe(0);
    const inDecisions = JSON.stringify(decisions);
    expect(inDecisions).not.toContain(KEY);
  });

  it('refuses a write when the workspace says block, and nothing is created', async () => {
    await setDetector('api-key', 'block');
    const before = await taskCount();
    const res = await call('tasks.create', { title: `Rotate ${KEY}`, branch: 'fix/rotate2' });
    expect(res.isError).toBe(true);
    expect(res.answer).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(res.raw).not.toContain(KEY);
    expect(await taskCount()).toBe(before);
    const last = (await mcpDecisions()).at(-1)!;
    expect(last.payload).toMatchObject({ outcome: 'block', rules: ['api-key'] });
    expect(JSON.stringify(last.payload)).not.toContain(KEY);
  });

  it('a clean call still goes through while a block is set', async () => {
    const res = await call('tasks.create', { title: 'Plain title', branch: 'fix/plain' });
    expect(res.isError, res.raw).toBeFalsy();
  });

  it('withholds a read result that carries a key when the workspace says block, and redacts it by default', async () => {
    const blocked = await call('messages.search', { query: 'zebraquartz deploy token' });
    expect(blocked.answer).toMatchObject({ ok: false, code: 'withheld_by_guardrail' });
    expect(blocked.raw).not.toContain(KEY);
    await setDetector('api-key', 'preset');
    const redacted = await call('messages.search', { query: 'zebraquartz deploy token' });
    expect(redacted.raw).not.toContain(KEY);
    expect(redacted.raw).toContain('[redacted:api-key]');
    const last = (await mcpDecisions()).at(-1)!;
    expect(last.payload).toMatchObject({ destination: 'mcp_result', outcome: 'redact' });
  });

  it('a custom rule the admin wrote applies, and stops applying when it is removed', async () => {
    const id = await addRule('codename', 'PROJECT-ZEBRA[0-9]+', 'block');
    const blocked = await call('tasks.create', { title: 'Plan PROJECT-ZEBRA42 launch', branch: 'fix/zebra' });
    expect(blocked.answer).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(blocked.raw).toContain('codename');
    const removed = await world.call(omar, 'DELETE', `/api/admin/guardrails/dlp/rules/${id}`);
    expect(removed.status).toBe(200);
    const allowed = await call('tasks.create', { title: 'Plan PROJECT-ZEBRA42 launch', branch: 'fix/zebra2' });
    expect(allowed.isError, allowed.raw).toBeFalsy();
  });

  it('a write that waits for a person keeps the redacted copy in the approval, never the key', async () => {
    const res = await call('pages.write', { mode: 'create', path: 'pages/guard-test.md', content: `Deploy with ${KEY}` });
    expect(res.answer).toMatchObject({ ok: false, code: 'approval_pending' });
    const approvalId = res.answer['approvalId'] as string;
    const row = await world.system(async (tx) => (await tx.query<{ resume: unknown; preview: unknown }>('SELECT resume, to_jsonb(a) - \'resume\' AS preview FROM app.approvals a WHERE id = $1', [approvalId])).rows[0]!);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row.resume)).toContain('[redacted:api-key]');
  });
  describe('what hides inside the shape of a call', () => {
    const SPLIT = `AKIA\u200BIOSFOD\u200DNN7EXA\uFEFFMPLE`;

    it('finds a key split with zero-width characters, deep inside arrays and objects', async () => {
      await setDetector('api-key', 'block');
      try {
        const res = await call('tasks.create', { title: 'ok', branch: 'fix/deep', notes: [['a', { deep: [{ more: [`before ${SPLIT} after`] }] }]] });
        expect(res.answer).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
        expect(res.raw).not.toContain('AKIA');
      } finally {
        await setDetector('api-key', 'preset');
      }
    });

    it('reads the names of fields too: a key used as a field name refuses the call and is not echoed', async () => {
      const before = await taskCount();
      const res = await call('tasks.create', { title: 'ok', branch: 'fix/keyname', [KEY]: 'x' });
      expect(res.answer).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
      expect(res.raw).not.toContain(KEY);
      expect(await taskCount()).toBe(before);
      const last = (await mcpDecisions()).at(-1)!;
      expect(last.payload).toMatchObject({ destination: 'mcp', outcome: 'block', rules: ['api-key'] });
      expect(JSON.stringify(last.payload)).not.toContain(KEY);
    });

    it('refuses, unread, a call too big to read, and says why in plain words', async () => {
      const res = await call('tasks.create', { title: 'ok', branch: 'fix/big', notes: Array.from({ length: 20_001 }, (_, i) => `n${i}`) });
      expect(res.answer).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
      expect(String(res.answer['message'])).toContain('could not read');
    });

    it('does not mistake a call with a few thousand small values for one too big to read', async () => {
      const res = await call('tasks.create', { title: 'ok', branch: 'fix/many', notes: Array.from({ length: 3000 }, (_, i) => `n${i}`) });
      expect(res.answer['code']).not.toBe('blocked_by_guardrail');
    });
  });
});
