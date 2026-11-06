import { PluginManifest, type PluginManifestInput } from '@manythreads/shared';
import type { PluginContext, PluginDefinition, PluginTx } from './types.ts';

export * from './types.ts';
export * from './cohesion.ts';
export * from './repo.ts';
export * from './memory.ts';
export * from './memory-ledger.ts';
export * from './approvals.ts';
export * from './messages.ts';
export * from './role-groups.ts';
export * from './mcp-tools.ts';
export * from './presence.ts';
export * from './answer-share.ts';
export * from './egress.ts';
export * from './runtime.ts';
export * from './runner.ts';
export * from './bot-runners.ts';
export * from './hermes-profiles.ts';
export * from './project-credentials.ts';
export * from './inbox.ts';
export * from './deploy.ts';
export * from './runner-nodes.ts';
export * from './claude-pods.ts';
export * from './media.ts';
export * from './http.ts';
export * from './lockout.ts';
export * from './tool-sources.ts';

/**
 * Declare a plugin. The manifest is validated immediately (a bad field throws a ZodError naming it), so a
 * plugin module that imports fine has a valid manifest.
 */
export function definePlugin(input: {
  manifest: PluginManifestInput;
  register(ctx: PluginContext): void | Promise<void>;
}): PluginDefinition {
  return { manifest: PluginManifest.parse(input.manifest), register: input.register };
}

/** Thrown by guarded plugin transactions for statements that could change the session's identity settings. */
export class ForbiddenPluginSqlError extends Error {
  constructor(statement: string) {
    super(`Plugin SQL rejected (session settings and roles are not available to plugins): ${statement.slice(0, 80)}`);
    this.name = 'ForbiddenPluginSqlError';
  }
}

const stripSqlComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/**
 * STOPGAP, not a sandbox. Throws for SQL that sets session state (`set_config`, `SET`, `RESET`, `SET ROLE`),
 * changes roles/databases (`ALTER ROLE|USER|DATABASE|SYSTEM`), ends or restarts the transaction the server opened (`COMMIT`, `END`, `ABORT`, `BEGIN`,
 * `START TRANSACTION`, `PREPARE TRANSACTION`, a plain `ROLLBACK`; savepoints are fine), or hides statements from this check (`DO`, `EXECUTE`).
 * Matching is case-insensitive on the text with comments removed. The real defences are database roles and RLS
 * (see docs/plugins/security.md); this only stops the obvious ways to spoof app.actor_id / app.workspace_id.
 */
export function assertSafePluginSql(text: string): void {
  const sql = stripSqlComments(text);
  const forbidden =
    /\bset_config\b/i.test(sql) ||
    /(^|;)\s*(set|reset|do|execute)\b/i.test(sql) ||
    /(^|;)\s*alter\s+(role|user|database|system)\b/i.test(sql) ||
    // ending or restarting the server-opened transaction (a READ ONLY one included); a savepoint and `ROLLBACK TO SAVEPOINT` stay allowed
    /(^|;)\s*(commit|end|abort|begin|start\s+transaction|prepare\s+transaction|rollback(?!\s+to\b))\b/i.test(sql) ||
    /\bset\s+(local\s+|session\s+)?(role|session\s+authorization)\b/i.test(sql);
  if (forbidden) throw new ForbiddenPluginSqlError(sql.trim());
}

/** Wraps a transaction so every query passes assertSafePluginSql first. Idempotent. */
export function guardPluginTx<T extends PluginTx>(tx: T): T {
  if ((tx as { __guarded?: true }).__guarded) return tx;
  const guarded = Object.create(tx, {
    query: {
      value: (text: string, values?: readonly unknown[]) => {
        try {
          assertSafePluginSql(text);
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return tx.query(text, values);
      },
    },
    __guarded: { value: true },
  }) as T;
  return guarded;
}
