import { describe, expect, it } from 'vitest';
import { cardRefOfTitle, goalLine, goalRef, goalSteps, stepDot, stepWords, type GoalCardFacts, type GoalStepSpec } from '../src/tasks/goal-steps.ts';

// The plan card's rule, as a table of handoff histories (docs/plans/phase-22-plan.md "Step state rule"). A history lists who held the work card, oldest first;
// `null` is a person (or a bot nobody could name).

const STEPS: GoalStepSpec[] = [
  { bots: ['coder'] },
  { bots: ['code-reviewer'] },
  { bots: ['tester'] },
  { bots: ['deployer'] },
  { bots: ['web-smoke-tester'] },
];

const card = (holders: (string | null)[], state: GoalCardFacts['state'] = 'in_progress', blockerReason = ''): GoalCardFacts => ({ state, blockerReason, holders });
const run = (holders: (string | null)[], state: GoalCardFacts['state'] = 'in_progress', blockerReason = '', goalStatus: 'open' | 'done' | 'dropped' = 'open') =>
  goalSteps({ goalStatus, steps: STEPS, cards: { work: card(holders, state, blockerReason) } });
const statuses = (r: ReturnType<typeof goalSteps>): string[] => r.steps.map((s) => s.status);

describe('goalSteps', () => {
  it('a goal with steps and no card yet is planned, every step grey', () => {
    const r = goalSteps({ goalStatus: 'open', steps: STEPS, cards: {} });
    expect(statuses(r)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(r).toMatchObject({ chip: 'planned', stepNow: 1, stepCount: 5 });
  });

  it('a goal with no steps is planned and has no step now', () => {
    expect(goalSteps({ goalStatus: 'open', steps: [], cards: {} })).toEqual({ steps: [], chip: 'planned', stepNow: 0, stepCount: 0 });
  });

  it('follows the chain: the step of the bot holding the card runs, the steps before are done, the rest wait', () => {
    expect(statuses(run(['engineer', 'coder']))).toEqual(['running', 'todo', 'todo', 'todo', 'todo']);
    const r = run(['engineer', 'coder', 'code-reviewer', 'tester']);
    expect(statuses(r)).toEqual(['done', 'done', 'running', 'todo', 'todo']);
    expect(r).toMatchObject({ chip: 'running', stepNow: 3 });
  });

  it('counts one rework when the reviewer sends the card back to the coder, and shows it while the coder works', () => {
    const back = run(['engineer', 'coder', 'code-reviewer', 'coder']);
    expect(statuses(back)).toEqual(['running', 'todo', 'todo', 'todo', 'todo']);
    expect(back.steps[0]).toEqual({ status: 'running', rework: 1 });
    expect(stepWords(back.steps[0]!)).toBe('rework 1');
    expect(stepDot(back.steps[0]!)).toBe('running');
    // once the reviewer has it again the step is plain running and the coder's step is done
    const again = run(['engineer', 'coder', 'code-reviewer', 'coder', 'code-reviewer']);
    expect(statuses(again)).toEqual(['done', 'running', 'todo', 'todo', 'todo']);
    expect(again.steps[0]!.rework).toBe(1);
    expect(stepWords(again.steps[1]!)).toBe('running');
  });

  it('counts the same holder twice in a row once', () => {
    expect(run(['engineer', 'coder', 'code-reviewer', 'code-reviewer', 'coder']).steps[0]!.rework).toBe(1);
  });

  it('rework through the Engineer (the reviewer hands to Engineer, who hands to the coder) is still rework', () => {
    expect(run(['engineer', 'coder', 'code-reviewer', 'engineer', 'coder']).steps[0]).toEqual({ status: 'running', rework: 1 });
  });

  it('a card back with the Engineer after the tester leaves the steps up to the tester done and the next one grey', () => {
    const r = run(['engineer', 'coder', 'code-reviewer', 'tester', 'engineer']);
    expect(statuses(r)).toEqual(['done', 'done', 'done', 'todo', 'todo']);
    expect(r).toMatchObject({ chip: 'running', stepNow: 4 });
    expect(stepWords(r.steps[3]!)).toBe('');
    expect(stepDot(r.steps[3]!)).toBe('todo');
  });

  it('a card at a step that waits on a person shows waiting, and the chip says so', () => {
    const r = run(['engineer', 'coder', 'code-reviewer', 'tester', 'engineer', 'deployer'], 'waiting_on_person', 'waiting on a person');
    expect(statuses(r)).toEqual(['done', 'done', 'done', 'waiting', 'todo']);
    expect(r.chip).toBe('waiting for a person');
    expect(stepDot(r.steps[3]!)).toBe('running');
    expect(stepWords(r.steps[3]!)).toBe('waiting');
  });

  it('a card handed to a person who is in no step waits at the furthest step it reached (waiting for a merge)', () => {
    const publish: GoalStepSpec[] = [{ bots: ['committer'], cardRef: 'publish' }];
    const r = goalSteps({ goalStatus: 'open', steps: publish, cards: { publish: card(['engineer', 'committer', null], 'waiting_on_person', 'Pull request #4 waits for a person to merge it') } });
    expect(statuses(r)).toEqual(['waiting']);
    expect(r.chip).toBe('waiting for a person');
  });

  it('a blocker on a card that is not waiting shows the step blocked (red)', () => {
    const r = run(['engineer', 'coder', 'code-reviewer', 'tester'], 'in_progress', 'base_sha is 1234abcd, the branch head is 99aa00bb: rebase and test again');
    expect(statuses(r)).toEqual(['done', 'done', 'blocked', 'todo', 'todo']);
    expect(stepDot(r.steps[2]!)).toBe('blocked');
    expect(stepWords(r.steps[2]!)).toBe('blocked');
    expect(r.chip).toBe('running');
  });

  it('a done card finishes every step it carries, and a goal whose steps are all done is done', () => {
    const r = run(['engineer', 'coder', 'code-reviewer', 'tester', 'engineer', 'deployer', 'web-smoke-tester'], 'done');
    expect(statuses(r)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(r).toMatchObject({ chip: 'done', stepNow: 5, stepCount: 5 });
  });

  it('the goal itself closing decides the chip: dropped is stopped, done is done, whatever the steps say', () => {
    expect(run(['engineer', 'coder'], 'in_progress', '', 'dropped').chip).toBe('stopped');
    expect(run(['engineer', 'coder'], 'in_progress', '', 'done').chip).toBe('done');
    expect(run(['engineer', 'coder'], 'waiting_on_person', 'x', 'dropped').chip).toBe('stopped');
  });

  it('steps of different cards are worked out apart: plan, work and publish', () => {
    const steps: GoalStepSpec[] = [
      { bots: ['planner', 'plan-reviewer'], cardRef: 'plan' },
      { bots: ['coder'] },
      { bots: ['committer'], cardRef: 'publish' },
    ];
    const r = goalSteps({ goalStatus: 'open', steps, cards: { plan: card(['engineer'], 'done'), work: card(['engineer', 'coder']) } });
    expect(statuses(r)).toEqual(['done', 'running', 'todo']);
    expect(r.stepNow).toBe(2);
  });

  it('a bot named in two steps counts for the first one at or after the furthest step reached', () => {
    const steps: GoalStepSpec[] = [{ bots: ['coder'] }, { bots: ['code-reviewer'] }, { bots: ['coder'] }];
    expect(statuses(goalSteps({ goalStatus: 'open', steps, cards: { work: card(['engineer', 'coder']) } }))).toEqual(['running', 'todo', 'todo']);
    expect(statuses(goalSteps({ goalStatus: 'open', steps, cards: { work: card(['engineer', 'coder', 'code-reviewer', 'coder']) } }))).toEqual(['done', 'done', 'running']);
  });

  it('a holder that is a person or unknown belongs to no step', () => {
    expect(statuses(run([null, null]))).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
  });
});

describe('goal words', () => {
  it('names a goal by its number', () => {
    expect(goalRef(27)).toBe('G-27');
  });

  it('reads the role of a card from its title', () => {
    expect(cardRefOfTitle('Plan: add the jump button')).toBe('plan');
    expect(cardRefOfTitle('Plan review: add the jump button')).toBe('plan');
    expect(cardRefOfTitle('  publish: add the jump button')).toBe('publish');
    expect(cardRefOfTitle('Plan the jump button')).toBe('work');
    expect(cardRefOfTitle('Add the jump button')).toBe('work');
  });

  it('writes the one-line text for a client that cannot draw the card', () => {
    expect(goalLine('G-27', { chip: 'running', stepNow: 2, stepCount: 6 })).toBe('Goal G-27 · running · step 2 of 6');
    expect(goalLine('G-27', { chip: 'done', stepNow: 6, stepCount: 6 })).toBe('Goal G-27 · done · 6 steps');
    expect(goalLine('G-27', { chip: 'planned', stepNow: 0, stepCount: 0 })).toBe('Goal G-27 · planned');
  });
});
