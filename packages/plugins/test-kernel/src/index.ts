import { definePlugin } from '@manythreads/sdk';
import { z } from 'zod';

const EchoBody = z.strictObject({ message: z.string().min(1).max(200), count: z.number().int().min(0).max(1000).optional() });
const PingBody = z.strictObject({ workspaceId: z.uuid(), note: z.string().min(1).max(200) });
const NoteQuery = z.object({ note: z.string().min(1) });
const StubCreateBody = z.strictObject({ teamId: z.uuid(), name: z.string().min(1).max(100) });
const StubParams = z.object({ id: z.string() });
const JobBody = z.strictObject({ note: z.string().min(1).max(200), fail: z.boolean().optional() });

/**
 * Test-only plugin exercising the host: strict body validation, a rate-limited route, emitting an event and
 * recording its delivery. Loaded only when MANYTHREADS_TEST_PLUGINS=1. Mounted at /api/test/*. echo and limited are public;
 * ping and deliveries need a (dev header) actor because they write and read under RLS.
 */
export default definePlugin({
  manifest: {
    name: 'test-kernel',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register'],
    events: { emits: ['kernel.test.pinged'], consumes: ['kernel.test.pinged'] },
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.http.route({
      method: 'POST',
      path: '/api/test/echo',
      public: true,
      schema: { body: EchoBody, response: z.object({ echoed: z.string(), count: z.number() }) },
      handler: (req) => {
        const body = EchoBody.parse(req.body);
        return { body: { echoed: body.message, count: body.count ?? 1 } };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/api/test/limited',
      public: true,
      rateLimit: { limit: 60, windowMs: 60_000 },
      handler: () => ({ body: { ok: true } }),
    });

    ctx.http.route({
      method: 'POST',
      path: '/api/test/ping',
      schema: { body: PingBody, response: z.object({ note: z.string() }) },
      handler: async (req, tx) => {
        const body = PingBody.parse(req.body);
        await ctx.events.emit(tx, {
          type: 'kernel.test.pinged',
          schemaVersion: 2,
          workspaceId: body.workspaceId,
          note: body.note,
          count: 1,
        });
        return { body: { note: body.note } };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/api/test/deliveries',
      schema: { query: NoteQuery },
      handler: async (req, tx) => {
        const { note } = NoteQuery.parse(req.query);
        const res = await tx.query('SELECT event FROM app.test_kernel_deliveries WHERE event->>\'note\' = $1 ORDER BY created_at', [
          note,
        ]);
        return { body: { deliveries: res.rows.map((r) => r['event']) } };
      },
    });

    // Team-scoped stub resource (0002_stub_resources): proves team-level denial through app.can().
    ctx.http.route({
      method: 'POST',
      path: '/api/test/stub-resources',
      schema: { body: StubCreateBody },
      handler: async (req, tx) => {
        const body = StubCreateBody.parse(req.body);
        try {
          const res = await tx.query<{ id: string }>(
            'INSERT INTO app.stub_resources (workspace_id, team_id, name) VALUES ($1, $2, $3) RETURNING id',
            [tx.actor.workspaceId, body.teamId, body.name],
          );
          return { status: 201, body: { id: res.rows[0]?.id, teamId: body.teamId, name: body.name } };
        } catch (err) {
          // Row level security refused the insert: the caller may not post in that team.
          if ((err as { code?: string }).code === '42501') {
            return { status: 403, body: { error: { code: 'forbidden', message: 'You cannot add to this team' } } };
          }
          throw err;
        }
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/api/test/stub-resources/:id',
      handler: async (req, tx) => {
        const { id } = StubParams.parse(req.params);
        const uuid = z.uuid().safeParse(id);
        // An unknown id denies exactly like a forbidden one: app.can() is false for both.
        const allowed = uuid.success
          ? (await tx.query<{ ok: boolean }>("SELECT app.can('stub_resource', $1, 'read') AS ok", [id])).rows[0]?.ok === true
          : false;
        if (!allowed) return { status: 403, body: { error: { code: 'forbidden', message: 'You cannot read this resource' } } };
        const res = await tx.query('SELECT id, team_id AS "teamId", name FROM app.stub_resources WHERE id = $1', [id]);
        return { body: res.rows[0] ?? null };
      },
    });

    // Job host (P3-00): the handler runs as the system actor in the job's workspace and records a delivery; `fail` makes the
    // first attempt throw, which proves the rollback and the retry.
    ctx.jobs.register('test-kernel.record', async (payload, tx, job) => {
      const body = JobBody.parse({ note: payload['note'], ...(payload['fail'] === true ? { fail: true } : {}) });
      await tx.query('INSERT INTO app.test_kernel_deliveries (workspace_id, event) VALUES ($1, $2::jsonb)', [
        tx.actor.workspaceId,
        JSON.stringify({ type: 'job', note: body.note, attempt: job.attempt, actor: tx.actor.kind }),
      ]);
      if (body.fail === true && job.attempt === 1) throw new Error('first attempt fails on purpose');
    }, { maxAttempts: 3 });

    ctx.http.route({
      method: 'POST',
      path: '/api/test/jobs',
      schema: { body: JobBody, response: z.object({ jobId: z.string() }) },
      handler: async (req, tx) => {
        const body = JobBody.parse(req.body);
        const jobId = await ctx.jobs.enqueue(tx, 'test-kernel.record', { workspaceId: tx.actor.workspaceId, ...body });
        return { body: { jobId } };
      },
    });

    ctx.events.subscribe('kernel.test.pinged', async (event, tx) => {
      await tx.query('INSERT INTO app.test_kernel_deliveries (workspace_id, event) VALUES ($1, $2::jsonb)', [
        event['workspaceId'],
        JSON.stringify(event),
      ]);
    });
  },
});
