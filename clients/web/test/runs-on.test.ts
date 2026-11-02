import { describe, expect, it } from 'vitest';
import { modelRunnerNoReply, modelRunnerRefusal, type TeamBotRunner } from '@manythreads/shared';
import { DEFAULT_CANNOT_RUN, canChoose, canRunBots, chosenNote, defaultApplies, hasOldPlacement, modelOnlyProblem, moveTarget, movedPlacement, oldPlacement, optionText, pickedPlacement, planLine } from '../src/screens/bots/runs-on';

const runner = (over: Partial<TeamBotRunner> = {}): TeamBotRunner =>
  ({ name: 'gw', label: 'Main Hermes', kind: 'hermes_gateway', status: 'ready', isDefault: false, ownerName: null, planLabel: null, sharedWith: 1, ...over }) as TeamBotRunner;

describe('the Runs on list', () => {
  it('draws the kind mark, the label and the kind, and says "default" for the default runner', () => {
    expect(optionText(runner({ isDefault: true }))).toBe('⇄ Main Hermes · Hermes gateway · default');
  });
  it('says so when a runner is not Ready, but still lets it be chosen', () => {
    const r = runner({ status: 'needs_sign_in', kind: 'hermes_pod' });
    expect(optionText(r)).toContain('Needs sign-in');
    expect(canRunBots(r)).toBe(true);
    expect(chosenNote(r)).toMatchObject({ tone: 'warn' });
    expect(chosenNote(r).text).toContain('not ready');
  });
  it('lists a kind that cannot run bots yet, marked, and warns when it is the current choice', () => {
    const r = runner({ kind: 'claude_cli', label: 'Claude' });
    expect(canRunBots(r)).toBe(false);
    expect(optionText(r)).toContain('cannot run bots yet');
    expect(chosenNote(r).tone).toBe('warn');
  });
  it('says a switched-off runner turns runs away', () => {
    expect(chosenNote(runner({ status: 'off' })).text).toContain('switched off');
    expect(chosenNote(runner()).tone).toBe('ok');
  });
  it('words the plan of a subscription runner and nothing for the others', () => {
    expect(planLine(runner())).toBeNull();
    expect(planLine(runner({ ownerName: 'Omar', planLabel: 'Max plan', sharedWith: 3 }))).toBe("Omar's Max plan · shared with 3 teams");
    expect(planLine(runner({ ownerName: 'Omar', planLabel: 'Max plan', sharedWith: 1 }))).toBe("Omar's Max plan · this team only");
  });
  it('never carries an address, key or node in what it draws', () => {
    const text = JSON.stringify([optionText(runner()), chosenNote(runner())]);
    expect(text).not.toMatch(/https?:|key|node/i);
  });
});

describe('a Model API runner', () => {
  const model = runner({ kind: 'llm_gateway', label: 'Brain model', name: 'brain' });
  it('can be chosen for a bot that asks for no shell, files or browser, and says it only calls a model', () => {
    expect(canChoose(model, [])).toBe(true);
    expect(canChoose(model)).toBe(true);
    expect(optionText(model)).toBe('◎ Brain model · Model API · model only');
    expect(chosenNote(model)).toEqual({ text: 'Brain model is ready.', tone: 'ok' });
  });
  it('is disabled and explained for a bot whose definition asks for a shell, files or a browser', () => {
    expect(canChoose(model, ['shell'])).toBe(false);
    expect(modelOnlyProblem(model, ['shell', 'browser'])).toContain('only calls a model');
    expect(modelOnlyProblem(model, ['shell', 'browser'])).toContain('shell, browser');
    expect(optionText(model, ['files'])).toContain('this bot needs one');
    expect(chosenNote(model, ['files']).tone).toBe('warn');
  });
  it('is disabled and explained for a bot that cannot post its reply, with the same sentence the bot loader saves', () => {
    expect(canChoose(model, [], ['memory.recall'])).toBe(false);
    expect(modelOnlyProblem(model, [], ['memory.recall'])).toBe(modelRunnerNoReply('Brain model'));
    expect(modelOnlyProblem(model, [], ['memory.recall'])).toContain('add messages.post (or answer.post)');
    expect(optionText(model, [], [])).toContain('this bot cannot post a reply');
    expect(chosenNote(model, [], []).tone).toBe('warn');
    expect(chosenNote(model, [], []).text).toContain('only calls a model');
  });
  it('accepts a bot with messages.post, answer.post or a namespace grant, and one whose native capabilities are not known', () => {
    for (const native of [['messages.post'], ['answer.post'], ['messages.*'], ['answer.*', 'memory.recall']]) expect(canChoose(model, [], native)).toBe(true);
    expect(canChoose(model, [])).toBe(true);
    expect(modelOnlyProblem(model, [], undefined)).toBeNull();
  });
  it('names a shell, files or browser first when both problems stand', () => {
    expect(modelOnlyProblem(model, ['shell'], [])).toBe(modelRunnerRefusal('Brain model', ['shell']));
  });
  it('changes nothing for a Hermes runner whatever the bot asks for', () => {
    expect(canChoose(runner(), [], [])).toBe(true);
    expect(modelOnlyProblem(runner(), [], [])).toBeNull();
    expect(modelOnlyProblem(runner(), ['shell'])).toBeNull();
    expect(canChoose(runner(), ['shell'])).toBe(true);
    expect(optionText(runner(), ['shell'])).toBe(optionText(runner()));
  });
  it('is never the default and is never what "Move to a runner" picks', () => {
    expect(defaultApplies({ kind: 'llm_gateway', status: 'ready' })).toBe(false);
    expect(moveTarget([model])).toBeNull();
  });
});

describe('the workspace default', () => {
  it('applies only when it is on and of a kind that can run bots; otherwise the page says the bot runs on the host and the option is not called the default', () => {
    expect(defaultApplies(runner({ isDefault: true }))).toBe(true);
    expect(defaultApplies(runner({ isDefault: true, status: 'off' }))).toBe(false);
    expect(defaultApplies(runner({ isDefault: true, kind: 'llm_gateway' }))).toBe(false);
    expect(optionText(runner({ isDefault: true, status: 'off' }))).not.toContain('default');
    expect(DEFAULT_CANNOT_RUN).toBe('This bot runs on the host because the default runner cannot run bots.');
  });
  it('"Move to a runner" does not start from a default that cannot take bots', () => {
    const off = runner({ name: 'off', isDefault: true, status: 'off' });
    const ok = runner({ name: 'ok' });
    expect(moveTarget([off, ok])?.name).toBe('ok');
  });
});

describe('picking a runner', () => {
  it('sets runs_on and keeps the other placement keys', () => {
    expect(pickedPlacement({ requires: ['chrome'] }, 'gw')).toEqual({ requires: ['chrome'], runs_on: 'gw' });
  });
  it('the empty choice removes runs_on, and an empty placement goes with it', () => {
    expect(pickedPlacement({ runs_on: 'gw' }, '')).toBeUndefined();
    expect(pickedPlacement({ runs_on: 'gw', isolation: 'shared' }, '')).toEqual({ isolation: 'shared' });
    expect(pickedPlacement(undefined, '')).toBeUndefined();
  });
});

describe('the old placement', () => {
  it('shows a Hermes connection, a node or a runner machine, read-only', () => {
    expect(hasOldPlacement({ gateway: { connection: 'office' } })).toBe(true);
    expect(hasOldPlacement({ node: 'build-01' })).toBe(true);
    expect(hasOldPlacement({ runner: 'srv' })).toBe(true);
    expect(hasOldPlacement({ runs_on: 'gw' })).toBe(false);
    expect(hasOldPlacement(undefined)).toBe(false);
    expect(oldPlacement({ gateway: { connection: 'office', profile: 'p' }, requires: ['x'] })).toEqual([
      { label: 'Hermes connection', value: 'office' },
      { label: 'Profile', value: 'p' },
    ]);
  });
  it('"Move to a runner" starts from the default, else a Ready one, else any that can run bots, else nothing', () => {
    const a = runner({ name: 'a', status: 'starting', kind: 'hermes_pod' });
    const b = runner({ name: 'b' });
    const c = runner({ name: 'c', isDefault: true, kind: 'hermes_pod' });
    expect(moveTarget([a, b, c])?.name).toBe('c');
    expect(moveTarget([a, b])?.name).toBe('b');
    expect(moveTarget([a])?.name).toBe('a');
    expect(moveTarget([runner({ kind: 'llm_gateway' })])).toBeNull();
    expect(moveTarget([])).toBeNull();
  });
  it('the move drops gateway, node and runner, keeps requires and isolation', () => {
    const moved = movedPlacement({ gateway: { connection: 'office' }, node: 'n', runner: 'r', requires: ['chrome'], isolation: 'shared' }, 'gw');
    expect(moved).toEqual({ requires: ['chrome'], isolation: 'shared', runs_on: 'gw' });
  });
});
