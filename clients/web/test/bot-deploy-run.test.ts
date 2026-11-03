import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { STEP_TITLE, deployBody, deployFailureText, deployProblem, headline, needsAttention, stateLabel } from '../src/screens/bots/deploy-run';

// The logic of the bot page's Deploy action (P8-34): what is sent, when the button waits, what each part is called and how a refusal reads.

const draft = (over: Partial<{ dirty: boolean; issues: unknown[] }> = {}) => ({ dirty: false, issues: [], text: () => 'THE TEXT', baseBlobSha: 'a'.repeat(40), ...over });

describe('what is sent', () => {
  it('nothing, when the page has no unsaved changes: the repo’s definition is deployed as it is', () => {
    expect(deployBody(draft())).toEqual({});
  });
  it('the page’s text and the blob it was read from, when there are unsaved changes', () => {
    expect(deployBody(draft({ dirty: true }))).toEqual({ content: 'THE TEXT', baseBlobSha: 'a'.repeat(40) });
  });
  it('nothing at all when the unsaved text does not pass the page’s own checks', () => {
    expect(deployBody(draft({ dirty: true, issues: [{}] }))).toBeNull();
  });
});

describe('when the button waits', () => {
  it('only for an active bot with no issues and no deploy running, and says why otherwise', () => {
    expect(deployProblem({ status: 'active', busy: false, issues: 0 })).toBeNull();
    expect(deployProblem({ status: 'active', busy: true, issues: 0 })).toMatch(/running/);
    expect(deployProblem({ status: 'invalid', busy: false, issues: 0 })).toMatch(/active/);
    expect(deployProblem({ status: 'active', busy: false, issues: 2 })).toMatch(/Fix/);
  });
});

describe('what each part and each state is called', () => {
  it('names the three parts in plain words', () => {
    expect(STEP_TITLE).toEqual({ definition: 'Definition', knowledge: 'Knowledge', connection: 'Connection' });
  });
  it('gives every state a label, and only a refusal needs the person', () => {
    expect(stateLabel('changed')).toBe('Done');
    expect(stateLabel('unchanged')).toBe('Already as needed');
    expect(stateLabel('not_used')).toBe('Not used');
    expect(stateLabel('refused')).toBe('Refused');
    expect(stateLabel('not_run')).toBe('Not attempted');
    expect(needsAttention({ state: 'refused' })).toBe(true);
    expect(needsAttention({ state: 'not_run' })).toBe(false);
    expect(needsAttention({ state: 'changed' })).toBe(false);
  });
});

describe('the headline', () => {
  const outcome = (state: 'changed' | 'unchanged' | 'refused' | 'not_run') => ({ step: 'definition' as const, state, message: 'x' });
  it('is bad when any part was refused, even if another changed', () => {
    expect(headline({ deployed: false, summary: 'Not deployed.', outcomes: [outcome('changed'), outcome('refused'), outcome('not_run')] }).tone).toBe('bad');
  });
  it('is ok for a deploy that changed something and plain for one that changed nothing', () => {
    expect(headline({ deployed: true, summary: 'Deployed.', outcomes: [outcome('changed'), outcome('unchanged'), outcome('unchanged')] })).toEqual({ tone: 'ok', text: 'Deployed.' });
    expect(headline({ deployed: false, summary: 'Nothing to deploy.', outcomes: [outcome('unchanged'), outcome('unchanged'), outcome('unchanged')] }).tone).toBe('same');
  });
});

describe('a request that failed as a whole', () => {
  it('reads in plain words for the usual refusals and keeps the server’s words for the rest', () => {
    expect(deployFailureText(new ApiError({ code: 'rate_limited', message: 'x', status: 429 }))).toMatch(/too fast/);
    expect(deployFailureText(new ApiError({ code: 'forbidden', message: 'x', status: 403 }))).toMatch(/team lead or a workspace admin/);
    expect(deployFailureText(new ApiError({ code: 'validation_failed', message: 'The definition does not load', status: 400 }))).toBe('The definition does not load');
    expect(deployFailureText(new Error('boom'))).toMatch(/could not be started/);
  });
});
