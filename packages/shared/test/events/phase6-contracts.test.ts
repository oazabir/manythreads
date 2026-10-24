import {
  RhythmsRhythmRanEvent,
  TasksTaskClaimedEvent,
  TasksTaskCompletedEvent,
  TasksTaskCreatedEvent,
  TasksTaskHandedOffEvent,
  TasksTaskUpdatedEvent,
  eventRegistry,
  latestVersion,
  parseEvent,
} from '../../src/events/index.ts';
import { describe, expect, it } from 'vitest';

const WS = '00000000-0000-7000-8000-00000000a001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const TASK = '00000000-0000-7000-8000-0000000f0001';
const ACTOR = '00000000-0000-7000-8000-0000000d0002';
const BOT = '00000000-0000-7000-8000-0000000f0002';

describe('phase 6 events are registered at version 1', () => {
  it.each([
    'tasks.task.created',
    'tasks.task.updated',
    'tasks.task.claimed',
    'tasks.task.completed',
    'tasks.task.handed_off',
    'rhythms.rhythm.ran',
  ])('%s', (type) => {
    expect(Object.keys(eventRegistry)).toContain(type);
    expect(latestVersion(type as keyof typeof eventRegistry)).toBe(1);
  });
});

describe('task events', () => {
  it('parses a created card and refuses a state that is not one of the five', () => {
    const base = {
      type: 'tasks.task.created',
      schemaVersion: 1,
      workspaceId: WS,
      teamId: TEAM,
      taskId: TASK,
      goalId: null,
      state: 'open',
      kind: 'code',
      priority: 'normal',
      creatorId: ACTOR,
    };
    expect(TasksTaskCreatedEvent.parse(base).taskId).toBe(TASK);
    expect(() => parseEvent({ ...base, state: 'blocked' })).toThrow();
    expect(() => parseEvent({ ...base, kind: 'bug' })).toThrow();
  });

  it('carries the freshness fact on an update and the tested sha on completion', () => {
    const updated = TasksTaskUpdatedEvent.parse({
      type: 'tasks.task.updated',
      schemaVersion: 1,
      workspaceId: WS,
      teamId: TEAM,
      taskId: TASK,
      state: 'verify',
      fromState: 'in_progress',
      kind: 'code',
      ownerId: ACTOR,
      testedSha: null,
      actorId: ACTOR,
    });
    expect(updated.fromState).toBe('in_progress');
    expect(() => TasksTaskUpdatedEvent.parse({ ...updated, testedSha: 'not-a-sha' })).toThrow();

    const completed = TasksTaskCompletedEvent.parse({
      type: 'tasks.task.completed',
      schemaVersion: 1,
      workspaceId: WS,
      teamId: TEAM,
      taskId: TASK,
      kind: 'code',
      actorId: ACTOR,
      testedSha: 'abcdef1',
    });
    expect(completed.testedSha).toBe('abcdef1');
  });

  it('names the claim owner and expiry, and the handoff target', () => {
    expect(
      TasksTaskClaimedEvent.parse({
        type: 'tasks.task.claimed',
        schemaVersion: 1,
        workspaceId: WS,
        teamId: TEAM,
        taskId: TASK,
        actorId: ACTOR,
        actorKind: 'person',
        expiresAt: '2026-10-20T10:00:00.000Z',
      }).actorKind,
    ).toBe('person');
    const handoff = TasksTaskHandedOffEvent.parse({
      type: 'tasks.task.handed_off',
      schemaVersion: 1,
      workspaceId: WS,
      teamId: TEAM,
      taskId: TASK,
      handoffId: '00000000-0000-7000-8000-0000000f0003',
      fromActorId: ACTOR,
      toActorId: BOT,
      mode: 'bot',
      approvalId: null,
      note: 'take it',
    });
    expect(handoff.mode).toBe('bot');
    expect(() => TasksTaskHandedOffEvent.parse({ ...handoff, mode: 'system' })).toThrow();
  });
});

describe('rhythm events', () => {
  it('carries the run, the output page and the failure reason', () => {
    const run = RhythmsRhythmRanEvent.parse({
      type: 'rhythms.rhythm.ran',
      schemaVersion: 1,
      workspaceId: WS,
      teamId: TEAM,
      rhythmId: '00000000-0000-7000-8000-0000000f0004',
      rhythmRunId: '00000000-0000-7000-8000-0000000f0005',
      botId: BOT,
      kind: 'routine',
      status: 'failed',
      outputPath: 'pages/reports/weekly.md',
      taskId: null,
      reason: 'the contract routines/weekly.yaml is invalid: output.page must live under pages/',
    });
    expect(run.status).toBe('failed');
    expect(() => RhythmsRhythmRanEvent.parse({ ...run, kind: 'cron' })).toThrow();
    expect(() => RhythmsRhythmRanEvent.parse({ ...run, status: 'queued-ish' })).toThrow();
  });
});
