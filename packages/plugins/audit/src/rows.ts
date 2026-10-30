import type { PluginTx } from '@manythreads/sdk';
import { invalid } from '@manythreads/sdk';
import type { AuditEntry } from '@manythreads/shared';

// The one place an `audit_events` row becomes an `AuditEntry`, and the one place the filters become SQL.

export type AuditRow = {
  id: string;
  occurred_at: Date;
  team_id: string | null;
  team_name: string | null;
  actor_id: string | null;
  actor_kind: AuditEntry['actor']['kind'];
  actor_name: string;
  category: AuditEntry['category'];
  action: string;
  target_kind: string | null;
  target_id: string | null;
  target_label: string | null;
  outcome: AuditEntry['outcome'];
  reason: string | null;
  source: AuditEntry['source'];
};

export const COLUMNS =
  'id, occurred_at, team_id, team_name, actor_id, actor_kind, actor_name, category, action, target_kind, target_id, target_label, outcome, reason, source';

export function entryOf(row: AuditRow): AuditEntry {
  return {
    id: row.id as AuditEntry['id'],
    occurredAt: row.occurred_at.toISOString(),
    actor: { id: row.actor_id, kind: row.actor_kind, name: row.actor_name },
    category: row.category,
    action: row.action,
    target: { kind: row.target_kind, id: row.target_id, label: row.target_label },
    team: row.team_id ? { id: row.team_id, name: row.team_name ?? '' } : null,
    outcome: row.outcome,
    reason: row.reason,
    source: row.source,
  };
}

/** The filters both the list and the export accept. */
export interface AuditFilter {
  actor?: string | undefined;
  category?: string | undefined;
  action?: string | undefined;
  team?: string | undefined;
  targetKind?: string | undefined;
  targetId?: string | undefined;
  outcome?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The cursor is the id of the last row seen, wrapped so a client does not build one by hand. */
export const encodeCursor = (id: string): string => Buffer.from(`a1:${id}`, 'utf8').toString('base64url');
export function decodeCursor(cursor: string): string {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^a1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(text);
  if (!m) throw invalid('That page marker is not valid; start again from the first page.');
  return m[1]!;
}

/** The filters as the manifest of an export records them (only those given). */
export function filterEcho(f: AuditFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

/** WHERE clauses for a workspace and a filter, with their parameters. `values[0]` is always the workspace. */
export function whereOf(workspaceId: string, f: AuditFilter): { clauses: string[]; values: unknown[] } {
  const values: unknown[] = [workspaceId];
  const clauses = ['workspace_id = $1::uuid'];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (f.actor) add('actor_id = ?::uuid', f.actor);
  if (f.category) add('category = ?', f.category);
  if (f.action) add('action = ?', f.action);
  if (f.team) add('team_id = ?::uuid', f.team);
  if (f.targetKind) add('target_kind = ?', f.targetKind);
  if (f.targetId) add('target_id = ?', f.targetId);
  if (f.outcome) add('outcome = ?', f.outcome);
  if (f.from) add('occurred_at >= ?::timestamptz', f.from);
  if (f.to) add('occurred_at < ?::timestamptz', f.to);
  return { clauses, values };
}

/** One page, newest first. */
export async function listPage(tx: PluginTx, workspaceId: string, f: AuditFilter, cursor: string | undefined, limit: number): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const { clauses, values } = whereOf(workspaceId, f);
  if (cursor) {
    values.push(decodeCursor(cursor));
    clauses.push(`id < $${values.length}::uuid`);
  }
  values.push(limit + 1);
  const rows = (await tx.query<AuditRow>(`SELECT ${COLUMNS} FROM app.audit_events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT $${values.length}`, values)).rows;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { entries: page.map(entryOf), nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null };
}
