import type { HttpResponse } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import {
  GetSessionResponse,
  ListSessionsResponse,
  RevokeSessionResponse,
  SessionId,
  SignOutEverywhereResponse,
  SignOutResponse,
  getSessionRoute,
  listSessionsRoute,
  revokeSessionRoute,
  signOutEverywhereRoute,
  signOutRoute,
} from '@manythreads/shared';
import { errorBody, firstWorkspaceId, loadAuthenticated, loadMethods, requireSession, type Ctx } from '../accounts.ts';
import { emitAudit } from '../audit.ts';

/** GET /api/session, sign-out, sign-out-everywhere, and the caller's own session list. */
export function registerSessionRoutes(ctx: Ctx): void {
  ctx.http.route({
    method: getSessionRoute.method,
    path: getSessionRoute.path,
    public: true,
    schema: { response: GetSessionResponse },
    handler: async (req): Promise<HttpResponse> => {
      const caller = req.caller;
      const body = await ctx.identity.runAsSystem(async (tx) => {
        if (caller?.personId && caller.sessionId) {
          const row = await tx.query<{ expires_at: Date }>('SELECT expires_at FROM app.sessions WHERE id = $1 AND person_id = $2', [
            caller.sessionId,
            caller.personId,
          ]);
          const expires = row.rows[0]?.expires_at;
          const view = expires ? await loadAuthenticated(tx, caller.personId, expires.toISOString()) : null;
          if (view) return view;
        }
        const workspaceId = await firstWorkspaceId(tx);
        return { authenticated: false as const, methods: workspaceId ? await loadMethods(tx, workspaceId) : [] };
      });
      return { body };
    },
  });

  ctx.http.route({
    method: signOutRoute.method,
    path: signOutRoute.path,
    schema: { response: SignOutResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      await ctx.identity.runAsSystem(
        async (tx) => {
          const revoked = await ctx.identity.sessions.revoke(tx, { sessionId: me.sessionId, personId: me.personId });
          await emitAudit(ctx, tx, {
            type: 'identity.session.signed_out',
            workspaceId: me.workspaceId,
            personId: me.personId,
            sessionId: me.sessionId,
            scope: 'session',
            revoked: revoked ? 1 : 0,
          });
        },
        { workspaceId: me.workspaceId },
      );
      return { body: { ok: true }, clearSession: true };
    },
  });

  ctx.http.route({
    method: signOutEverywhereRoute.method,
    path: signOutEverywhereRoute.path,
    schema: { response: SignOutEverywhereResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      const revoked = await ctx.identity.runAsSystem(
        async (tx) => {
          const n = await ctx.identity.sessions.revokeAll(tx, { personId: me.personId });
          await emitAudit(ctx, tx, {
            type: 'identity.session.signed_out',
            workspaceId: me.workspaceId,
            personId: me.personId,
            sessionId: null,
            scope: 'everywhere',
            revoked: n,
          });
          return n;
        },
        { workspaceId: me.workspaceId },
      );
      return { body: { ok: true, revoked }, clearSession: true };
    },
  });

  ctx.http.route({
    method: listSessionsRoute.method,
    path: listSessionsRoute.path,
    schema: { response: ListSessionsResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      const sessions = await ctx.identity.runAsSystem((tx) => ctx.identity.sessions.list(tx, me.personId, me.sessionId), {
        workspaceId: me.workspaceId,
      });
      return { body: { sessions } };
    },
  });

  ctx.http.route({
    method: revokeSessionRoute.method,
    path: revokeSessionRoute.path,
    schema: { response: RevokeSessionResponse },
    handler: async (req): Promise<HttpResponse> => {
      const me = requireSession(req);
      const id = SessionId.safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found', 'No such session.');
      const revoked = await ctx.identity.runAsSystem(
        async (tx) => {
          const ok = await ctx.identity.sessions.revoke(tx, { sessionId: id.data, personId: me.personId });
          if (ok) {
            await emitAudit(ctx, tx, {
              type: 'identity.session.signed_out',
              workspaceId: me.workspaceId,
              personId: me.personId,
              sessionId: id.data,
              scope: id.data === me.sessionId ? 'session' : 'other_session',
              revoked: 1,
            });
          }
          return ok;
        },
        { workspaceId: me.workspaceId },
      );
      if (!revoked) return { status: 404, body: errorBody('not_found', 'No such session.') };
      return { body: { ok: true }, ...(id.data === me.sessionId ? { clearSession: true } : {}) };
    },
  });
}
