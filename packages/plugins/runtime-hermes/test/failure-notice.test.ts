import { describe, expect, it } from 'vitest';
import { classifyFailure, FAILURE_NOTICE, personAddressed } from '../src/failure-notice.ts';
import type { RunPayload } from '../src/run-job.ts';

describe('classifyFailure', () => {
  it('reads a refused-model text as the gateway even when it mentions a grant or an allowlist, and never as not_allowed (that category comes from a typed error, not from text)', () => {
    expect(classifyFailure('Error code: 429 rate limit')).toBe('gateway');
    expect(classifyFailure('HTTP 403 from the proxy: key not allowed')).toBe('gateway');
    expect(classifyFailure('HTTP 403: no model grant in the allowlist')).toBe('gateway');
    expect(classifyFailure('the run may not call "messages.post": no grant for "messages.post" in the actor\'s allowlist')).toBe('other');
  });
  it('keeps the other categories', () => {
    expect(classifyFailure('x', 'timeout')).toBe('timeout');
    expect(classifyFailure('boom')).toBe('other');
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
    expect(personAddressed(run({ rhythm: {} as RunPayload['rhythm'] }))).toBe(false);
  });
});
