import { describe, expect, it } from 'vitest';
import { classifyFailure, deniedNotice, FAILURE_NOTICE, personAddressed } from '../src/failure-notice.ts';
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
  it("reads the agent bridge's plain refusals and its turn limit (P25)", () => {
    expect(classifyFailure('OpenCode cannot run yet: it has not been checked that its tools can be limited to what the bot may do.')).toBe('runner_refused');
    expect(classifyFailure('This Hermes profile lets its agent run commands, which this bot is not allowed to do, and Hermes cannot be limited to less per run. Give the bot those tools.')).toBe('runner_refused');
    expect(classifyFailure('The agent did not take the model "gpt-x" that the profile pins (unknown model).')).toBe('runner_refused');
    expect(classifyFailure('This agent has no "plan" mode, so its tools cannot be limited to what the bot may do.')).toBe('runner_refused');
    expect(classifyFailure('turn limit exceeded')).toBe('steps');
    expect(classifyFailure('something else entirely')).toBe('other');
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
  it('a run that ended after a refused question names who said No and to what, in the bot\'s words (P26-02)', () => {
    expect(classifyFailure('The agent stopped after a request was refused.', 'denied')).toBe('denied');
    expect(deniedNotice({ by: 'Omar', step: 'git push origin card-1a2b3c4d', bot: 'Committer' })).toBe(
      'Omar said No to `git push origin card-1a2b3c4d`, so Committer stopped. Ask again with another way to do it.',
    );
    // nobody answered in time: no name is made up
    expect(deniedNotice({ by: null, step: 'rm -rf build', bot: 'Coder' })).toBe('Nobody approved `rm -rf build`, so Coder stopped. Ask again with another way to do it.');
    // only the first line of the command, no backtick to break the quoting, a long one cut
    expect(deniedNotice({ by: 'Omar', step: 'echo `x`\nsecond line', bot: 'Coder' })).toContain('`echo x`');
    expect(deniedNotice({ by: 'Omar', step: 'a'.repeat(300), bot: 'Coder' }).length).toBeLessThan(300);
    expect(deniedNotice({ by: null, step: null, bot: '' })).toBe('Nobody approved a step, so I stopped. Ask again with another way to do it.');
    expect(FAILURE_NOTICE.denied).not.toMatch(/something went wrong on our side/);
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
