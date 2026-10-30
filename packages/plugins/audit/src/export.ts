import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { AUDIT_EXPORT_MAX_ROWS, type AuditEntry, type AuditExportManifest } from '@manythreads/shared';
import { COLUMNS, decodeCursor, encodeCursor, entryOf, filterEcho, whereOf, type AuditFilter, type AuditRow } from './rows.ts';
import { signBytes } from './signing.ts';

// The signed export (PLAN P10-05). The file is NDJSON ("newline-delimited JSON": one JSON object per line): a manifest line, then one `AuditEntry`
// per line, oldest first. The signature covers the exact bytes of the body, so any edit (a changed word, a removed row, a swapped order) breaks it.
// How an auditor checks it: docs/plugins/audit.md and docs/deploy.md.

/** The row cap of one export. A deployment (or a test) may lower it with `MANYTHREADS_AUDIT_EXPORT_MAX_ROWS`; it can never be raised above the limit in the API. */
export function exportRowCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['MANYTHREADS_AUDIT_EXPORT_MAX_ROWS']);
  return Number.isInteger(n) && n > 0 ? Math.min(n, AUDIT_EXPORT_MAX_ROWS) : AUDIT_EXPORT_MAX_ROWS;
}

export interface ExportResult {
  body: string;
  sha256: string;
  signature: string;
  keyId: string;
  rowCount: number;
  truncated: boolean;
}

export async function buildExport(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
  filter: AuditFilter,
  after: string | undefined,
  maxRows: number = exportRowCap(),
): Promise<ExportResult> {
  const { clauses, values } = whereOf(workspaceId, filter);
  if (after) {
    values.push(decodeCursor(after));
    clauses.push(`id > $${values.length}::uuid`);
  }
  values.push(maxRows + 1);
  const rows = (await tx.query<AuditRow>(`SELECT ${COLUMNS} FROM app.audit_events WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT $${values.length}`, values)).rows;
  const truncated = rows.length > maxRows;
  const kept = rows.slice(0, maxRows);
  const entries: AuditEntry[] = kept.map(entryOf);
  const last = kept[kept.length - 1];
  const echo = filterEcho(filter);
  if (after) echo['after'] = after;
  const manifest: AuditExportManifest = {
    kind: 'manythreads.audit.export',
    version: 1,
    workspaceId,
    generatedAt: ctx.runtime.now().toISOString(),
    filters: echo,
    rowCount: entries.length,
    truncated,
    resumeAfter: truncated && last ? encodeCursor(last.id) : null,
    contentBlind: true,
    signature: { algorithm: 'ed25519', keyId: '' },
  };
  // The key id goes in the manifest, so the key is looked up (or made) before the bytes are fixed.
  const first = await signBytes(ctx, workspaceId, Buffer.alloc(0));
  manifest.signature.keyId = first.keyId;
  const body = `${[JSON.stringify(manifest), ...entries.map((e) => JSON.stringify(e))].join('\n')}\n`;
  const bytes = Buffer.from(body, 'utf8');
  const { signature, keyId } = await signBytes(ctx, workspaceId, bytes);
  return { body, sha256: createHash('sha256').update(bytes).digest('hex'), signature, keyId, rowCount: entries.length, truncated };
}
