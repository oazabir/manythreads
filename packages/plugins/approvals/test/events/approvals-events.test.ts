import { eventToRaw, type EventRow } from '@manythreads/kernel';
import type { ApprovalProvider, PluginTx } from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  ApprovalsApprovalRequestedEvent,
  ApprovalsApprovalResumedEvent,
  eventRegistry,
  parseEvent,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../../channels/test/world.ts';

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

// Event contract tests (pnpm test:events): the three events the approvals plugin emits are stored in the shape their registered schemas
// accept, as the actor that did the thing (the bot's request is the system here; the decision is the person's), with the team on them, and
// without any argument of the call. Nothing is emitted for a repeat request or a refused decision.

let w: World;
let approvalId = '';
let before: string | null = null;

const eventRows = (type: string): Promise<EventRow[]> =>
  w.system(
    async (tx) =>
      (
        await tx.query<EventRow>(
          `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
            WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type = $2 ORDER BY id`,
          [before, type],
        )
      ).rows,
  );

beforeAll(async () => {
  w = await createWorld();
  const teamId = (await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id));
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);
  const runId = await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'evbot', 'EvBot', '', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, bot.rows[0]!.id]);
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'mention', $4, 'running') RETURNING id`,
        [omar.workspaceId, bot.rows[0]!.id, teamId, nadia.actorId],
      )
    ).rows[0]!.id;
  });
  const provider = w.server.host.registries.providers.approvals.values()[0] as ApprovalProvider;
  const input = {
    runId,
    source: 'dlp' as const,
    tool: 'llm.call',
    summary: 'Model call held · api-key found in the message',
    argsPreview: { rules: ['api-key'] },
    resume: { kind: 'handoff' as const, payload: { prompt: 'sk-never-in-an-event' } },
    dedupeKey: 'same',
  };
  const first = await w.system((tx) => provider.request(tx as unknown as PluginTx, input));
  await w.system((tx) => provider.request(tx as unknown as PluginTx, input)); // the repeat: no new row, no new event
  approvalId = first.approvalId;
  expect((await w.call(nadia, 'POST', `/api/teams/engineering/approvals/${approvalId}/approve`, { note: '' })).status).toBe(403); // refused: no event
  expect((await w.call(omar, 'POST', `/api/teams/engineering/approvals/${approvalId}/approve`, { note: 'ok' })).status).toBe(200);
  // a hand-back is taken back by the plugin that asked; that is the "resumed" event
  const botId = await w.system(async (tx) => (await tx.query<{ bot_id: string }>('SELECT bot_id FROM app.approvals WHERE id = $1', [approvalId])).rows[0]!.bot_id);
  await w.system((tx) => provider.claim(tx as unknown as PluginTx, approvalId, { botId, source: 'dlp' }));
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('approvals events', () => {
  it('registers the three events at schema version 1 and the manifest lists exactly them', async () => {
    for (const type of ['approvals.approval.requested', 'approvals.approval.decided', 'approvals.approval.resumed'] as const) {
      expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    }
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits].sort()).toEqual(['approvals.approval.decided', 'approvals.approval.requested', 'approvals.approval.resumed']);
  });

  it('one requested event for the approval, parsing against its schema, with the team and no arguments', async () => {
    const rows = await eventRows('approvals.approval.requested');
    expect(rows).toHaveLength(1);
    const event = ApprovalsApprovalRequestedEvent.parse(parseEvent(eventToRaw(rows[0]!)));
    expect(event).toMatchObject({ approvalId, source: 'dlp', tool: 'llm.call', requesterId: nadia.actorId });
    expect(rows[0]!.team_id).toBe(event.teamId);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('sk-never-in-an-event');
  });

  it('one decided event, written by the person who decided, never by the requester\'s refused attempt', async () => {
    const rows = await eventRows('approvals.approval.decided');
    expect(rows).toHaveLength(1);
    const event = ApprovalsApprovalDecidedEvent.parse(parseEvent(eventToRaw(rows[0]!)));
    expect(event).toMatchObject({ approvalId, decision: 'approved', deciderId: omar.actorId, requesterId: nadia.actorId, source: 'dlp' });
    expect(rows[0]!.actor_id).toBe(omar.actorId);
  });

  it('one resumed event when the approved call is taken back', async () => {
    const rows = await eventRows('approvals.approval.resumed');
    expect(rows).toHaveLength(1);
    expect(ApprovalsApprovalResumedEvent.parse(parseEvent(eventToRaw(rows[0]!)))).toMatchObject({ approvalId, outcome: 'ran' });
  });
});
