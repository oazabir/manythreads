import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { Webhook } from '@manythreads/shared';

// Reading webhook rows. Two doors: `webhookView` for a lead's own transaction (row-level security decides what they may see) and `loadHook`
// for the public route, which runs as the system role and also reads the credential table.

export interface WebhookRow {
  id: string;
  workspace_id: string;
  team_id: string;
  channel_id: string;
  actor_id: string;
  name: string;
  emoji: string | null;
  created_by_name: string | null;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  last_status: 'posted' | 'ignored' | 'failed' | null;
  posted_count: number;
  signed: boolean;
  [key: string]: unknown;
}

export const WEBHOOK_COLUMNS =
  'w.id, w.workspace_id, w.team_id, w.channel_id, w.actor_id, w.name, w.emoji, w.created_by_name, w.created_at, w.revoked_at, w.last_used_at, w.last_status, w.posted_count, w.signed';

export const toWebhook = (r: WebhookRow): Webhook =>
  Webhook.parse({
    id: r.id,
    channelId: r.channel_id,
    name: r.name,
    emoji: r.emoji,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    lastStatus: r.last_status,
    postedCount: r.posted_count,
    signed: r.signed,
  });

/** A live webhook the caller may see (a lead of its team or a workspace admin), or null. */
export async function visibleHook(tx: PluginTx, id: string): Promise<WebhookRow | null> {
  const res = await tx.query<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM app.webhooks w WHERE w.id = $1::uuid AND w.revoked_at IS NULL`, [id]);
  return res.rows[0] ?? null;
}

export interface HookWithSecrets extends WebhookRow {
  secret_hash: Buffer | null;
  signing_secret_id: string | null;
}

/** A webhook and its credentials, by id (system transaction). Null when there is no such webhook; a revoked one has no hash. */
export async function loadHook(tx: PluginTx, id: string): Promise<HookWithSecrets | null> {
  const res = await tx.query<HookWithSecrets>(
    `SELECT ${WEBHOOK_COLUMNS}, s.secret_hash, s.signing_secret_id
       FROM app.webhooks w LEFT JOIN app.webhook_secrets s ON s.webhook_id = w.id
      WHERE w.id = $1::uuid`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** What the last call came to, kept on the row for the list ("last used"). A posted call also counts. */
export async function recordUse(ctx: PluginContext, hook: { id: string; workspace_id: string }, status: 'posted' | 'ignored' | 'failed'): Promise<void> {
  await ctx.db
    .system(
      async (sys) => {
        await sys.query(
          `UPDATE app.webhooks SET last_used_at = now(), last_status = $2, posted_count = posted_count + CASE WHEN $2 = 'posted' THEN 1 ELSE 0 END WHERE id = $1::uuid`,
          [hook.id, status],
        );
      },
      { workspaceId: hook.workspace_id },
    )
    .catch(() => undefined);
}

/** The public address of a webhook, with its secret. Built from the site's address; the secret is shown once and never stored. */
export const webhookUrl = (publicUrl: string, id: string, secret: string): string => `${publicUrl.replace(/\/+$/, '')}/hooks/${id}/${secret}`;
