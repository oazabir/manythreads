import { describe, expect, it } from 'vitest';
import { classifyFailure, FAILURE_NOTICE, personAddressed } from '../src/failure-notice.ts';
import type { RunPayload } from '../src/run-job.ts';

describe('classifyFailure', () => {
  it('reads a refused-model text as the gateway even when it mentions a grant or an allowlist, and never as not_allowed (that category comes from a typed error, not from text)', () => {
    expect(classifyFailure('This bot runs on Main Hermes, which an admin has switched off.', 'runner_refused')).toBe('runner_refused');
    expect(FAILURE_NOTICE.runner_refused).not.toMatch(/https?:|key/i);
    expect(classifyFailure('Error code: 429 rate limit')).toBe('gateway');
    expect(classifyFailure('HTTP 403 from the proxy: key not allowed')).toBe('gateway');
    expect(classifyFailure('HTTP 403: no model grant in the allowlist')).toBe('gateway');
    expect(classifyFailure('the run may not call "messages.post": no grant for "messages.post" in the actor\'s allowlist')).toBe('other');
  });
  it('keeps the other categories', () => {
    expect(classifyFailure('x', 'timeout')).toBe('timeout');
    expect(classifyFailure('boom')).toBe('other');
  });
  it('reads the typed failures of the model runtime: the step limit and a model limit have their own sentences', () => {
    expect(classifyFailure('the run used all 12 of its steps', 'steps')).toBe('steps');
    expect(FAILURE_NOTICE.steps).toMatch(/steps/);
    expect(FAILURE_NOTICE.steps).not.toMatch(/https?:|key|12/i);
    expect(classifyFailure('refused: x', 'limit')).toBe('limit');
    expect(classifyFailure('unbound: x', 'gateway')).toBe('gateway');
  });
  it('has its own sentence for an answer that would have been cut off at the length limit', () => {
    expect(classifyFailure('the answer was cut off at the length limit', 'too_long')).toBe('too_long');
    expect(FAILURE_NOTICE.too_long).toMatch(/longer than I am allowed to write/);
    expect(FAILURE_NOTICE.too_long).not.toMatch(/https?:|key/i);
  });
  it('says plainly, in one sentence, that the bot is not set up to post', () => {
    expect(FAILURE_NOTICE.not_allowed).toMatch(/^I couldn't answer: [^.]*\. [^.]*\.$/);
  });
});

describe('personAddressed', () => {
  const run = (over: Partial<RunPayload>) => ({ trigger: 'mention', replyRootId: 'root', ...over }) as RunPayload;
  it('is true for a conversation, a mention and a card handover that has a thread', () => {
    expect(personAddressed(run({ trigger: 'conversation' }))).toBe(true);
    expect(personAddressed(run({ trigger: 'mention' }))).toBe(true);
    expect(personAddressed(run({ trigger: 'task_assigned' }))).toBe(true);
  });
  it('is false for a watched channel, a handover with no thread and a scheduled firing', () => {
    expect(personAddressed(run({ trigger: 'channel_message' }))).toBe(false);
    expect(personAddressed(run({ trigger: 'task_assigned', replyRootId: null }))).toBe(false);
    expect(personAddressed(run({ scheduledJob: {} as RunPayload['scheduledJob'] }))).toBe(false);
  });
});
