import type { HttpResponse } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  UpdateAccountRequest,
  UpdateAccountResponse,
  changePasswordRoute,
  updateAccountRoute,
} from '@manythreads/shared';
import { requireSession, type Ctx } from '../accounts.ts';
import { emitAudit } from '../audit.ts';

/** The signed-in person's own account: change password (this file's first route) and edit the display name. */
export function registerAccountRoutes(ctx: Ctx): void {
  ctx.http.route({
    method: changePasswordRoute.method,
    path: changePasswordRoute.path,
    // A stolen session cookie must not be able to grind the current password: a few tries a minute per person.
    rateLimit: { limit: 5, windowMs: 60_000 },
    schema: { body: ChangePasswordRequest, response: ChangePasswordResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      const body = ChangePasswordRequest.parse(req.body);
      if (body.newPassword === body.currentPassword) {
        throw new HttpError(400, 'validation_failed', 'Choose a password you have not used just now.');
      }
      const hash = await ctx.identity.hashPassword(body.newPassword);
      const revokedSessions = await ctx.identity.runAsSystem(
        async (tx) => {
          // The row lock keeps two changes (or a change and a reset) from interleaving on the same person.
          const found = await tx.query<{ hash: string }>('SELECT hash FROM app.password_credentials WHERE person_id = $1 FOR UPDATE', [
            me.personId,
          ]);
          const current = found.rows[0]?.hash;
          if (!current) {
            throw new HttpError(400, 'validation_failed', 'This account has no password yet. Use "Email me a reset link" to choose one.');
          }
          if (!(await ctx.identity.verifyPassword(current, body.currentPassword))) {
            throw new HttpError(400, 'validation_failed', 'Your current password is incorrect.');
          }
          const now = ctx.runtime.now();
          await tx.query('UPDATE app.password_credentials SET hash = $2, must_change = false, updated_at = $3 WHERE person_id = $1', [
            me.personId,
            hash,
            now,
          ]);
          // A reset link mailed before this change would undo it, so every outstanding one is spent.
          await tx.query(
            `UPDATE app.email_verifications SET used_at = $2
             WHERE person_id = $1 AND purpose = 'reset_password' AND used_at IS NULL`,
            [me.personId, now],
          );
          const revoked = await ctx.identity.sessions.revokeAll(tx, { personId: me.personId, exceptSessionId: me.sessionId });
          await emitAudit(ctx, tx, {
            type: 'identity.password.changed',
            workspaceId: me.workspaceId,
            personId: me.personId,
            revokedSessions: revoked,
          });
          return revoked;
        },
        { workspaceId: me.workspaceId },
      );
      return { body: { ok: true, revokedSessions } };
    },
  });

  ctx.http.route({
    method: updateAccountRoute.method,
    path: updateAccountRoute.path,
    schema: { body: UpdateAccountRequest, response: UpdateAccountResponse },
    // Runs as the caller: the people policy lets a person update only their own row, and there is no id to name another.
    handler: async (req, tx): Promise<HttpResponse> => {
      const me = requireSession(req);
      const body = UpdateAccountRequest.parse(req.body);
      const res = await tx.query<{ id: string; display_name: string; primary_email: string }>(
        `UPDATE app.people SET display_name = $2, updated_at = $3 WHERE id = $1
         RETURNING id, display_name, primary_email`,
        [me.personId, body.displayName, ctx.runtime.now()],
      );
      const row = res.rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Not found');
      return { body: { person: { id: row.id, name: row.display_name, email: row.primary_email } } };
    },
  });
}
