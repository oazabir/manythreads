import { definePlugin } from '@majlis/sdk';
import { z } from 'zod';

const EchoBody = z.strictObject({ message: z.string().min(1).max(200), count: z.number().int().min(0).max(1000).optional() });
const PingBody = z.strictObject({ workspaceId: z.uuid(), note: z.string().min(1).max(200) });
const NoteQuery = z.object({ note: z.string().min(1) });

/**
 * Test-only plugin exercising the host: strict body validation, a rate-limited route, emitting an event and
 * recording its delivery. Loaded only when MAJLIS_TEST_PLUGINS=1. Mounted at /api/test/*. echo and limited are public;
 * ping and deliveries need a (dev header) actor because they write and read under RLS.
 */
export default definePlugin({
  manifest: {
    name: 'test-kernel',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe'],
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

    ctx.events.subscribe('kernel.test.pinged', async (event, tx) => {
      await tx.query('INSERT INTO app.test_kernel_deliveries (workspace_id, event) VALUES ($1, $2::jsonb)', [
        event['workspaceId'],
        JSON.stringify(event),
      ]);
    });
  },
});
