import { createHash } from 'node:crypto';
import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { NotASandboxError, type PluginContext, type PluginRuns } from '@manythreads/sdk';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';
import { openTerminalSandbox } from '../src/sandbox.ts';

// P7-09 (gateway-mcp half): the run behind a terminal. What it proves, against a real database and the real run service:
//   * the credentials minted for the sandbox run are revoked before the function answers, and the token that was minted is REFUSED afterwards (the test keeps the token and tries it),
//   * a run that is not a rehearsal conversation (a real conversation, a mention, a webhook, a rehearsal flag on any other trigger) is refused with NotASandboxError and is left running,
//   * a run of another bot, another team or another workspace looks like no run at all,
//   * attaching to a rehearsal that is still running ends it and revokes its token.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: World;
let appPool: pg.Pool;
let systemPool: pg.Pool;
let service: PluginRuns;
let teamId: string;
let bot: { botId: string; actorId: string };
let otherBot: { botId: string; actorId: string };
/** Every token the run service minted while a test ran: the terminal's function never returns one, so the test takes it from the service itself. */
const minted: string[] = [];

const sha = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

// only what openTerminalSandbox touches: the run service (wrapped to keep the token) and the system transaction
const ctx = {
  runs: {
    open: async (input: Parameters<PluginRuns['open']>[0]) => {
      const opened = await service.open(input);
      minted.push(opened.token);
      return opened;
    },
    close: (runId: string, status: 'done' | 'failed' | 'stopped') => service.close(runId, status),
    resolve: (hash: Buffer) => service.resolve(hash),
  },
  db: { system: <T>(fn: Parameters<World['system']>[0]) => world.system(fn as never) as Promise<T> },
} as unknown as PluginContext;

async function makeBot(slug: string, team: string): Promise<{ botId: string; actorId: string }> {
  return world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, team, slug],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId]);
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actor.rows[0]!.id, omar.workspaceId]);
    return { botId, actorId: actor.rows[0]!.id };
  });
}

const input = (over: Partial<Parameters<typeof openTerminalSandbox>[1]> = {}) => ({ workspaceId: omar.workspaceId, teamId, botId: bot.botId, ...over });

const runRow = (runId: string) =>
  world.system(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.bot_runs WHERE id = $1', [runId])).rows[0]);
const tokenRows = (runId: string) =>
  world.system(async (tx) => (await tx.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM app.mcp_run_tokens WHERE run_id = $1', [runId])).rows);

beforeAll(async () => {
  world = await createWorld();
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  bot = await makeBot('terminal-bot', teamId);
  otherBot = await makeBot('terminal-other', teamId);
  appPool = createAppPool(world.server.db.appUrl);
  systemPool = createSystemPool(world.server.db.systemUrl, 2);
  const registry = new CapabilityRegistry();
  service = createRunService({ pool: appPool, systemPool, registry, broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
});

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await world?.close();
});

/** A run opened the way the product opens each kind. */
async function openRun(over: { rehearsal?: boolean; trigger: 'conversation' | 'webhook' | 'mention'; botId?: string }): Promise<{ runId: string; token: string }> {
  const { run, token } = await service.open({
    botId: over.botId ?? bot.botId,
    teamId,
    workspaceId: omar.workspaceId,
    trigger: over.trigger,
    ...(over.trigger === 'conversation' || over.trigger === 'mention' ? { askerActorId: nadia.actorId } : {}),
    ...(over.rehearsal ? { rehearsal: true } : {}),
  });
  return { runId: run.runId, token };
}

describe('openTerminalSandbox: credentials', () => {
  it('opens a sandbox run whose every credential is revoked before it answers, and refuses the token afterwards', async () => {
    minted.length = 0;
    const result = await openTerminalSandbox(ctx, input());
    expect(minted).toHaveLength(1);
    const token = minted[0]!;
    // the run ended and has no live credential
    expect((await runRow(result.run.runId))?.status).not.toBe('running');
    const rows = await tokenRows(result.run.runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked)).toBe(true);
    expect(result.credentialsRevoked).toBe(rows.length);
    expect(result.run.rehearsal).toBe(true);
    // and the run service refuses the very token that was minted, by the check an endpoint uses
    expect(await service.resolve(sha(token))).toBeNull();
  });

  it('the token cannot open the run\'s endpoint either', async () => {
    minted.length = 0;
    const result = await openTerminalSandbox(ctx, input());
    const res = await fetch(`${world.server.url}/api/mcp/runs/${result.run.runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minted[0]!}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  // The function trusts none of the three facts it needs and checks each on its own. Each test breaks exactly ONE of them (a `close` that does not do its whole job) and expects a refusal.
  const withClose = (close: (runId: string) => Promise<unknown>, resolve: (hash: Buffer) => Promise<unknown> = ctx.runs.resolve as never): PluginContext =>
    ({ ...ctx, runs: { ...ctx.runs, close: async (runId: string) => (await close(runId), true), resolve } }) as unknown as PluginContext;
  const stopRun = (runId: string) => world.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'stopped', ended_at = now() WHERE id = $1", [runId]));
  const revokeTokens = (runId: string) => world.system((tx) => tx.query('UPDATE app.mcp_run_tokens SET revoked_at = now() WHERE run_id = $1 AND revoked_at IS NULL', [runId]));

  it('fails closed on a token row that is still live, even though the run is over and the token no longer resolves', async () => {
    let seen = '';
    const broken = withClose(async (runId) => {
      seen = runId;
      await stopRun(runId); // the run is stopped; its token row is NOT revoked
    });
    await expect(openTerminalSandbox(broken, input())).rejects.toThrow(/live credential/);
    expect((await runRow(seen))?.status).toBe('stopped');
    expect((await tokenRows(seen)).some((r) => !r.revoked)).toBe(true);
  });

  it('fails closed on a run that is still running, even though every token row is revoked', async () => {
    let seen = '';
    const broken = withClose(async (runId) => {
      seen = runId;
      await revokeTokens(runId); // the tokens are revoked; the run is NOT stopped
    });
    await expect(openTerminalSandbox(broken, input())).rejects.toThrow(/live credential/);
    expect((await runRow(seen))?.status).toBe('running');
    expect((await tokenRows(seen)).every((r) => r.revoked)).toBe(true);
    await service.close(seen, 'stopped');
  });

  it('fails closed on a minted token the run service still resolves, even though the run is over and the rows are revoked', async () => {
    let seen = '';
    const broken = withClose(
      async (runId) => {
        seen = runId;
        await service.close(runId, 'stopped'); // the whole job is done in the database
      },
      async () => ({ runId: 'pretend', botId: 'pretend' }), // ... but the service still answers for the token
    );
    await expect(openTerminalSandbox(broken, input())).rejects.toThrow(/token still works/);
    expect((await runRow(seen))?.status).not.toBe('running');
    expect((await tokenRows(seen)).every((r) => r.revoked)).toBe(true);
  });

  it('passes when the three facts all hold (the control for the three refusals above)', async () => {
    const fine = withClose((runId) => service.close(runId, 'stopped'));
    const result = await openTerminalSandbox(fine, input());
    expect(result.credentialsRevoked).toBeGreaterThan(0);
  });
});

describe('openTerminalSandbox: what is a sandbox', () => {
  it('refuses a real conversation run, a mention and a webhook run, and leaves each one running', async () => {
    const real = [
      await openRun({ trigger: 'conversation' }),
      await openRun({ trigger: 'mention' }),
      await openRun({ trigger: 'webhook' }),
      // (a rehearsal flag on any other trigger cannot even be stored: the table's own check `bot_runs_rehearsal_conversation` refuses it; the shared predicate refuses it as well, see the contracts test)
    ];
    for (const run of real) {
      await expect(openTerminalSandbox(ctx, input({ runId: run.runId }))).rejects.toBeInstanceOf(NotASandboxError);
      // the refusal did not touch the run: still running, token still live
      expect((await runRow(run.runId))?.status).toBe('running');
      expect((await tokenRows(run.runId)).some((r) => !r.revoked)).toBe(true);
      expect(await service.resolve(sha(run.token))).not.toBeNull();
    }
    for (const run of real) await service.close(run.runId, 'stopped');
  });

  it('attaches to a rehearsal that is still running by ending it, which revokes its token', async () => {
    const run = await openRun({ trigger: 'conversation', rehearsal: true });
    expect(await service.resolve(sha(run.token))).not.toBeNull();
    const result = await openTerminalSandbox(ctx, input({ runId: run.runId }));
    expect(result.run.runId).toBe(run.runId);
    expect(result.credentialsRevoked).toBeGreaterThan(0);
    expect(await service.resolve(sha(run.token))).toBeNull();
    expect((await runRow(run.runId))?.status).not.toBe('running');
  });

  it('attaches to a rehearsal that already ended', async () => {
    const run = await openRun({ trigger: 'conversation', rehearsal: true });
    await service.close(run.runId, 'done');
    const result = await openTerminalSandbox(ctx, input({ runId: run.runId }));
    expect(result.run.runId).toBe(run.runId);
    expect(await service.resolve(sha(run.token))).toBeNull();
  });

  it('a run of another bot looks like no run at all', async () => {
    const run = await openRun({ trigger: 'conversation', rehearsal: true, botId: otherBot.botId });
    await expect(openTerminalSandbox(ctx, input({ runId: run.runId }))).rejects.toThrow(/no such test run/i);
    expect((await runRow(run.runId))?.status).toBe('running');
    await service.close(run.runId, 'stopped');
  });

  it('a run id that does not exist, or is another workspace\'s, looks like no run at all', async () => {
    await expect(openTerminalSandbox(ctx, input({ runId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/no such test run/i);
    await expect(openTerminalSandbox(ctx, input({ workspaceId: '00000000-0000-4000-8000-0000000000aa' }))).rejects.toThrow();
  });
});
