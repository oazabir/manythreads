import { describe, expect, it } from 'vitest';
import {
  FOCUS_ID,
  GRADE_WORDS,
  GUARD_WORDS,
  RUNTIME_WORDS,
  TRIGGER_WORDS,
  announcement,
  answeredCount,
  answersFrom,
  approvalOrder,
  botSlugOf,
  briefFromExample,
  briefReady,
  examplesFrom,
  feasibilitySummary,
  pollDelay,
  sortedByGrade,
  stepOf,
  stopsPolling,
  workingLine,
} from '../src/screens/setup/model';

// P7-04: the logic of the "Add a bot" screen, apart from React.

describe('the step a conversation is at', () => {
  it('is the brief until there is a conversation, then its status', () => {
    expect(stepOf(null)).toBe('brief');
    for (const status of ['working', 'asking', 'proposed', 'failed', 'cancelled'] as const) expect(stepOf({ status })).toBe(status);
  });

  it('reads a working conversation quickly at first and slower later', () => {
    expect(pollDelay(0)).toBeLessThan(pollDelay(15));
    expect(pollDelay(15)).toBeLessThan(pollDelay(60));
    expect(pollDelay(0)).toBeGreaterThanOrEqual(1000);
  });

  it('says what the helper is doing while it works', () => {
    expect(workingLine({ inventory: null, answers: [] })).toMatch(/what this team has/);
    expect(workingLine({ inventory: {} as never, answers: [] })).toMatch(/what the bot needs/);
    expect(workingLine({ inventory: {} as never, answers: [{} as never] })).toMatch(/your answers/);
  });
});

describe('the brief', () => {
  it('needs a sentence or two before it can be sent', () => {
    expect(briefReady('')).toBe(false);
    expect(briefReady('   short ')).toBe(false);
    expect(briefReady('Answer questions from the manuals')).toBe(true);
  });

  it('offers the bots of the team templates as examples: not Brain, nothing without a role, a shared bot once', () => {
    const bot = (slug: string, name: string, role: string) => ({ slug, name, role });
    const list = examplesFrom([
      { name: 'Customer support', bots: [bot('brain', 'Brain', 'Team memory.'), bot('support-responder', 'Support responder', 'Drafts answers from the manuals.'), bot('quiet', 'Quiet', '  ')] },
      { name: 'Engineering', bots: [bot('brain', 'Brain', 'Team memory.'), bot('support-responder', 'Support responder', 'Again.'), bot('reviewer', 'Reviewer', 'Reviews a change')] },
    ]);
    expect(list.map((e) => e.key)).toEqual(['support-responder', 'reviewer']);
    expect(list[0]).toMatchObject({ template: 'Customer support', name: 'Support responder', role: 'Drafts answers from the manuals.' });
    expect(examplesFrom([])).toEqual([]);
  });

  it('turns a picked example into a brief long enough to send, ending in a full stop', () => {
    expect(briefFromExample({ name: 'Reviewer', role: 'Reviews a change' })).toBe('Like the Reviewer bot. Reviews a change.');
    expect(briefFromExample({ name: 'Reviewer', role: 'Reviews a change.' })).toBe('Like the Reviewer bot. Reviews a change.');
    expect(briefReady(briefFromExample({ name: 'A', role: 'B' }))).toBe(true);
  });
});

describe('the grades', () => {
  it('have a plain word each, none of them jargon', () => {
    expect(GRADE_WORDS).toEqual({ covered: 'Covered', grantable: 'Needs approval', missing: 'Missing', blocked: 'Not allowed', unclear: 'Unclear' });
  });

  it('read from what can be done to what cannot', () => {
    const list = [{ grade: 'unclear' }, { grade: 'covered' }, { grade: 'blocked' }, { grade: 'grantable' }, { grade: 'missing' }] as const;
    expect(sortedByGrade(list).map((r) => r.grade)).toEqual(['covered', 'grantable', 'missing', 'blocked', 'unclear']);
  });

  it('are summed up in one line: what was asked, what is open, what needs approval', () => {
    expect(feasibilitySummary([])).toBe('Nothing listed yet.');
    expect(feasibilitySummary([{ grade: 'covered' }])).toBe('1 thing asked for');
    expect(feasibilitySummary([{ grade: 'covered' }, { grade: 'missing' }, { grade: 'unclear' }, { grade: 'grantable' }])).toBe('4 things asked for · 2 open · 1 to approve');
  });
});

describe('the answers', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }];

  it('go together: none until every question has an answer, then one for each in order', () => {
    expect(answersFrom(questions, {})).toBeNull();
    expect(answersFrom(questions, { q1: 'a' })).toBeNull();
    expect(answersFrom(questions, { q1: 'a', q2: '   ' })).toBeNull();
    expect(answersFrom(questions, { q2: ' b ', q1: 'a' })).toEqual([
      { questionId: 'q1', text: 'a' },
      { questionId: 'q2', text: 'b' },
    ]);
    expect(answersFrom([], {})).toBeNull();
  });

  it('are counted for "2 of 3 answered"', () => {
    expect(answeredCount(questions, { q1: 'a', q2: '' })).toBe(1);
    expect(answeredCount(questions, { q1: 'a', q2: 'b', q9: 'x' })).toBe(2);
  });
});

describe('the proposals', () => {
  const refs = [
    { role: 'bot', path: 'bots/release-helper/BOT.md' },
    { role: 'team', path: 'TEAM.md' },
    { role: 'skill', path: 'skills/triage/SKILL.md' },
  ] as const;

  it('are approved with the bot last, so what it names is already there', () => {
    expect(approvalOrder(refs).map((r) => r.role)).toEqual(['team', 'skill', 'bot']);
    expect(refs.map((r) => r.role)).toEqual(['bot', 'team', 'skill']);
  });

  it('give the bot slug from its definition path, and nothing for anything else', () => {
    expect(botSlugOf(refs)).toBe('release-helper');
    expect(botSlugOf([{ role: 'team', path: 'TEAM.md' }])).toBeNull();
    expect(botSlugOf([{ role: 'bot', path: 'bots/a/b/BOT.md' }])).toBeNull();
  });
});

describe('reading a conversation again', () => {
  it('stops for any 4xx that repeating cannot fix, and keeps trying after a slow answer or a server error', () => {
    for (const status of [400, 401, 403, 404, 409, 410]) expect(stopsPolling(status)).toBe(true);
    for (const status of [408, 429, 500, 502, 503]) expect(stopsPolling(status)).toBe(false);
  });
});

describe('what a screen reader is told', () => {
  it('has a line for each step the page changes to, with the number of questions', () => {
    expect(announcement('asking', { questions: [{}, {}] as never })).toBe('2 questions for you. Answer every one, then send.');
    expect(announcement('asking', { questions: [{}] as never })).toBe('1 question for you. Answer every one, then send.');
    for (const step of ['working', 'proposed', 'failed', 'cancelled'] as const) expect(announcement(step, null)).not.toBe('');
    expect(announcement('brief', null)).toBe('');
  });
  it('moves focus to a heading for every step that has one of its own', () => {
    expect(FOCUS_ID.working).toBe('su-work-h');
    expect(FOCUS_ID.asking).toBe('su-q-h');
    expect(FOCUS_ID.failed).toBe(FOCUS_ID.cancelled);
  });
});

describe('plain words for what the helper found', () => {
  it('name every trigger, safety setting and tool without internal terms', () => {
    for (const t of ['conversation', 'mention', 'channel_message', 'task_assigned', 'routine', 'inbox', 'webhook']) expect(TRIGGER_WORDS[t]).toBeTruthy();
    for (const g of ['standard', 'customer-facing', 'strict-egress', 'air-gapped']) expect(GUARD_WORDS[g]).toBeTruthy();
    for (const r of ['shell', 'files', 'browser']) expect(RUNTIME_WORDS[r]).toBeTruthy();
    for (const w of [...Object.values(TRIGGER_WORDS), ...Object.values(GUARD_WORDS), ...Object.values(RUNTIME_WORDS)]) expect(w).not.toMatch(/channel_message|egress|BOT\.md/);
  });
});
