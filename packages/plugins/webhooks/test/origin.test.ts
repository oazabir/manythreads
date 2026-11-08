import { GetRunOriginResponse, ProviderEndpoint } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// "What started this run" (P16-10): the reader of the channel gets the card's facts, anyone else gets a 404, and so does a run that no app started.

const { omar, priya, sameera, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let channelId: string;
let endpointId: string;
let eventId: string;
let runId: string;
let plainRunId: string;

beforeAll(async () => {
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  channelId = await w.channelId('customer-support', 'support');
  const made = await w.call(omar, 'POST', `/api/channels/${channelId}/provider-hooks`, { provider: 'zendesk', slug: 'zendesk-origin', signingSecret: 'my-zendesk-secret-123456' });
  expect(made.status).toBe(201);
  endpointId = ProviderEndpoint.parse((made.body as { endpoint: unknown }).endpoint).id;
  await w.system(async (tx) => {
    const ws = (await tx.query<{ workspace_id: string; team_id: string }>('SELECT workspace_id, team_id FROM app.webhooks WHERE id = $1', [endpointId])).rows[0]!;
    eventId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.webhook_provider_events (workspace_id, team_id, webhook_id, provider, delivery_key, kind, external_id, url, title, actor_label, payload)
         VALUES ($1, $2, $3, 'zendesk', 'delivery-key-0001', 'ticket.created', '4512', 'https://example.zendesk.com/agent/tickets/4512', 'Printer on fire', 'Hana Okafor', '{}'::jsonb) RETURNING id`,
        [ws.workspace_id, ws.team_id, endpointId],
      )
    ).rows[0]!.id;
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'origin-bot', 'Origin bot', '', 'agent', 'hermes', 'team', repeat('a', 64), 'active') RETURNING id`,
        [ws.workspace_id, ws.team_id],
      )
    ).rows[0]!;
    const run = async (): Promise<string> =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, team_id, bot_id, trigger_type, status, channel_id) VALUES ($1, $2, $3, 'webhook', 'done', $4) RETURNING id`,
          [ws.workspace_id, ws.team_id, bot.id, channelId],
        )
      ).rows[0]!.id;
    runId = await run();
    plainRunId = await run();
    await tx.query('SELECT app.webhooks_claim_run($1::uuid, $2::uuid, $3::uuid)', [eventId, bot.id, runId]);
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('GET /api/runs/:runId/origin', () => {
  it('a reader of the channel gets what the card shows, and never the payload or the delivery key', async () => {
    const res = await w.call(omar, 'GET', `/api/runs/${runId}/origin`);
    expect(res.status).toBe(200);
    const { origin } = GetRunOriginResponse.parse(res.body);
    expect(origin).toMatchObject({ provider: 'zendesk', endpointName: 'Zendesk', kind: 'ticket.created', title: 'Printer on fire', url: 'https://example.zendesk.com/agent/tickets/4512', actorLabel: 'Hana Okafor', verified: true });
    expect(JSON.stringify(res.body)).not.toContain('delivery-key-0001');
  });

  it('a person who cannot read the channel gets a 404, the same as for a run no app started', async () => {
    // Priya is not on the Customer support team, so a private channel hides it from her as well as it hides it from members outside it
    await w.system(async (tx) => void (await tx.query('UPDATE app.channels SET private = true WHERE id = $1', [channelId])));
    try {
      const hidden = await w.call(priya, 'GET', `/api/runs/${runId}/origin`);
      const other = await w.call(omar, 'GET', `/api/runs/${plainRunId}/origin`);
      expect(hidden.status).toBe(404);
      expect(other.status).toBe(404);
      expect(hidden.body).toEqual(other.body);
    } finally {
      await w.system(async (tx) => void (await tx.query('UPDATE app.channels SET private = false WHERE id = $1', [channelId])));
    }
  });

  it('a guest with no channel gets a 404, and so does an id that is not a run', async () => {
    expect((await w.call(lena, 'GET', `/api/runs/${runId}/origin`)).status).toBe(404);
    expect((await w.call(omar, 'GET', `/api/runs/${crypto.randomUUID()}/origin`)).status).toBe(404);
  });

  it('a member of the team reads it', async () => {
    expect((await w.call(sameera, 'GET', `/api/runs/${runId}/origin`)).status).toBe(200);
  });

  it('someone who is not signed in is refused', async () => {
    expect([401, 403]).toContain((await w.call(null, 'GET', `/api/runs/${runId}/origin`)).status);
  });
});
