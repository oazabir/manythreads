import { TasksGoalUpdatedEvent, eventRegistry, latestVersion, parseEvent } from '../../src/events/index.ts';
import { describe, expect, it } from 'vitest';

const base = {
  type: 'tasks.goal.updated',
  schemaVersion: 1,
  workspaceId: '00000000-0000-7000-8000-00000000a001',
  teamId: '00000000-0000-7000-8000-0000000b0001',
  goalId: '00000000-0000-7000-8000-0000000f0010',
  number: 27,
  change: 'planned',
  status: 'open',
  stepCount: 6,
  actorId: '00000000-0000-7000-8000-0000000d0002',
};

describe('tasks.goal.updated', () => {
  it('is registered at version 1 and parses a plan change with ids and counts only', () => {
    expect(Object.keys(eventRegistry)).toContain('tasks.goal.updated');
    expect(latestVersion('tasks.goal.updated')).toBe(1);
    expect(TasksGoalUpdatedEvent.parse(base)).toMatchObject({ number: 27, change: 'planned', stepCount: 6 });
    expect(parseEvent(base)).toMatchObject({ type: 'tasks.goal.updated' });
  });

  it('refuses a change it does not know, more than twelve steps and a goal number of zero', () => {
    expect(() => parseEvent({ ...base, change: 'renamed' })).toThrow();
    expect(() => parseEvent({ ...base, stepCount: 13 })).toThrow();
    expect(() => parseEvent({ ...base, number: 0 })).toThrow();
  });
});
