import type { HttpResponse, PluginTx } from '@manythreads/sdk';
import { HttpError, guardRedemption, type Lockout } from '@manythreads/sdk';
import {
  RequestEmailVerificationResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  abuseLimit,
  addressKey,
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
/** One mail per account per minute for a reset request: a stranger cannot fill someone's inbox, whatever the address he comes from. */
const RESET_MAIL_COOLDOWN_MS = 60_000;

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
export function registerResetRoutes(ctx: Ctx, locks: { tokens: Lockout; account: Lockout }): void {
  ctx.http.route({
    method: requestPasswordResetRoute.method,
    path: requestPasswordResetRoute.path,
    public: true,
    rateLimit: abuseLimit(requestPasswordResetRoute.method, requestPasswordResetRoute.path),
    rateLimitBy: 'address',
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
        // A reset link issued less than a minute ago is still good: answer the same, send nothing new.
        const recent = await tx.query(
          `SELECT 1 FROM app.email_verifications WHERE person_id = $1 AND purpose = 'reset_password' AND used_at IS NULL AND created_at > $2`,
          [person.id, new Date(ctx.runtime.now().getTime() - RESET_MAIL_COOLDOWN_MS)],
        );
        if (recent.rows.length > 0) return null;
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
    rateLimit: abuseLimit(resetPasswordRoute.method, resetPasswordRoute.path),
    rateLimitBy: 'address',
    schema: { body: ResetPasswordRequest, response: ResetPasswordResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = ResetPasswordRequest.parse(req.body);
      const hash = await ctx.identity.hashPassword(body.password);
      await guardRedemption(locks.tokens, `reset\n${addressKey(req.ip)}`, 'attempts with a link', () => ctx.identity.runAsSystem(async (tx) => {
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
        // Whoever holds the mailbox owns the account: a reset also lifts the account's sign-in lock (the way back for a locked-out owner).
        const email = await tx.query<{ primary_email: string }>('SELECT primary_email FROM app.people WHERE id = $1', [claim.personId]);
        const primary = email.rows[0]?.primary_email;
        if (primary) locks.account.reset(normalizeEmail(primary));
      }));
      return { body: { ok: true } };
    },
  });

  ctx.http.route({
    method: requestEmailVerificationRoute.method,
    path: requestEmailVerificationRoute.path,
    rateLimit: abuseLimit(requestEmailVerificationRoute.method, requestEmailVerificationRoute.path),
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
    rateLimit: abuseLimit(verifyEmailRoute.method, verifyEmailRoute.path),
    rateLimitBy: 'address',
    schema: { body: VerifyEmailRequest, response: VerifyEmailResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = VerifyEmailRequest.parse(req.body);
      const email = await guardRedemption(locks.tokens, `verify\n${addressKey(req.ip)}`, 'attempts with a link', () => ctx.identity.runAsSystem(async (tx) => {
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
      }));
      return { body: { ok: true, email } };
    },
  });
}
