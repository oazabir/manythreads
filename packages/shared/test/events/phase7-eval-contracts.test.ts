import { BotsEvalRunFinishedEvent, eventRegistry, latestVersion, parseEvent } from '../../src/events/index.ts';
import { describe, expect, it } from 'vitest';

// The event of a finished eval run (PLAN P7-08): registered at version 1, counts and the score only.

const base = {
  type: 'bots.eval.run.finished',
  schemaVersion: 1,
  workspaceId: '00000000-0000-7000-8000-00000000a001',
  teamId: '00000000-0000-7000-8000-0000000b0001',
  botId: '00000000-0000-7000-8000-0000000f0002',
  slug: 'tester',
  runId: '00000000-0000-7000-8000-0000000f0010',
  set: 'qa',
  trigger: 'on_commit',
  mode: 'static',
  status: 'finished',
  commitSha: 'a'.repeat(40),
  total: 3,
  judged: 3,
  passed: 2,
  score: 0.667,
  minScore: 0.9,
  ok: false,
  at: '2026-10-30T00:00:00.000Z',
};

describe('bots.eval.run.finished', () => {
  it('is registered at version 1 and parses a run below its minimum', () => {
    expect(eventRegistry['bots.eval.run.finished']).toBeDefined();
    expect(latestVersion('bots.eval.run.finished')).toBe(1);
    const e = BotsEvalRunFinishedEvent.parse(base);
    expect(e.ok).toBe(false);
    expect(parseEvent({ ...base })).toMatchObject({ type: 'bots.eval.run.finished', slug: 'tester' });
  });

  it('a failed run has no score and no verdict; a bad trigger or score is refused', () => {
    expect(BotsEvalRunFinishedEvent.parse({ ...base, status: 'failed', score: null, ok: null, total: 0, judged: 0, passed: 0 }).ok).toBeNull();
    expect(() => BotsEvalRunFinishedEvent.parse({ ...base, trigger: 'weekly' })).toThrow();
    expect(() => BotsEvalRunFinishedEvent.parse({ ...base, score: 2 })).toThrow();
  });
});
