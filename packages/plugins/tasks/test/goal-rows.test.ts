import { describe, expect, it } from 'vitest';
import { readSteps, toGoal, type GoalRow } from '../src/rows.ts';

// A stored plan that cannot be read must not fail the list of goals: the entries that are not steps are left out.

const row = (steps: unknown): GoalRow =>
  ({
    id: '00000000-0000-7000-8000-000000000001',
    workspace_id: '00000000-0000-7000-8000-000000000002',
    team_id: '00000000-0000-7000-8000-000000000003',
    number: 4,
    title: 'Jump button',
    description: '',
    status: 'open',
    budget_usd: '12.50',
    channel_id: null,
    thread_root_id: null,
    steps,
    created_by: '00000000-0000-7000-8000-000000000004',
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
  }) as unknown as GoalRow;

const good = { title: 'Write the code', bots: ['coder'], done: 'The branch builds' };

describe('toGoal with a stored plan', () => {
  it('reads valid steps as they are and the budget as a number', () => {
    const goal = toGoal(row([good, { ...good, title: 'Review', bots: ['code-reviewer'], cardRef: 'work' }]));
    expect(goal.steps.map((s) => s.title)).toEqual(['Write the code', 'Review']);
    expect(goal.budgetUsd).toBe(12.5);
  });

  it('leaves out an entry that is not a step instead of throwing', () => {
    const goal = toGoal(row([good, { title: '', bots: [] }, 'nonsense', null, { ...good, extra: 1 }, { ...good, title: 'Last' }]));
    expect(goal.steps.map((s) => s.title)).toEqual(['Write the code', 'Last']);
  });

  it('reads a stored value that is not even a list as no steps', () => {
    expect(toGoal(row({ not: 'a list' })).steps).toEqual([]);
    expect(readSteps(null)).toEqual([]);
  });

  it('keeps at most twelve steps', () => {
    expect(readSteps(Array.from({ length: 15 }, () => good))).toHaveLength(12);
  });
});
