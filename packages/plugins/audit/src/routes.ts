import { HttpError, json, forbidden, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AUDIT_KEY_ID_HEADER,
  AUDIT_SHA256_HEADER,
  AUDIT_SIGNATURE_HEADER,
  AuditSigningKey,
  ExportAuditRequest,
  ListAuditQuery,
  ListAuditResponse,
  exportAuditRoute,
  getAuditSigningKeyRoute,
  listAuditRoute,
} from '@manythreads/shared';
import { buildExport } from './export.ts';
import { listPage } from './rows.ts';
import { signingKey } from './signing.ts';

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can see the audit log.');
}

/** Workspaces with an export being built right now on this server: an export reads up to 20,000 rows and signs them, so one runs at a time per workspace. */
const exporting = new Set<string>();

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listAuditRoute.method,
    path: listAuditRoute.path,
    schema: { query: ListAuditQuery, response: ListAuditResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const q = ListAuditQuery.parse(req.query);
      return json(await listPage(tx, tx.actor.workspaceId, q, q.cursor, q.limit));
    }),
  });

  // The export is a POST so it is never cached or followed by a link, and so the request is checked against forgery like any change. It writes one
  // event (`audit.export.created`) in the same transaction, which the console then shows as a row of its own.
  ctx.http.route({
    method: exportAuditRoute.method,
    path: exportAuditRoute.path,
    schema: { body: ExportAuditRequest },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = ExportAuditRequest.parse(req.body);
      const workspaceId = tx.actor.workspaceId;
      if (exporting.has(workspaceId)) throw new HttpError(429, 'rate_limited', 'An export is already being prepared; try again in a moment.');
      exporting.add(workspaceId);
      let out: Awaited<ReturnType<typeof buildExport>>;
      try {
        out = await buildExport(ctx, tx, workspaceId, body, body.after);
      } finally {
        exporting.delete(workspaceId);
      }
      const now = ctx.runtime.now().toISOString();
      await ctx.audit.emit(tx, {
        type: 'audit.export.created',
        workspaceId: tx.actor.workspaceId,
        exportedBy: tx.actor.id,
        rowCount: out.rowCount,
        truncated: out.truncated,
        from: body.from ?? null,
        to: body.to ?? null,
        keyId: out.keyId,
        exportedAt: now,
      });
      return {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="manythreads-audit-${now.slice(0, 10)}.ndjson"`,
          [AUDIT_SIGNATURE_HEADER]: out.signature,
          [AUDIT_KEY_ID_HEADER]: out.keyId,
          [AUDIT_SHA256_HEADER]: out.sha256,
        },
        body: out.body,
      };
    }),
  });

  ctx.http.route({
    method: getAuditSigningKeyRoute.method,
    path: getAuditSigningKeyRoute.path,
    schema: { response: AuditSigningKey },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const key = await signingKey(ctx, tx.actor.workspaceId);
      return json({ keyId: key.keyId, algorithm: 'ed25519', publicKeyPem: key.publicKeyPem, createdAt: key.createdAt.toISOString() });
    }),
  });
}
