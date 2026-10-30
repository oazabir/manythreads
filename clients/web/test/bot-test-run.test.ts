import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { GIVE_UP_MS, QUESTION_MAX, canOfferTest, capabilityLabel, interceptLine, isFinished, knowledgeNote, questionProblem, startFailureText, statusNote, tookTooLong } from '../src/screens/bots/test-run';

// The logic of the bot page's Test panel (P7-11): what may be sent, how each refusal reads, what a held-back write is called, and when to stop waiting.

describe('the question', () => {
  it('needs some text, and not more than the server takes', () => {
    expect(questionProblem('')).toMatch(/Type a question/);
    expect(questionProblem('   \n ')).toMatch(/Type a question/);
    expect(questionProblem('What is blocking the release?')).toBeNull();
    expect(questionProblem('x'.repeat(QUESTION_MAX))).toBeNull();
    expect(questionProblem('x'.repeat(QUESTION_MAX + 1))).toMatch(/under 2000/);
  });
  it('counts the text without the spaces around it, as the server does', () => {
    expect(questionProblem(` ${'x'.repeat(QUESTION_MAX)} `)).toBeNull();
  });
});

describe('who is offered Test', () => {
  const ok = { canEdit: true, status: 'active', conversational: true, runtime: 'hermes' };
  it('someone who may manage the bot, on an active bot that answers conversations with a model', () => {
    expect(canOfferTest(ok)).toBe(true);
  });
  it('nobody else', () => {
    expect(canOfferTest({ ...ok, canEdit: false })).toBe(false);
    expect(canOfferTest({ ...ok, status: 'disabled' })).toBe(false);
    expect(canOfferTest({ ...ok, status: 'invalid' })).toBe(false);
    expect(canOfferTest({ ...ok, conversational: false })).toBe(false);
    expect(canOfferTest({ ...ok, runtime: 'rules' })).toBe(false);
  });
});

describe('the writes that were not done', () => {
  it('known tools get plain words and keep their own name beside them', () => {
    expect(interceptLine({ capability: 'messages.post', target: 'c1', wouldWait: false })).toEqual({ label: 'Post a message', tool: 'messages.post', target: 'c1', wait: null });
    expect(capabilityLabel('pages.write')).toBe('Write a page');
  });
  it('a tool the list does not know is shown by its own name, never hidden', () => {
    expect(capabilityLabel('billing.refund')).toBe('billing.refund');
    expect(interceptLine({ capability: 'billing.refund', target: null, wouldWait: false }).label).toBe('billing.refund');
  });
  it('says when a real call would have waited for a person', () => {
    expect(interceptLine({ capability: 'pages.write', target: 'pages/x.md', wouldWait: true }).wait).toMatch(/Approvals inbox/);
  });
});

describe('what the answer rested on', () => {
  it('no knowledge base: says the bot answered from what it has', () => {
    expect(knowledgeNote('none')).toMatch(/no knowledge base/);
    expect(knowledgeNote('none')).toMatch(/answered from what it has/);
  });
  it('a base that was not searched is said; one that was needs no note (the answer carries its sources)', () => {
    expect(knowledgeNote('not_used')).toMatch(/did not look anything up/);
    expect(knowledgeNote('used')).toBeNull();
  });
});

describe('waiting', () => {
  it('only a run that is still going is waited for', () => {
    expect(isFinished('waiting')).toBe(false);
    for (const s of ['answered', 'stopped', 'failed'] as const) expect(isFinished(s)).toBe(true);
  });
  it('says nothing extra for an answer, and a sentence for a run that ended without one', () => {
    expect(statusNote('answered')).toBeNull();
    expect(statusNote('stopped')).toMatch(/without an answer/);
    expect(statusNote('failed')).toMatch(/Audit tab/);
  });
  it('says the bot is slow after the limit and not before', () => {
    expect(tookTooLong(1000, 1000 + GIVE_UP_MS - 1)).toBe(false);
    expect(tookTooLong(1000, 1000 + GIVE_UP_MS)).toBe(true);
  });
});

describe('refusals', () => {
  const err = (status: number, message: string) => new ApiError({ code: 'internal', status, message });
  it('too many tests, not allowed, and the server’s own sentence otherwise', () => {
    expect(startFailureText(err(429, 'rate'))).toMatch(/too fast/);
    expect(startFailureText(err(403, 'forbidden'))).toMatch(/team lead or a workspace admin/);
    expect(startFailureText(err(409, 'A test of this bot is still running. Wait for its answer first.'))).toBe('A test of this bot is still running. Wait for its answer first.');
    expect(startFailureText(new Error('boom'))).toMatch(/could not be started/);
  });
});
