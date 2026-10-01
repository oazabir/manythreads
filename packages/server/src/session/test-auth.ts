import { createHash, timingSafeEqual } from 'node:crypto';
import { withSystem } from '@manythreads/kernel';
import { CreateTestSessionRequest, CreateTestSessionResponse, ErrorEnvelope, createTestSessionRoute } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { envelope } from '../errors.ts';
import { setSessionCookies } from './cookies.ts';
import type { SessionService } from './service.ts';

export const TEST_AUTH_HEADER = 'x-test-auth';

/** Compares through sha256 so neither the content nor the length of the secret leaks through timing. */
export function tokensMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * TEST ONLY. `POST /api/test/session { email }` issues a REAL session (the same rows and cookies as a sign-in) for an
 * existing active person, so e2e runs and screenshots can be signed in as a persona without typing a password.
 *
 * Mounted only when `MANYTHREADS_TEST_AUTH_TOKEN` is set; a request must also carry `x-test-auth: <that value>`. Any
 * other request (no header, wrong header, no such person) gets the same 404 as a route that does not exist, and the
 * header is checked before the body is even parsed. Never set the variable on a real deployment.
 */
export function mountTestAuth(
  app: FastifyInstance,
  deps: { token: string; sessions: SessionService; pool: pg.Pool },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const notFound = envelope('not_found', `Route ${createTestSessionRoute.method} ${createTestSessionRoute.path} not found`);
  typed.post(
    createTestSessionRoute.path,
    {
      config: { public: true, csrfExempt: true },
      schema: { body: CreateTestSessionRequest, response: { 200: CreateTestSessionResponse, 404: ErrorEnvelope }, hide: true },
      preValidation: (req, reply, done) => {
        if (tokensMatch(req.headers[TEST_AUTH_HEADER], deps.token)) return done();
        void reply.status(404).send(notFound);
        return undefined;
      },
    },
    async (req, reply) => {
      const issued = await withSystem(
        async (tx) => {
          const found = await tx.query<{ id: string; workspace_id: string }>(
            `SELECT id, workspace_id FROM app.people
             WHERE lower(primary_email) = lower($1) AND status = 'active' ORDER BY created_at LIMIT 1`,
            [req.body.email],
          );
          const person = found.rows[0];
          if (!person) return null;
          const session = await deps.sessions.issue(tx, {
            workspaceId: person.workspace_id,
            personId: person.id,
            device: req.headers['user-agent'] ?? null,
          });
          return { session, personId: person.id, workspaceId: person.workspace_id };
        },
        { pool: deps.pool },
      );
      if (!issued) return reply.status(404).send(notFound);
      setSessionCookies(reply, issued.session, deps.sessions.config);
      return reply.send(
        CreateTestSessionResponse.parse({
          sessionId: issued.session.sessionId,
          personId: issued.personId,
          workspaceId: issued.workspaceId,
          csrfToken: issued.session.csrfToken,
        }),
      );
    },
  );
}
