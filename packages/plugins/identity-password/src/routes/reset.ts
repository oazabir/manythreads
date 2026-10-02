import type { HttpResponse, PluginTx } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import {
  RequestEmailVerificationResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  requestEmailVerificationRoute,
  requestPasswordResetRoute,
  resetPasswordRoute,
  verifyEmailRoute,
} from '@manythreads/shared';
import { normalizeEmail, requireSession, type Ctx } from '../accounts.ts';
import { emitAudit } from '../audit.ts';
import { hashLinkToken, newLinkToken } from '../tokens.ts';

const RESET_TTL_MS = 60 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const GONE = 'This link has expired or was already used.';

/** Stores a fresh one-time token for a person (older unused ones of the same purpose stop working) and returns it. */
async function issueToken(
  ctx: Ctx,
  tx: PluginTx,
  input: { workspaceId: string; personId: string; purpose: 'verify_email' | 'reset_password'; email: string | null; ttlMs: number },
): Promise<string> {
  const now = ctx.runtime.now();
  await tx.query(
    `UPDATE app.email_verifications SET used_at = $3
     WHERE person_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [input.personId, input.purpose, now],
  );
  const token = newLinkToken();
  await tx.query(
    `INSERT INTO app.email_verifications (workspace_id, person_id, purpose, email, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.workspaceId, input.personId, input.purpose, input.email, hashLinkToken(token), new Date(now.getTime() + input.ttlMs), now],
  );
  return token;
}

/** Marks a token used if it is valid right now; returns its person, or null. Single use is enforced by the UPDATE. */
async function claimToken(
  ctx: Ctx,
  tx: PluginTx,
  token: string,
  purpose: 'verify_email' | 'reset_password',
): Promise<{ personId: string; workspaceId: string; email: string | null } | null> {
  const now = ctx.runtime.now();
  const res = await tx.query<{ person_id: string; workspace_id: string; email: string | null }>(
    `UPDATE app.email_verifications SET used_at = $3
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
     RETURNING person_id, workspace_id, email`,
    [hashLinkToken(token), purpose, now],
  );
  const row = res.rows[0];
  return row ? { personId: row.person_id, workspaceId: row.workspace_id, email: row.email } : null;
}

/** Password reset by mailed link, and email verification by mailed link. Tokens are single-use, expire, stored hashed. */
export function registerResetRoutes(ctx: Ctx): void {
  ctx.http.route({
    method: requestPasswordResetRoute.method,
    path: requestPasswordResetRoute.path,
    public: true,
    rateLimit: { limit: 10, windowMs: 60_000 },
    schema: { body: RequestPasswordResetRequest, response: RequestPasswordResetResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = RequestPasswordResetRequest.parse(req.body);
      const email = normalizeEmail(body.email);
      const target = await ctx.identity.runAsSystem(async (tx) => {
        const found = await tx.query<{ id: string; workspace_id: string; display_name: string; primary_email: string }>(
          `SELECT id, workspace_id, display_name, primary_email FROM app.people
           WHERE lower(primary_email) = $1 AND status = 'active' ORDER BY created_at, id LIMIT 1`,
          [email],
        );
        const person = found.rows[0];
        if (!person) return null;
        const token = await issueToken(ctx, tx, {
          workspaceId: person.workspace_id,
          personId: person.id,
          purpose: 'reset_password',
          email: null,
          ttlMs: RESET_TTL_MS,
        });
        return { person, token };
      });
      if (target) {
        // Not awaited: the answer must not depend on whether (or how fast) a mail goes out.
        void ctx.mail
          .send({
            template: 'reset',
            to: target.person.primary_email,
            name: target.person.display_name,
            url: `${ctx.runtime.publicUrl}/reset-password/${target.token}`,
          })
          .catch(() => undefined);
      }
      return { status: 202, body: { accepted: true } };
    },
  });

  ctx.http.route({
    method: resetPasswordRoute.method,
    path: resetPasswordRoute.path,
    public: true,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: ResetPasswordRequest, response: ResetPasswordResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = ResetPasswordRequest.parse(req.body);
      const hash = await ctx.identity.hashPassword(body.password);
      await ctx.identity.runAsSystem(async (tx) => {
        const claim = await claimToken(ctx, tx, body.token, 'reset_password');
        if (!claim) throw new HttpError(410, 'gone', GONE);
        const person = await tx.query<{ status: string }>('SELECT status FROM app.people WHERE id = $1', [claim.personId]);
        if (person.rows[0]?.status !== 'active') throw new HttpError(410, 'gone', GONE);
        await tx.query(
          `INSERT INTO app.password_credentials (person_id, hash, must_change, updated_at) VALUES ($1, $2, false, $3)
           ON CONFLICT (person_id) DO UPDATE SET hash = EXCLUDED.hash, must_change = false, updated_at = EXCLUDED.updated_at`,
          [claim.personId, hash, ctx.runtime.now()],
        );
        // Every other reset link of this person dies with the old password; so does every session.
        await tx.query(
          `UPDATE app.email_verifications SET used_at = $3
           WHERE person_id = $1 AND purpose = $2 AND used_at IS NULL`,
          [claim.personId, 'reset_password', ctx.runtime.now()],
        );
        await ctx.identity.sessions.revokeAll(tx, { personId: claim.personId });
        await emitAudit(ctx, tx, { type: 'identity.password.reset', workspaceId: claim.workspaceId, personId: claim.personId });
      });
      return { body: { ok: true } };
    },
  });

  ctx.http.route({
    method: requestEmailVerificationRoute.method,
    path: requestEmailVerificationRoute.path,
    rateLimit: { limit: 5, windowMs: 60_000 },
    schema: { response: RequestEmailVerificationResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      const target = await ctx.identity.runAsSystem(
        async (tx) => {
          const found = await tx.query<{ display_name: string; primary_email: string }>(
            "SELECT display_name, primary_email FROM app.people WHERE id = $1 AND status = 'active'",
            [me.personId],
          );
          const person = found.rows[0];
          if (!person) return null;
          const token = await issueToken(ctx, tx, {
            workspaceId: me.workspaceId,
            personId: me.personId,
            purpose: 'verify_email',
            email: person.primary_email,
            ttlMs: VERIFY_TTL_MS,
          });
          return { person, token };
        },
        { workspaceId: me.workspaceId },
      );
      if (target) {
        void ctx.mail
          .send({
            template: 'verify',
            to: target.person.primary_email,
            name: target.person.display_name,
            url: `${ctx.runtime.publicUrl}/verify-email/${target.token}`,
          })
          .catch(() => undefined);
      }
      return { status: 202, body: { accepted: true } };
    },
  });

  ctx.http.route({
    method: verifyEmailRoute.method,
    path: verifyEmailRoute.path,
    public: true,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { body: VerifyEmailRequest, response: VerifyEmailResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = VerifyEmailRequest.parse(req.body);
      const email = await ctx.identity.runAsSystem(async (tx) => {
        const claim = await claimToken(ctx, tx, body.token, 'verify_email');
        if (!claim?.email) throw new HttpError(410, 'gone', GONE);
        const now = ctx.runtime.now();
        const updated = await tx.query(
          `UPDATE app.person_emails SET verified_at = $3
           WHERE person_id = $1 AND lower(email) = lower($2) AND verified_at IS NULL RETURNING id`,
          [claim.personId, claim.email, now],
        );
        if (updated.rows.length === 0) {
          await tx.query(
            `INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [claim.workspaceId, claim.personId, claim.email, now],
          );
        }
        await emitAudit(ctx, tx, {
          type: 'identity.email.verified',
          workspaceId: claim.workspaceId,
          personId: claim.personId,
          email: claim.email,
        });
        return claim.email;
      });
      return { body: { ok: true, email } };
    },
  });
}
