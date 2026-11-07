import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { draftRoutine } from '../src/draft.ts';

// P20-11 follow-up (P21-F): a routine set up in words asks the model even when the assistant has no team (the workspace Brain), and charges the call to the person.
// The model door is canned; the database is not touched.

const WS = '00000000-0000-7000-8000-00000000a001';
const BOT = '00000000-0000-7000-8000-000000000001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';

type Answer = { ok: true; text: string } | { ok: false; reason: string; detail: string };

function rig(answer: Answer | null) {
  const requests: Array<Record<string, unknown>> = [];
  const door =
    answer === null
      ? undefined
      : {
          evalComplete: async (_tx: unknown, request: Record<string, unknown>) => {
            requests.push(request);
            return answer;
          },
        };
  const ctx = {
    providers: { get: (name: string) => (name === 'llm' ? door : undefined) },
    db: { system: async <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => fn({} as PluginTx) },
  } as unknown as PluginContext;
  const draft = (over: { teamId?: string | null; botId?: string | null } = {}) =>
    draftRoutine(ctx, {
      sentence: 'every weekday at 7, list what needs a reply',
      timeZone: 'Asia/Dubai',
      botSlug: 'brain',
      botId: over.botId === undefined ? BOT : over.botId,
      teamId: over.teamId === undefined ? null : over.teamId,
      personId: PERSON,
      workspaceId: WS,
      takenSlugs: new Set<string>(),
      now: new Date('2026-11-07T08:00:00Z'),
    });
  return { draft, requests };
}

const GOOD = JSON.stringify({ name: 'Replies to send', prompt: 'List the threads that still need my reply.', sources: ['threads'] });

describe('a routine set up in words', () => {
  it('asks the model for the workspace Brain, which belongs to no team, and charges the person', async () => {
    const r = rig({ ok: true, text: GOOD });
    const out = await r.draft({ teamId: null });
    expect(out.by).toBe('brain');
    expect(out.draft.name).toBe('Replies to send');
    expect(out.draft.prompt).toBe('List the threads that still need my reply.');
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ workspaceId: WS, botId: BOT, teamId: null, runId: `person:${PERSON}`, alias: 'fast', purpose: 'routine_draft' });
  });

  it('still passes the team of a team bot', async () => {
    const team = '00000000-0000-7000-8000-0000000b0001';
    const r = rig({ ok: true, text: GOOD });
    expect((await r.draft({ teamId: team })).by).toBe('brain');
    expect(r.requests[0]).toMatchObject({ teamId: team });
  });

  it('falls back to rules, and says so, when the model refuses', async () => {
    const r = rig({ ok: false, reason: 'refused', detail: 'budget' });
    const out = await r.draft();
    expect(out.by).toBe('rules');
    expect(out.notes.join(' ')).toContain('simple rules');
  });

  it('falls back to rules when the model answers with something that is not the JSON object', async () => {
    const out = await rig({ ok: true, text: 'Sure! Here you go.' }).draft();
    expect(out.by).toBe('rules');
  });

  it('uses rules when there is no model door or no bot, without asking', async () => {
    expect((await rig(null).draft()).by).toBe('rules');
    const r = rig({ ok: true, text: GOOD });
    expect((await r.draft({ botId: null })).by).toBe('rules');
    expect(r.requests).toHaveLength(0);
  });
});
