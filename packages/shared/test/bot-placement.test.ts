import { describe, expect, it } from 'vitest';
import { canPostReply, modelRunnerNoReply, modelRunnerProblem, modelRunnerRefusal, runsOnProblem } from '../src/bot-md/index.ts';

// The placement rules the bot loader, the proposal check, the runner catalog and the Runs on picker share.

describe('canPostReply', () => {
  it('accepts messages.post, answer.post and their namespace grants', () => {
    for (const native of [['messages.post'], ['answer.post'], ['messages.*'], ['answer.*'], ['memory.recall', 'answer.post']]) expect(canPostReply(native), native.join()).toBe(true);
  });
  it('refuses a list with neither, and the empty list', () => {
    for (const native of [[], ['memory.recall'], ['messages.read'], ['memory.*'], ['files.write']]) expect(canPostReply(native), native.join()).toBe(false);
  });
});

describe('modelRunnerProblem', () => {
  it('names a shell, files or browser first', () => {
    expect(modelRunnerProblem('M', { runtime: ['shell'], native: [] })).toBe(modelRunnerRefusal('M', ['shell']));
  });
  it('names the missing way to post when native capabilities are known', () => {
    expect(modelRunnerProblem('M', { runtime: [], native: ['memory.recall'] })).toBe(modelRunnerNoReply('M'));
    expect(modelRunnerNoReply('M')).toContain('add messages.post (or answer.post)');
  });
  it('is quiet when the bot can post, or when its native capabilities are not known', () => {
    expect(modelRunnerProblem('M', { runtime: [], native: ['messages.post'] })).toBeNull();
    expect(modelRunnerProblem('M', { runtime: [], native: undefined })).toBeNull();
  });
});

describe('runsOnProblem', () => {
  it('refuses a runner for a rules bot only', () => {
    expect(runsOnProblem({ runtime: 'rules', placement: { runs_on: 'x' } })).toMatch(/for bots that run on Hermes/);
    expect(runsOnProblem({ runtime: 'hermes', placement: { runs_on: 'x' } })).toBeNull();
    expect(runsOnProblem({ runtime: 'rules' })).toBeNull();
  });
});
