import type { PluginTx } from '@manythreads/sdk';
import { WorkshopEntry, WorkshopSession, WorkshopUsage, type WorkshopMode, type WorkshopStatus } from '@manythreads/shared';
import { z } from 'zod';

// Reading and writing `app.workshop_sessions` (PLAN P7-05): the one mapper. `history` (the helper's own conversation) is read where the job needs it and never mapped to the API shape.

export type WsRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  bot_id: string;
  bot_slug: string;
  owner_id: string;
  mode: WorkshopMode;
  status: WorkshopStatus;
  title: string;
  entries: unknown;
  history: unknown;
  usage: unknown;
  message: string | null;
  message_count: number;
  turn: number;
  created_at: Date;
  updated_at: Date;
};

export const WS_COLUMNS = 'id, workspace_id, team_id, bot_id, bot_slug, owner_id, mode, status, title, entries, history, usage, message, message_count, turn, created_at, updated_at';

/** The entries of a row, dropping any that no longer read (an older shape) rather than failing the whole conversation. */
export function entriesOf(value: unknown): WorkshopEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WorkshopEntry[] = [];
  for (const item of value) {
    const parsed = WorkshopEntry.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const Counted = z.object({ calls: z.number().int().min(0), promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0) });
export type Counted = z.infer<typeof Counted>;

export function usageOf(value: unknown): Counted {
  const parsed = Counted.safeParse(value);
  return parsed.success ? parsed.data : { calls: 0, promptTokens: 0, completionTokens: 0 };
}

export const toWorkshopSession = (r: WsRow): WorkshopSession =>
  WorkshopSession.parse({
    id: r.id,
    teamId: r.team_id,
    botSlug: r.bot_slug,
    mode: r.mode,
    status: r.status,
    title: r.title,
    entries: entriesOf(r.entries),
    messageCount: r.message_count,
    // a rehearsal's lines in the spend ledger are labelled; the conversation says so too
    usage: WorkshopUsage.parse({ ...usageOf(r.usage), label: r.mode === 'rehearse' ? 'rehearsal' : 'workshop' }),
    message: r.message,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });

/** What a step of a turn changes in a session row. Only the fields present are written. */
export interface WsPatch {
  status?: WorkshopStatus;
  entries?: unknown;
  history?: unknown;
  usage?: unknown;
  message?: string | null;
}

const JSON_FIELDS = new Set(['entries', 'history', 'usage']);
const PLAIN_FIELDS = new Set(['status', 'message']);

/**
 * Writes a patch to a session that is still `working` on the turn the job was queued for (a person who ended the conversation, or sent another message, meanwhile is never overwritten).
 * Returns false when the row was no longer that. The column names come from this file's own patch keys, never from outside.
 */
export async function patchTurn(tx: PluginTx, id: string, turn: number, patch: WsPatch): Promise<boolean> {
  const sets: string[] = ['updated_at = now()'];
  const args: unknown[] = [id, turn];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!JSON_FIELDS.has(key) && !PLAIN_FIELDS.has(key)) throw new Error(`workshop_sessions has no patchable column "${key}"`);
    args.push(JSON_FIELDS.has(key) ? JSON.stringify(value) : value);
    sets.push(`${key} = $${String(args.length)}${JSON_FIELDS.has(key) ? '::jsonb' : ''}`);
  }
  const res = await tx.query(`UPDATE app.workshop_sessions SET ${sets.join(', ')} WHERE id = $1::uuid AND status = 'working' AND turn = $2::int RETURNING id`, args);
  return res.rows.length > 0;
}

/**
 * The transcript of a conversation the person ended while a tool of the turn was still running. The tool may have committed (a proposal is filed in its own transaction before the job learns of the
 * end), so the entries that turn made are written anyway, on the turn's own row and only while it is ended or cancelled. Nothing else changes: the status stays what the person chose.
 */
export async function patchEndedEntries(tx: PluginTx, id: string, turn: number, entries: unknown): Promise<boolean> {
  const res = await tx.query("UPDATE app.workshop_sessions SET entries = $3::jsonb, updated_at = now() WHERE id = $1::uuid AND status IN ('ended', 'cancelled') AND turn = $2::int RETURNING id", [id, turn, JSON.stringify(entries)]);
  return res.rows.length > 0;
}

/** A session whose turn has written nothing for this long is taken as stuck (the server stopped mid-turn, the model call never came back). Every step of a live one writes the row. */
export const WS_STUCK_AFTER_MINUTES = 10;
export const WS_STUCK_MESSAGE = 'The helper stopped answering. Start a new conversation.';

/** Turns the person's own `working` sessions that have not been written for `WS_STUCK_AFTER_MINUTES` into `failed`. Run whenever the person reads or starts one. */
export async function failStuckWorkshop(tx: PluginTx): Promise<number> {
  const res = await tx.query(
    `UPDATE app.workshop_sessions SET status = 'failed', message = $1, updated_at = now()
      WHERE owner_id = (SELECT app.actor()) AND status = 'working' AND updated_at < now() - make_interval(mins => $2::int) RETURNING id`,
    [WS_STUCK_MESSAGE, WS_STUCK_AFTER_MINUTES],
  );
  return res.rows.length;
}

/** The title of a conversation: the first words the person wrote. */
export const titleOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 80);
