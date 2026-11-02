import { randomUUID } from 'node:crypto';
import { createAppPool, createSecretService, createSystemPool, withActor, withSystem, CapabilityBroker, CapabilityRegistry, RunEndedError, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { BotRunHandle, PluginTx, ToolSource } from '@manythreads/sdk';
import { McpRunMintResponse, ListConnectionsResponse } from '@manythreads/shared';
import { describeToolSourceIntersection, type CallOutcome } from '@manythreads/test-utils/tool-source-intersection';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { compileBot, putConnectionSecret, readConnectionSecret, deleteConnectionAndSecrets } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';

// P8-28: the connections slice end to end, on a real server. A BOT.md names a connection and its tools; the loader projects it, the connections plugin compiles it into
// grants on the event, the MCP gateway lists those tools for the bot and hands a call to the connections source after the broker allowed it. The kind is `email` over the
// dummy transport (P8-29): a call that gets through answers from an empty mailbox, and that is the success this file looks for. The mail journey itself (a delivered mail,
// the inbox run, the answer that goes to the sender) is in inbox.test.ts. Everything around the call is real.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const SECRET = 'imap-password-SENTINEL-5f1c9e';

let w: RepoWorld;
let sysPool: pg.Pool;
let secretDeps: Parameters<typeof putConnectionSecret>[0];
let connection: string;

const declared: Declared = new Map([
  ['email.read', { destructive: false }],
  ['email.draft', { destructive: false }],
  ['email.send', { destructive: false }],
]);

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const asPlugin = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => sys((tx) => fn(tx as unknown as PluginTx));

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** A bot on a team without the repo (rows only): actor and membership, like the loader leaves them. */
async function makeBot(team: string, slug: string, connections: unknown = []): Promise<{ botId: string; actorId: string }> {
  return sys(async (tx) => {
    const botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
         VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
        [omar.workspaceId, team, slug, JSON.stringify(connections)],
      )
    ).rows[0]!.id;
    const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, botId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actorId, omar.workspaceId]);
    return { botId, actorId };
  });
}

const compile = (team: string, botId: string) => asPlugin((tx) => compileBot(tx, declared, { workspaceId: omar.workspaceId, teamId: team, botId }));
const grantsOf = (actorId: string) =>
  sys(async (tx) => (await tx.query<{ tool: string; needs_approval: boolean; slug: string }>(`SELECT g.tool, g.needs_approval, c.slug FROM app.connection_grants g JOIN app.connections c ON c.id = g.connection_id WHERE g.actor_id = $1 ORDER BY g.tool`, [actorId])).rows);
const brokerGrantsOf = (actorId: string) =>
  sys(async (tx) => (await tx.query<{ capability: string; needs_approval: boolean; constraints: Record<string, unknown> }>(`SELECT capability, needs_approval, constraints FROM app.capability_grants WHERE actor_id = $1 AND constraints ? 'connection' ORDER BY capability`, [actorId])).rows);

/** One request to the MCP endpoint of a run. */
async function rpc(run: McpRunMintResponse, method: string, params?: unknown): Promise<{ result?: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }>; isError?: boolean } }> {
  const res = await fetch(`${w.server.url}/api/mcp/runs/${run.runId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as never;
}

const listed = async (run: McpRunMintResponse): Promise<string[]> => ((await rpc(run, 'tools/list')).result?.tools ?? []).map((t) => t.name);
const called = async (run: McpRunMintResponse, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const body = await rpc(run, 'tools/call', { name, arguments: args });
  return JSON.parse(body.result!.content![0]!.text) as Record<string, unknown>;
};

/** A conversation run of a bot asked by a person, opened in-process like the router does (the endpoint then is the real server's). */
async function openRun(botId: string, team: string, askerActorId: string | null): Promise<McpRunMintResponse> {
  const appPool = createAppPool(w.server.db.appUrl);
  const pool = createSystemPool(w.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
    const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({ botId, teamId: team, workspaceId: omar.workspaceId, trigger: askerActorId === null ? 'webhook' : 'conversation', ...(askerActorId === null ? {} : { askerActorId }) });
    return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${w.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
  } finally {
    await appPool.end();
    await pool.end();
  }
}

const setConnection = (set: string, values: unknown[] = []) => sys((tx) => tx.query(`UPDATE app.connections SET ${set} WHERE id = $1`, [connection, ...values]));

beforeAll(async () => {
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  secretDeps = {
    db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
    secrets: createSecretService(),
  };
  connection = await sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, 'support-mail', 'email', 'Support mailbox', 'team', $3) RETURNING id`,
          [omar.workspaceId, ENG, omar.actorId],
        )
      ).rows[0]!.id,
  );
  await putConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password', plaintext: SECRET });
  await setConnection(`status = 'enabled'`);
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  await w?.close();
});

describe('credentials', () => {
  it('are sealed by the platform’s secret service: the stored bytes hold no trace of the value, and only the system role can open them', async () => {
    const row = await sys(async (tx) => (await tx.query<{ ciphertext: Buffer; wrapped_key: Buffer; key_id: string }>(`SELECT s.ciphertext, s.wrapped_key, s.key_id FROM app.connection_secrets cs JOIN app.secrets s ON s.id = cs.secret_id WHERE cs.connection_id = $1`, [connection])).rows[0]!);
    expect(row.ciphertext.toString('utf8')).not.toContain(SECRET);
    expect(row.ciphertext.toString('latin1')).not.toContain('SENTINEL');
    expect(row.wrapped_key.length).toBeGreaterThan(0);
    expect(row.key_id).not.toBe('');
    expect(await readConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password' })).toBe(SECRET);
  });

  it('a connection that has one says so, and nothing else about it', async () => {
    const row = await sys(async (tx) => (await tx.query<{ has_credentials: boolean }>('SELECT has_credentials FROM app.connections WHERE id = $1', [connection])).rows[0]!);
    expect(row.has_credentials).toBe(true);
  });

  it('are stored for the connection’s own workspace only, and replacing one removes the old sealed row', async () => {
    await expect(putConnectionSecret(secretDeps, { workspaceId: randomUUID(), connectionId: connection, name: 'password', plaintext: 'x' })).rejects.toThrow(/does not exist in this workspace/);
    await expect(putConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password', plaintext: '' })).rejects.toThrow(/between 1 and/);
    const before = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    await putConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password', plaintext: SECRET });
    const after = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    expect(after).toBe(before);
    expect(await readConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password' })).toBe(SECRET);
    await expect(readConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'missing' })).rejects.toThrow(/no credential called/);
  });

  it('deleting a connection removes its sealed credentials with it', async () => {
    const doomed = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id) VALUES ($1, $2, 'doomed', 'email', 'Doomed', 'team', $3) RETURNING id`, [omar.workspaceId, ENG, omar.actorId])).rows[0]!.id);
    await putConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: doomed, name: 'password', plaintext: 'to-be-removed' });
    const secrets = (): Promise<number> => sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
    const before = await secrets();
    expect(await deleteConnectionAndSecrets(secretDeps, { workspaceId: omar.workspaceId, connectionId: doomed })).toBe(true);
    expect(await secrets()).toBe(before - 1);
    expect(await deleteConnectionAndSecrets(secretDeps, { workspaceId: omar.workspaceId, connectionId: doomed })).toBe(false);
  });
});

describe('the compile', () => {
  it('writes the grant, the broker’s row with the connection named in its constraints, and the approval flag', async () => {
    const bot = await makeBot(ENG, 'compile-a', [{ connection: 'support-mail', tools: ['email.read', 'email.send'], needsApproval: ['email.send'] }]);
    const result = await compile(ENG, bot.botId);
    expect(result.skipped).toEqual([]);
    expect(await grantsOf(bot.actorId)).toEqual([
      { tool: 'email.read', needs_approval: false, slug: 'support-mail' },
      { tool: 'email.send', needs_approval: true, slug: 'support-mail' },
    ]);
    expect(await brokerGrantsOf(bot.actorId)).toEqual([
      { capability: 'email.read', needs_approval: false, constraints: { connection: 'support-mail' } },
      { capability: 'email.send', needs_approval: true, constraints: { connection: 'support-mail' } },
    ]);
  });

  it('is idempotent, and a tool dropped from the definition loses both rows', async () => {
    const bot = await makeBot(ENG, 'compile-b', [{ connection: 'support-mail', tools: ['email.read', 'email.draft'] }]);
    await compile(ENG, bot.botId);
    await compile(ENG, bot.botId);
    expect((await grantsOf(bot.actorId)).map((g) => g.tool)).toEqual(['email.draft', 'email.read']);
    await sys((tx) => tx.query(`UPDATE app.bots SET connections = '[{"connection":"support-mail","tools":["email.read"]}]'::jsonb WHERE id = $1`, [bot.botId]));
    await compile(ENG, bot.botId);
    expect((await grantsOf(bot.actorId)).map((g) => g.tool)).toEqual(['email.read']);
    expect((await brokerGrantsOf(bot.actorId)).map((g) => g.capability)).toEqual(['email.read']);
    // a definition with no connections at all removes everything it had
    await sys((tx) => tx.query(`UPDATE app.bots SET connections = '[]'::jsonb WHERE id = $1`, [bot.botId]));
    await compile(ENG, bot.botId);
    expect(await grantsOf(bot.actorId)).toEqual([]);
    expect(await brokerGrantsOf(bot.actorId)).toEqual([]);
  });

  it('leaves the bot’s own native grants alone', async () => {
    const bot = await makeBot(ENG, 'compile-c', [{ connection: 'support-mail', tools: ['email.read'] }]);
    await sys((tx) => tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'messages.post')`, [ENG, bot.actorId]));
    await compile(ENG, bot.botId);
    await sys((tx) => tx.query(`UPDATE app.bots SET connections = '[]'::jsonb WHERE id = $1`, [bot.botId]));
    await compile(ENG, bot.botId);
    const left = await sys(async (tx) => (await tx.query<{ capability: string }>('SELECT capability FROM app.capability_grants WHERE actor_id = $1', [bot.actorId])).rows.map((r) => r.capability));
    expect(left).toEqual(['messages.post']);
  });

  it('grants nothing it should not: no such connection, another team’s connection, an undeclared or destructive tool, a wildcard, person connections', async () => {
    const bot = await makeBot(MKT, 'compile-d', [
      // Marketing's bot names Engineering's connection: there is no such connection on ITS team
      { connection: 'support-mail', tools: ['email.read'] },
      { connection: 'person:*', tools: ['email.read'] },
      { connection: 'ghost', tools: ['email.read'] },
    ]);
    const first = await compile(MKT, bot.botId);
    expect(first.granted).toEqual([]);
    expect(first.skipped.map((s) => `${s.connection}:${s.reason}`)).toEqual(['support-mail:no_such_connection', 'person:*:tool_not_personal', 'ghost:no_such_connection']);
    expect(await grantsOf(bot.actorId)).toEqual([]);
    expect(await brokerGrantsOf(bot.actorId)).toEqual([]);

    const eng = await makeBot(ENG, 'compile-e', [{ connection: 'support-mail', tools: ['email.delete', 'email.*', 'drive.read', 'email.read'] }]);
    const second = await compile(ENG, eng.botId);
    expect(second.skipped.map((s) => `${s.tool}:${s.reason}`)).toEqual(['email.delete:tool_not_declared', 'email.*:wildcard', 'drive.read:tool_not_declared']);
    expect((await grantsOf(eng.actorId)).map((g) => g.tool)).toEqual(['email.read']);
    // a destructive tool, if one were ever declared, is refused whatever the definition says
    const withDestructive: Declared = new Map([...declared, ['email.send', { destructive: true }]]);
    const third = await asPlugin((tx) => compileBot(tx, withDestructive, { workspaceId: omar.workspaceId, teamId: ENG, botId: eng.botId }));
    expect(third.granted).toEqual([{ tool: 'email.read', connection: 'support-mail', needsApproval: false }]);
    const destructiveBot = await makeBot(ENG, 'compile-f', [{ connection: 'support-mail', tools: ['email.send'] }]);
    const fourth = await asPlugin((tx) => compileBot(tx, withDestructive, { workspaceId: omar.workspaceId, teamId: ENG, botId: destructiveBot.botId }));
    expect(fourth.skipped).toEqual([{ connection: 'support-mail', tool: 'email.send', reason: 'tool_destructive' }]);
    expect(await grantsOf(destructiveBot.actorId)).toEqual([]);
  });

  it('a projection it cannot read grants nothing and removes what was there (fail closed)', async () => {
    const bot = await makeBot(ENG, 'compile-g', [{ connection: 'support-mail', tools: ['email.read'] }]);
    await compile(ENG, bot.botId);
    expect(await grantsOf(bot.actorId)).toHaveLength(1);
    // the column's own CHECK refuses a non-array, so what the compile itself must survive is an array of the wrong shape
    await sys((tx) => tx.query(`UPDATE app.bots SET connections = '[{"nope":1}]'::jsonb WHERE id = $1`, [bot.botId]));
    await compile(ENG, bot.botId);
    expect(await grantsOf(bot.actorId)).toEqual([]);
  });
});

describe('the wired path: BOT.md, loader, event, grants, MCP', () => {
  const PATH = 'bots/mailer/BOT.md';
  const botMd = (extra: { native?: string; connections: string; needsApproval?: string }): string => `---
schema: 1
name: Mailer
role: Answers mail in the connections tests
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [${extra.native ?? 'messages.post'}]
  connections:
${extra.connections}
${extra.needsApproval ? `approvals:\n  needsApproval: [${extra.needsApproval}]\n` : ''}---

# Mailer

Soul text.
`;
  const commit = (content: string, message: string) => w.commitRaw(omar, 'engineering', [{ op: 'put', path: PATH, content }], message);
  const botActor = async (): Promise<string | undefined> =>
    sys(async (tx) => (await tx.query<{ id: string }>(`SELECT a.id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.team_id = $1 AND b.slug = 'mailer'`, [ENG])).rows[0]?.id);
  let actorId: string;
  let botId: string;
  let run: McpRunMintResponse;

  it('a BOT.md that names a connection and its tools is compiled when the bot loads', async () => {
    const res = await commit(botMd({ connections: '    - name: support-mail\n      tools: [email.read, email.send]', needsApproval: 'email.send' }), 'Add the mailer');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    actorId = (await until(botActor, 15_000, 'the bot to load'))!;
    await until(async () => (await grantsOf(actorId)).length === 2, 15_000, 'the grants to be compiled');
    expect(await grantsOf(actorId)).toEqual([
      { tool: 'email.read', needs_approval: false, slug: 'support-mail' },
      { tool: 'email.send', needs_approval: true, slug: 'support-mail' },
    ]);
    botId = (await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE team_id = $1 AND slug = 'mailer'`, [ENG])).rows[0]!)).id;
    const projection = await sys(async (tx) => (await tx.query<{ connections: unknown }>('SELECT connections FROM app.bots WHERE id = $1', [botId])).rows[0]!.connections);
    expect(projection).toEqual([{ connection: 'support-mail', tools: ['email.read', 'email.send'], needsApproval: ['email.send'] }]);
  });

  it('the gateway lists exactly the granted tools, with the approval flag in the description', async () => {
    run = await openRun(botId, ENG, nadia.actorId);
    const body = await rpc(run, 'tools/list');
    const tools = body.result!.tools!;
    const names = tools.map((t) => t.name);
    expect(names).toContain('email.read');
    expect(names).toContain('email.send');
    expect(names).not.toContain('email.draft');
    expect(tools.find((t) => t.name === 'email.send')?.description).toContain('approval');
    expect(tools.find((t) => t.name === 'email.read')?.description).not.toContain('Needs a person’s approval');
  });

  it('a call that gets through runs the connection’s kind (an empty mailbox answers no messages); the credential is not in the answer', async () => {
    const answer = await called(run, 'email.read', { query: 'refund' });
    expect(answer).toMatchObject({ ok: true, messages: [] });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('arguments that do not fit the tool’s schema are refused before the kind sees them, naming the field and not the value', async () => {
    const answer = await called(run, 'email.read', { limit: 'lots', extra: 'SENTINEL-value' });
    expect(answer).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(JSON.stringify(answer)).toContain('limit');
    expect(JSON.stringify(answer)).not.toContain('SENTINEL-value');
  });

  it('a tool the bot has no grant for is refused by the broker, as for any other capability', async () => {
    expect(await called(run, 'email.draft', { to: 'a@b.c', subject: 's', body: 'b' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('a send that needs approval waits in the Approvals inbox and does not run', async () => {
    const answer = await called(run, 'email.send', { body: 'It is on its way.' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    const row = await sys(async (tx) => (await tx.query<{ tool: string; status: string; resume: { capability: string } }>('SELECT tool, status, resume FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]);
    expect(row).toMatchObject({ tool: 'email.send', status: 'pending', resume: { capability: 'email.send' } });
  });

  it('an approved send resumes through the source (the run service finds it for the approvals job), and never through a handler', async () => {
    const pending = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.approvals WHERE tool = 'email.send' AND status = 'pending' AND bot_id = $1`, [botId])).rows[0]!.id);
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${pending}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const read = async () => sys(async (tx) => (await tx.query<{ outcome: string; outcome_detail: string | null }>('SELECT outcome, outcome_detail FROM app.approvals WHERE id = $1', [pending])).rows[0]!);
    await until(async () => ['ran', 'failed'].includes((await read()).outcome), 30_000, 'the approved call to be made');
    const row = await read();
    // The run behind this send came from no mail, so the source refuses it (nothing to answer, nobody to send to) and the approvals job records a failed call with the
    // source's own sentence: the call reached the connections source, which is the point. A call the run service could not route would say "no plugin implements the
    // capability". A send that does have a mail behind it, approved the same way, is in inbox.test.ts.
    expect(row.outcome).toBe('failed');
    expect(row.outcome_detail).toContain('nobody to send to');
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('a connection that is switched off, past its end or without a credential offers nothing and refuses the call', async () => {
    const case_ = async (label: string, off: string, on: string): Promise<void> => {
      await setConnection(off);
      const r = await openRun(botId, ENG, nadia.actorId);
      expect(await listed(r), `${label}: listed`).not.toContain('email.read');
      const refused = await called(r, 'email.read');
      expect(refused, label).toMatchObject({ ok: false, code: 'forbidden' });
      await setConnection(on);
      expect(await listed(await openRun(botId, ENG, nadia.actorId)), `${label}: back`).toContain('email.read');
    };
    await case_('disabled', `status = 'disabled'`, `status = 'enabled'`);
    await case_('expired', `expires_at = now() - interval '1 minute'`, 'expires_at = NULL');
    // no credential: the flag follows the row, and the listing and the call both fail closed
    await sys((tx) => tx.query('DELETE FROM app.connection_secrets WHERE connection_id = $1', [connection]));
    const r = await openRun(botId, ENG, nadia.actorId);
    expect(await listed(r)).not.toContain('email.read');
    expect(await called(r, 'email.read')).toMatchObject({ ok: false, code: 'forbidden' });
    await putConnectionSecret(secretDeps, { workspaceId: omar.workspaceId, connectionId: connection, name: 'password', plaintext: SECRET });
    expect(await listed(await openRun(botId, ENG, nadia.actorId))).toContain('email.read');
  });

  it('editing the definition resyncs: a dropped tool loses its grant; a tool in both native and connections is refused by the loader, field named, and nothing changes', async () => {
    const dropped = await commit(botMd({ connections: '    - name: support-mail\n      tools: [email.read]' }), 'Drop the send');
    expect(dropped.status).toBe(201);
    await until(async () => (await grantsOf(actorId)).length === 1, 15_000, 'the grant to be dropped');
    expect((await brokerGrantsOf(actorId)).map((g) => g.capability)).toEqual(['email.read']);

    const both = await commit(botMd({ native: 'messages.post, email.read', connections: '    - name: support-mail\n      tools: [email.read]' }), 'Both lists');
    expect(both.status).toBe(201);
    const invalid = await until(
      async () =>
        (await sys(async (tx) => (await tx.query<{ payload: { fieldPath: string | null; message: string; slug: string } }>(`SELECT payload FROM app.events WHERE type = 'bots.bot.invalid' AND team_id = $1 ORDER BY id DESC LIMIT 5`, [ENG])).rows))
          .map((r) => r.payload)
          .find((p) => p.slug === 'mailer') ?? null,
      15_000,
      'the loader to refuse the definition',
    );
    expect(invalid.fieldPath).toBe('capabilities.connections[0].tools[0]');
    expect(invalid.message).toContain('email.read');
    // the previous definition stays live: the grant is still the one connection grant, and the native list did not gain the tool
    expect((await grantsOf(actorId)).map((g) => g.tool)).toEqual(['email.read']);
    const native = await sys(async (tx) => (await tx.query<{ capability: string }>(`SELECT capability FROM app.capability_grants WHERE actor_id = $1 AND NOT (constraints ? 'connection') ORDER BY capability`, [actorId])).rows.map((r) => r.capability));
    expect(native).not.toContain('email.read');
  });

  it('deleting the BOT.md removes the bot’s connection grants', async () => {
    const res = await w.commitRaw(omar, 'engineering', [{ op: 'delete', path: PATH }], 'Remove the mailer');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await until(async () => (await botActor()) === undefined, 15_000, 'the bot to go');
    expect(await grantsOf(actorId)).toEqual([]);
    expect(await brokerGrantsOf(actorId)).toEqual([]);
  });
});

describe('what a person can see of a connection', () => {
  it('the people of the team list it; the answer has no credential, and neither do the server’s logs or events', async () => {
    const res = await w.call<ListConnectionsResponse>(nadia, 'GET', '/api/teams/engineering/connections');
    expect(res.status).toBe(200);
    const parsed = ListConnectionsResponse.parse(res.body);
    const mail = parsed.connections.find((c) => c.slug === 'support-mail');
    expect(mail).toMatchObject({ kind: 'email', scope: 'team', status: 'enabled', environment: 'production', hasCredentials: true, expired: false, teamId: ENG });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(Object.keys(mail!).filter((k) => /secret|password|token|credential/i.test(k) && k !== 'hasCredentials')).toEqual([]);
    const logs = w.server.logs.join('\n');
    expect(logs).not.toContain(SECRET);
    const events = await sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [SECRET])).rows[0]!.n);
    expect(events).toBe(0);
  });

  it('someone who is not on the team, a guest and another team’s lead get nothing of it', async () => {
    for (const who of [sameera, lena, tariq]) {
      const res = await w.call<{ connections?: unknown[] }>(who, 'GET', '/api/teams/engineering/connections');
      expect(res.status === 200 ? res.body.connections : [], who.name).toEqual([]);
      expect(JSON.stringify(res.body), who.name).not.toContain('support-mail');
    }
    expect((await w.call(null, 'GET', '/api/teams/engineering/connections')).status).toBe(401);
  });
});

// The test every source of tools must pass: the bot's capabilities intersected with what the asker may see. Run for a read and for a write of the connections source.
describe('intersection', () => {
  let bot: { botId: string; actorId: string };
  const state = { botGranted: true, askerVisible: true };

  const subjectFor = (tool: 'email.read' | 'email.draft', kind: 'read' | 'write') => () => ({
    tool,
    kind,
    async arrange(next: { botGranted: boolean; askerVisible: boolean }): Promise<void> {
      state.botGranted = next.botGranted;
      state.askerVisible = next.askerVisible;
      await sys((tx) => tx.query(`UPDATE app.bots SET connections = $2::jsonb WHERE id = $1`, [bot.botId, JSON.stringify(next.botGranted ? [{ connection: 'support-mail', tools: [tool] }] : [])]));
      await compile(ENG, bot.botId);
    },
    async listed(): Promise<readonly string[]> {
      return listed(await runForAsker());
    },
    async call(): Promise<CallOutcome> {
      const r = await runForAsker();
      const answer = await called(r, tool, tool === 'email.read' ? {} : { to: ['a@b.c'], subject: 's', body: 'b' });
      const code = typeof answer['code'] === 'string' ? answer['code'] : undefined;
      return { refused: code === 'forbidden' || code === 'not_found' || code === 'unknown_tool', code, text: JSON.stringify(answer) };
    },
  });

  /** The asker (sameera, who is on no team) is seated on the team just long enough to open the run (a run needs a member to ask), then seated or not as the case says. */
  async function runForAsker(): Promise<McpRunMintResponse> {
    const seat = (on: boolean) =>
      sys((tx) =>
        on
          ? tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`, [ENG, sameera.actorId, omar.workspaceId])
          : tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [ENG, sameera.actorId]),
      );
    await seat(true);
    const r = await openRun(bot.botId, ENG, sameera.actorId);
    await seat(state.askerVisible);
    return r;
  }

  beforeAll(async () => {
    bot = await makeBot(ENG, 'intersect', []);
  });

  describeToolSourceIntersection('connections (a read: email.read)', subjectFor('email.read', 'read'));
  describeToolSourceIntersection('connections (a write: email.draft)', subjectFor('email.draft', 'write'));
});

// The run service is the one place a source's tool is routed: from the run's own row, in the transaction of that run's bot or asker, while the run is open.
describe('the run service and a source’s tool', () => {
  let appPool: pg.Pool;
  let pool: pg.Pool;
  let service: ReturnType<typeof createRunService>;
  let bot: { botId: string; actorId: string };
  let other: { botId: string; actorId: string };
  const seen: Array<{ run: BotRunHandle; tool: string; actor: string }> = [];
  const fake: ToolSource = {
    id: 'fake',
    tools: [{ name: 'fake.tool', description: 'd', inputSchema: {}, kind: 'read' }],
    offered: () => Promise.resolve(['fake.tool']),
    call: (tx, run, tool) => {
      seen.push({ run, tool, actor: tx.actor.id });
      return Promise.resolve({ ok: true });
    },
  };

  beforeAll(async () => {
    appPool = createAppPool(w.server.db.appUrl);
    pool = createSystemPool(w.server.db.systemUrl, 2);
    const registry = new CapabilityRegistry();
    registry.register({ name: 'fake.tool', destructive: false, plugin: 'fake' });
    registry.register({ name: 'fake.unlisted', destructive: false, plugin: 'fake' });
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
    service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map(), toolSources: { values: () => [fake] } });
    bot = await makeBot(ENG, 'routed', []);
    other = await makeBot(ENG, 'routed-other', []);
  });
  afterAll(async () => {
    await appPool?.end();
    await pool?.end();
  });

  const open = (b: { botId: string }, asker: string | null = nadia.actorId) =>
    service.open({ botId: b.botId, teamId: ENG, workspaceId: omar.workspaceId, trigger: asker === null ? 'webhook' : 'conversation', ...(asker === null ? {} : { askerActorId: asker }) });

  it('lists a source’s tool in the catalog, and nothing else of that namespace', () => {
    expect(service.catalog().map((t) => t.name)).toEqual(['fake.tool']);
  });

  it('routes a write as the run’s bot and a read as the person who asked, with the run read from its own row', async () => {
    const { run } = await open(bot);
    seen.length = 0;
    await service.asBot(run, (tx) => service.invoke(tx, 'fake.tool', {}));
    await service.asReader(run, (tx) => service.invoke(tx, 'fake.tool', {}));
    expect(seen.map((s) => s.actor)).toEqual([bot.actorId, nadia.actorId]);
    for (const s of seen) expect(s.run).toMatchObject({ runId: run.runId, botId: bot.botId, botActorId: bot.actorId, teamId: ENG, workspaceId: omar.workspaceId, askerActorId: nadia.actorId });
  });

  it('refuses outside a run, for a transaction that is not the run’s bot or asker, and once the run has ended', async () => {
    const a = await open(bot);
    const as = (actor: { kind: 'bot' | 'person'; id: string; runId?: string }) =>
      withActor({ kind: actor.kind, id: actor.id as never, workspaceId: omar.workspaceId as never, ...(actor.runId ? { runId: actor.runId as never } : {}) }, (tx) => service.invoke(tx as never, 'fake.tool', {}), { pool: appPool });
    // no run in the transaction
    await expect(as({ kind: 'bot', id: bot.actorId })).rejects.toThrow(/only be called inside a run/);
    // run A's id on a transaction of another bot, or of a person who did not ask it
    await expect(as({ kind: 'bot', id: other.actorId, runId: a.run.runId })).rejects.toThrow(/does not act for that run/);
    await expect(as({ kind: 'person', id: sameera.actorId, runId: a.run.runId })).rejects.toThrow(/does not act for that run/);
    // an unknown run
    await expect(as({ kind: 'bot', id: bot.actorId, runId: randomUUID() })).rejects.toBeInstanceOf(RunEndedError);
    // the right actor and run works, then the run ends and it stops
    await expect(as({ kind: 'bot', id: bot.actorId, runId: a.run.runId })).resolves.toEqual({ ok: true });
    expect(await service.close(a.run.runId, 'done')).toBe(true);
    await expect(as({ kind: 'bot', id: bot.actorId, runId: a.run.runId })).rejects.toBeInstanceOf(RunEndedError);
  });

  it('a capability nobody implements is still an error', async () => {
    const { run } = await open(bot);
    await expect(service.asBot(run, (tx) => service.invoke(tx, 'fake.unlisted', {}))).rejects.toThrow(/no plugin implements/);
  });
});
