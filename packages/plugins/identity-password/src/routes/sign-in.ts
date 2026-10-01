import type { HttpResponse } from '@manythreads/sdk';
import {
  SignInWithPasswordRequest,
  SignInWithPasswordResponse,
  signInWithPasswordRoute,
} from '@manythreads/shared';
import {
  errorBody,
  findCandidates,
  loadAuthenticated,
  normalizeEmail,
  passwordAllowed,
  type Candidate,
  type Ctx,
} from '../accounts.ts';
import { emitAudit } from '../audit.ts';
import type { Lockout } from '../lockout.ts';

const GENERIC = 'Incorrect email or password.';

/**
 * POST /api/auth/password/sign-in
 *
 * - Same answer and about the same time for an unknown email, a wrong password, a person without a password and a
 *   suspended person (a decoy argon2 verify runs when there is nothing to check). Nothing is created for an unknown email.
 * - 5 failures per email + client address lock that pair for 15 minutes (in memory); the lock applies to unknown emails too.
 * - Admins and owners can always use the password form; a member gets a clear 403 when the workspace turned it off for
 *   members (only after the password was right, so it reveals nothing to a guesser).
 * - A successful sign-in issues a brand new session and ends the one the browser presented, if any.
 */
export function registerSignIn(ctx: Ctx, lockout: Lockout): void {
  let decoy: Promise<string> | undefined;
  const decoyHash = (): Promise<string> => (decoy ??= ctx.identity.hashPassword('manythreads-timing-decoy-password'));

  ctx.http.route({
    method: signInWithPasswordRoute.method,
    path: signInWithPasswordRoute.path,
    public: true,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { body: SignInWithPasswordRequest, response: SignInWithPasswordResponse },
    handler: async (req): Promise<HttpResponse> => {
      const body = SignInWithPasswordRequest.parse(req.body);
      const email = normalizeEmail(body.email);
      const key = `${email}\n${req.ip}`;

      const state = lockout.begin(key);
      if (state.locked) {
        const minutes = Math.max(1, Math.ceil(state.retryAfterMs / 60_000));
        return {
          status: 429,
          headers: { 'retry-after': String(Math.ceil(state.retryAfterMs / 1000)) },
          body: errorBody('rate_limited', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`),
        };
      }

      try {
        const candidates = await ctx.identity.runAsSystem((tx) => findCandidates(tx, email));
        let match: Candidate | undefined;
        for (const c of candidates) {
          if (c.hash && (await ctx.identity.verifyPassword(c.hash, body.password))) {
            match = c;
            break;
          }
        }
        if (candidates.every((c) => !c.hash)) await ctx.identity.verifyPassword(await decoyHash(), body.password);

        const fail = async (person: Candidate | undefined, reason: 'wrong_password' | 'suspended' | 'method_disabled') => {
          const tripped = lockout.fail(key).locked;
          const target = person ?? candidates[0];
          if (target) {
            await ctx.identity.runAsSystem(
              async (tx) => {
                await emitAudit(ctx, tx, {
                  type: 'identity.session.sign_in_failed',
                  workspaceId: target.workspaceId,
                  personId: target.personId,
                  method: 'password',
                  reason,
                  ip: req.ip,
                });
                if (tripped) {
                  await emitAudit(ctx, tx, {
                    type: 'identity.session.sign_in_failed',
                    workspaceId: target.workspaceId,
                    personId: target.personId,
                    method: 'password',
                    reason: 'locked',
                    ip: req.ip,
                  });
                }
              },
              { workspaceId: target.workspaceId },
            );
          }
        };

        if (!match) {
          await fail(undefined, 'wrong_password');
          return { status: 401, body: errorBody('unauthenticated', GENERIC) };
        }
        if (match.status !== 'active') {
          await fail(match, 'suspended');
          return { status: 401, body: errorBody('unauthenticated', GENERIC) };
        }
        if (!passwordAllowed(match)) {
          await fail(match, 'method_disabled');
          return {
            status: 403,
            body: errorBody('forbidden', 'Password sign-in is turned off for members of this workspace. Use your organisation sign-in, or ask an admin.'),
          };
        }

        const result = await ctx.identity.runAsSystem(
          async (tx) => {
            const previous = req.caller;
            if (previous?.sessionId && previous.personId) {
              await ctx.identity.sessions.revoke(tx, { sessionId: previous.sessionId, personId: previous.personId });
            }
            const issued = await ctx.identity.sessions.issue(tx, {
              workspaceId: match.workspaceId,
              personId: match.personId,
              device: req.headers['user-agent'] ?? null,
            });
            await emitAudit(ctx, tx, {
              type: 'identity.session.signed_in',
              workspaceId: match.workspaceId,
              personId: match.personId,
              sessionId: issued.sessionId,
              method: 'password',
              ip: req.ip,
            });
            return { issued, view: await loadAuthenticated(tx, match.personId, issued.expiresAt) };
          },
          { workspaceId: match.workspaceId },
        );
        lockout.reset(key);
        if (!result.view) {
          // A person with a password but no workspace membership: nothing to show them.
          return { status: 403, body: errorBody('forbidden', 'This account has no access to a workspace.') };
        }
        return { body: result.view, setSession: result.issued };
      } finally {
        lockout.end(key);
      }
    },
  });
}
