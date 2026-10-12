import { createHash, randomBytes } from 'node:crypto';
import type { CapabilityDecision, CapabilityHandler, PluginRuns, PluginTx, ToolDescriptor } from '@manythreads/sdk';
import { guardPluginTx } from '@manythreads/sdk';
import type { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import type { AuthorizeContext, CapabilityBroker } from '../capabilities/broker.ts';
import type { CapabilityRegistry } from '../capabilities/registry.ts';
import { withActor, withSystem } from '../db/with-actor.ts';
import type { Actor } from '../db/with-actor.ts';
import type { BotRunHandle, OpenRunInput } from '@manythreads/sdk';

// The MCP gateway's door (PLAN P5-09, decision in docs/spikes/per-run-scoping.md): one run, one endpoint URL and
// one credential — so a tool call can always be resolved back to the run, the bot and the person who asked.
//
// Who runs where:
//   * `open`, `resolve` and `close` are the system actor: `mcp_run_tokens` is a credential table (RLS: system,
//     no grant to manythreads_app) and the run row must be writable before any actor exists.
//   * `asBot` is one transaction as the run's bot with `app.run_id` set — the RLS policies and the
//     `run_source_log` insert (`run_id = app.run_id()`) both key on it.
//   * `asReader` is the same transaction as the *asking person* when the run has one, because a read must see
//     what the asker sees, never more; the capability check still goes through the bot's allowlist.
//
// Nothing here trusts the caller's word: the bot, its actor row and the team are read from the database, and the
// asker must be a person actor of the same workspace who is on the run's team.

/** The default lifetime of a run's endpoint, when the caller does not say (matches `MCP_RUN_TTL_SECONDS`). */
export const DEFAULT_RUN_TTL_SECONDS = 900;
export const MAX_RUN_TTL_SECONDS = 3600;

export interface RunServiceOptions {
  /** manythreads_app pool: the transactions tool calls run in. */
  pool: pg.Pool;
  /** manythreads_system pool: opening, resolving and ending a run. */
  systemPool: pg.Pool;
  registry: CapabilityRegistry;
  broker: CapabilityBroker;
  /** Capability implementations by name (`ctx.capabilities.register`), read at call time. */
  handlers: ReadonlyMap<string, { plugin: string; handler: CapabilityHandler }>;
}

interface RunRow {
  run_id: string;
  bot_id: string;
  bot_actor_id: string;
  team_id: string;
  workspace_id: string;
  trigger_type: string;
  asker_id: string | null;
  expires_at: Date;
  [key: string]: unknown;
}

const sha256 = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** 256 random bits, base64url: shown once to the runtime, stored as its sha256 and nothing else. */
export const newRunToken = (): string => randomBytes(32).toString('base64url');

/** The sha256 a run token is compared by; exported for the gateway's own tests and docs. */
export const hashRunToken = sha256;

const botActor = (run: BotRunHandle): Actor => ({
  kind: 'bot',
  id: run.botActorId as ActorId,
  workspaceId: run.workspaceId as WorkspaceId,
  runId: run.runId as RunId,
  trigger: run.trigger,
});

export function createRunService(options: RunServiceOptions): PluginRuns {
  const { pool, systemPool, registry, broker, handlers } = options;
  const system = { pool: systemPool };

  return {
    async open(input: OpenRunInput): Promise<{ run: BotRunHandle; token: string }> {
      const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_RUN_TTL_SECONDS, 30), MAX_RUN_TTL_SECONDS);
      const token = newRunToken();
      const run = await withSystem(async (tx) => {
        const bot = (
          await tx.query<{ id: string; actor_id: string }>(
            `SELECT b.id, a.id AS actor_id FROM app.bots b
               JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id
              WHERE b.id = $1 AND b.team_id = $2 AND b.workspace_id = $3`,
            [input.botId, input.teamId, input.workspaceId],
          )
        ).rows[0];
        if (!bot) throw new Error('the run has no bot on that team in that workspace');
        if (input.askerActorId !== undefined && input.askerActorId !== null) {
          const asker = (
            await tx.query<{ id: string }>(
              `SELECT a.id FROM app.actors a
                 JOIN app.team_members m ON m.actor_id = a.id AND m.team_id = $3
                WHERE a.id = $1 AND a.kind = 'person' AND a.workspace_id = $2`,
              [input.askerActorId, input.workspaceId, input.teamId],
            )
          ).rows[0];
          if (!asker) throw new Error('the asker is not a person of that team in that workspace');
        }
        const inserted = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, thread_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
            [input.workspaceId, input.botId, input.teamId, input.trigger, input.askerActorId ?? null, input.threadId ?? null],
          )
        ).rows[0];
        if (!inserted) throw new Error('the run insert answered no row');
        const minted = (
          await tx.query<{ expires_at: Date }>(
            `INSERT INTO app.mcp_run_tokens (run_id, bot_id, token_hash, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING expires_at`,
            [inserted.id, input.botId, sha256(token), ttl],
          )
        ).rows[0];
        if (!minted) throw new Error('the run token insert answered no row');
        const handle: BotRunHandle = {
          runId: inserted.id,
          botId: bot.id,
          botActorId: bot.actor_id,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          trigger: input.trigger,
          askerActorId: input.askerActorId ?? null,
          expiresAt: minted.expires_at.toISOString(),
        };
        return handle;
      }, system);
      return { run, token };
    },

    async resolve(tokenHash: Buffer): Promise<BotRunHandle | null> {
      return withSystem(async (tx) => {
        const row = (
          await tx.query<RunRow>(
            `SELECT t.run_id, t.bot_id, t.expires_at, r.team_id, r.workspace_id, r.trigger_type, r.asker_id,
                    a.id AS bot_actor_id
               FROM app.mcp_run_tokens t
               JOIN app.bot_runs r ON r.id = t.run_id
               JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = t.bot_id
              WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND r.status = 'running'`,
            [tokenHash],
          )
        ).rows[0];
        if (!row) return null;
        return {
          runId: row.run_id,
          botId: row.bot_id,
          botActorId: row.bot_actor_id,
          teamId: row.team_id,
          workspaceId: row.workspace_id,
          trigger: row.trigger_type,
          askerActorId: row.asker_id,
          expiresAt: row.expires_at.toISOString(),
        } satisfies BotRunHandle;
      }, system);
    },

    async close(runId: string, status: 'done' | 'failed' | 'stopped'): Promise<boolean> {
      return withSystem(async (tx) => {
        const ended = await tx.query(`UPDATE app.bot_runs SET status = $2, ended_at = now() WHERE id = $1 AND status = 'running'`, [
          runId,
          status,
        ]);
        await tx.query(`UPDATE app.mcp_run_tokens SET revoked_at = now() WHERE run_id = $1 AND revoked_at IS NULL`, [runId]);
        return (ended.rowCount ?? 0) > 0;
      }, system);
    },

    asBot<T>(run: BotRunHandle, fn: (tx: PluginTx) => Promise<T>): Promise<T> {
      return withActor(botActor(run), (tx) => fn(guardPluginTx(tx as unknown as PluginTx)), { pool });
    },

    asReader<T>(run: BotRunHandle, fn: (tx: PluginTx) => Promise<T>): Promise<T> {
      if (run.askerActorId === null) return this.asBot(run, fn);
      const actor: Actor = {
        kind: 'person',
        id: run.askerActorId as ActorId,
        workspaceId: run.workspaceId as WorkspaceId,
        runId: run.runId as RunId,
        trigger: run.trigger,
      };
      return withActor(actor, (tx) => fn(guardPluginTx(tx as unknown as PluginTx)), { pool });
    },

    authorize(run: BotRunHandle, capability: string, context: AuthorizeContext = {}): Promise<CapabilityDecision> {
      return broker.authorize(botActor(run), capability, { ...context, trigger: context.trigger ?? run.trigger });
    },

    may(run: BotRunHandle, capability: string, context: AuthorizeContext = {}): Promise<CapabilityDecision> {
      return broker.check(botActor(run), capability, { ...context, trigger: context.trigger ?? run.trigger });
    },

    catalog(): readonly ToolDescriptor[] {
      return registry
        .list()
        .filter((c) => handlers.has(c.name))
        .map((c) => ({ name: c.name, destructive: c.destructive }));
    },

    async invoke(tx: PluginTx, capability: string, input: Record<string, unknown>): Promise<unknown> {
      const registered = handlers.get(capability);
      if (!registered) throw new Error(`no plugin implements the capability "${capability}"`);
      return registered.handler(input, tx);
    },

    async logSource(tx: PluginTx, source: { sourceType: string; sourceRef: string; scope: 'team' | 'channel' | 'person' }): Promise<number> {
      // One statement through the table's append door (`app.run_source_log_append`, bots 0004): the next position is
      // read as the system role inside it, because a bot actor cannot see the lines it just wrote — the plain
      // `INSERT ... RETURNING` fails the SELECT policy on the row it returns, and computing `max(seq)` in the
      // caller's transaction would count every line as the first. The line is written in the run's own transaction,
      // so it commits with the read that produced it.
      const res = await tx.query<{ seq: number }>('SELECT app.run_source_log_append($1, $2, $3) AS seq', [
        source.sourceType,
        source.sourceRef,
        source.scope,
      ]);
      const seq = res.rows[0]?.seq;
      if (seq === undefined) throw new Error('the run source log append answered no row');
      return seq;
    },
  };
}
