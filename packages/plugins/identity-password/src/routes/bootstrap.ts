import type { HttpResponse, PluginTx } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import {
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  CheckBootstrapResponse,
  bootstrapWorkspaceRoute,
  checkBootstrapRoute,
} from '@manythreads/shared';
import { loadAuthenticated, normalizeEmail, type Ctx } from '../accounts.ts';
import { emitAudit } from '../audit.ts';
import { hashLinkToken, newLinkToken } from '../tokens.ts';

const GONE = 'This setup link has already been used or has expired.';
/** Serialises first-admin setup across replicas and parallel requests. */
const BOOTSTRAP_LOCK = "SELECT pg_advisory_xact_lock(hashtext('manythreads.bootstrap'))";

const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug === '' ? 'workspace' : slug;
};

async function workspaceCount(tx: PluginTx): Promise<number> {
  const res = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.workspaces');
  return res.rows[0]?.n ?? 0;
}

async function tokenIsOpen(tx: PluginTx, token: string): Promise<boolean> {
  const res = await tx.query('SELECT 1 FROM app.bootstrap_tokens WHERE token_hash = $1 AND used_at IS NULL', [hashLinkToken(token)]);
  return res.rows.length > 0;
}

/**
 * First-admin bootstrap (spec section 16, step 0). While no workspace exists, every server start stores the hash of a
 * fresh one-time token and prints ONE log line with `<public url>/bootstrap/<token>`. Opening it (GET: 200 while valid,
 * 410 otherwise) and posting the form (POST) creates the workspace, its owner, their password and a session, then the
 * token is spent: reuse is 410. Once any workspace exists the link is dead whatever the token table says.
 */
export function registerBootstrap(ctx: Ctx): void {
  ctx.identity.onStart(async (tx, log) => {
    if ((await workspaceCount(tx)) > 0) return;
    // Older unused links of earlier starts stop working: only the line printed now is valid.
    await tx.query('DELETE FROM app.bootstrap_tokens WHERE used_at IS NULL');
    const token = newLinkToken();
    await tx.query('INSERT INTO app.bootstrap_tokens (token_hash, created_at) VALUES ($1, $2)', [
      hashLinkToken(token),
      ctx.runtime.now(),
    ]);
    log.info(`first-admin setup: open ${ctx.runtime.publicUrl}/bootstrap/${token} to create your workspace (works once)`);
  });

  ctx.http.route({
    method: checkBootstrapRoute.method,
    path: checkBootstrapRoute.path,
    public: true,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: CheckBootstrapResponse },
    handler: async (req): Promise<HttpResponse> => {
      const token = req.params['token'] ?? '';
      const valid = await ctx.identity.runAsSystem(async (tx) => (await workspaceCount(tx)) === 0 && (await tokenIsOpen(tx, token)));
      if (!valid) throw new HttpError(410, 'gone', GONE);
      return { body: { valid: true } };
    },
  });

  ctx.http.route({
    method: bootstrapWorkspaceRoute.method,
    path: bootstrapWorkspaceRoute.path,
    public: true,
    rateLimit: { limit: 10, windowMs: 60_000 },
    schema: { body: BootstrapWorkspaceRequest, response: BootstrapWorkspaceResponse },
    handler: async (req): Promise<HttpResponse> => {
      const token = req.params['token'] ?? '';
      const body = BootstrapWorkspaceRequest.parse(req.body);
      const email = normalizeEmail(body.email);
      const passwordHash = await ctx.identity.hashPassword(body.password);

      const result = await ctx.identity.runAsSystem(async (tx) => {
        await tx.query(BOOTSTRAP_LOCK);
        if ((await workspaceCount(tx)) > 0 || !(await tokenIsOpen(tx, token))) throw new HttpError(410, 'gone', GONE);
        const now = ctx.runtime.now();

        const ws = await tx.query<{ id: string }>(
          'INSERT INTO app.workspaces (slug, name, self_signup, created_at, updated_at) VALUES ($1, $2, false, $3, $3) RETURNING id',
          [slugify(body.workspaceName), body.workspaceName, now],
        );
        const workspaceId = ws.rows[0]?.id;
        if (!workspaceId) throw new Error('workspace insert returned no row');
        const person = await tx.query<{ id: string }>(
          'INSERT INTO app.people (workspace_id, display_name, primary_email, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id',
          [workspaceId, body.name, email, now],
        );
        const personId = person.rows[0]?.id;
        if (!personId) throw new Error('person insert returned no row');

        await ctx.identity.ensureActor(tx, { workspaceId, personId });
        await tx.query("INSERT INTO app.workspace_members (workspace_id, person_id, role, created_at) VALUES ($1, $2, 'owner', $3)", [
          workspaceId,
          personId,
          now,
        ]);
        await tx.query('INSERT INTO app.person_emails (workspace_id, person_id, email, created_at) VALUES ($1, $2, $3, $4)', [
          workspaceId,
          personId,
          email,
          now,
        ]);
        await tx.query('INSERT INTO app.password_credentials (person_id, hash, created_at, updated_at) VALUES ($1, $2, $3, $3)', [
          personId,
          passwordHash,
          now,
        ]);
        await tx.query("INSERT INTO app.auth_providers (workspace_id, kind, enabled) VALUES ($1, 'password', true)", [workspaceId]);

        const spent = await tx.query(
          'UPDATE app.bootstrap_tokens SET used_at = $2, workspace_id = $3 WHERE token_hash = $1 AND used_at IS NULL RETURNING token_hash',
          [hashLinkToken(token), now, workspaceId],
        );
        if (spent.rows.length === 0) throw new HttpError(410, 'gone', GONE);

        const issued = await ctx.identity.sessions.issue(tx, {
          workspaceId,
          personId,
          device: req.headers['user-agent'] ?? null,
        });
        await emitAudit(ctx, tx, {
          type: 'identity.workspace.bootstrapped',
          workspaceId,
          personId,
          workspaceName: body.workspaceName,
        });
        await emitAudit(ctx, tx, {
          type: 'identity.session.signed_in',
          workspaceId,
          personId,
          sessionId: issued.sessionId,
          method: 'bootstrap',
          ip: req.ip,
        });
        return { issued, view: await loadAuthenticated(tx, personId, issued.expiresAt) };
      });
      if (!result.view) throw new Error('bootstrap produced no session view');
      return { body: result.view, setSession: result.issued };
    },
  });
}
