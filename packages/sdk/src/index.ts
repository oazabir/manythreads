import { PluginManifest, type PluginManifestInput } from '@manythreads/shared';
import type { PluginContext, PluginDefinition, PluginTx } from './types.ts';

export * from './types.ts';

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
 * changes roles/databases (`ALTER ROLE|USER|DATABASE|SYSTEM`), or hides statements from this check (`DO`, `EXECUTE`).
 * Matching is case-insensitive on the text with comments removed. The real defences are database roles and RLS
 * (see docs/plugins/security.md); this only stops the obvious ways to spoof app.actor_id / app.workspace_id.
 */
export function assertSafePluginSql(text: string): void {
  const sql = stripSqlComments(text);
  const forbidden =
    /\bset_config\b/i.test(sql) ||
    /(^|;)\s*(set|reset|do|execute)\b/i.test(sql) ||
    /(^|;)\s*alter\s+(role|user|database|system)\b/i.test(sql) ||
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
