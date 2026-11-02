import { GRADES, isGap, type GradedRequirement, type SetupRequirement } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { gapsOf, gradeAll, gradeRequirement, limitsOf, mergeGraded, questionsForGaps } from '../src/grade.ts';
import { admin, inventory, member } from './fixtures.ts';

// P7-03: the grade of each requirement is the platform's, a function of the requirement and the inventory. These cover every kind and every grade.

const req = (kind: SetupRequirement['kind'], name?: string, id = 'r1'): SetupRequirement => ({ id, text: `needs ${name ?? kind}`, kind, ...(name ? { name } : {}) });
const grade = (r: SetupRequirement, inv = inventory()) => gradeRequirement(r, inv).grade;

describe('the grades', () => {
  it('are the five of the plan, and missing, blocked and unclear are the gaps', () => {
    expect([...GRADES]).toEqual(['covered', 'grantable', 'missing', 'blocked', 'unclear']);
    expect(GRADES.filter(isGap)).toEqual(['missing', 'blocked', 'unclear']);
  });
});

describe('capability', () => {
  it('is covered for a tool that cannot change things', () => expect(grade(req('capability', 'knowledge.search'))).toBe('covered'));
  it('is grantable for a tool that can change things when the asker is a lead', () => expect(grade(req('capability', 'email.send'))).toBe('grantable'));
  it('is grantable for an admin too', () => expect(grade(req('capability', 'email.send'), inventory({ asker: admin }))).toBe('grantable'));
  it('is blocked for a member: a person never grants more than they may grant themselves', () => expect(grade(req('capability', 'email.send'), inventory({ asker: member }))).toBe('blocked'));
  it('is unclear for a tool that does not exist, and when no tool is named', () => {
    expect(grade(req('capability', 'telepathy.read'))).toBe('unclear');
    expect(grade(req('capability'))).toBe('unclear');
  });
});

describe('runtime (shell, files, browser)', () => {
  it('is grantable when the team allows it and the asker may grant', () => expect(grade(req('runtime', 'files'))).toBe('grantable'));
  it('is blocked when the team has not allowed it, even for an admin', () => {
    expect(grade(req('runtime', 'shell'))).toBe('blocked');
    expect(grade(req('runtime', 'shell'), inventory({ asker: admin }))).toBe('blocked');
  });
  it('is blocked for a member even when the team allows it', () => expect(grade(req('runtime', 'files'), inventory({ asker: member }))).toBe('blocked'));
  it('is unclear when it is not said which', () => expect(grade(req('runtime'))).toBe('unclear'));
});

describe('knowledge, skill, connection, runner, trigger, model, other', () => {
  it('a knowledge base the team has is covered, one it lacks is missing', () => {
    expect(grade(req('knowledge', 'manuals'))).toBe('covered');
    expect(grade(req('knowledge', 'contracts'))).toBe('missing');
    expect(grade(req('knowledge'))).toBe('unclear');
  });
  it('a skill the team has is covered, one it lacks is missing', () => {
    expect(grade(req('skill', 'review'))).toBe('covered');
    expect(grade(req('skill', 'triage'))).toBe('missing');
  });
  it('a connection is missing: none exist in this release', () => expect(grade(req('connection', 'mailbox'))).toBe('missing'));
  it('a connection the inventory does list is covered', () => expect(grade(req('connection', 'mailbox'), inventory({ connections: [{ name: 'mailbox', tools: ['email.send'] }] }))).toBe('covered'));
  it('a runner the team may use is covered; any other is blocked in words that say nothing about it', () => {
    expect(grade(req('runner', 'fast-model'))).toBe('covered');
    const other = gradeRequirement(req('runner', 'secret-gpu-box'), inventory());
    expect(other.grade).toBe('blocked');
    expect(other.reason).toBe('"secret-gpu-box" is not a runner this team may use.');
    expect(grade(req('runner'))).toBe('covered');
  });
  it('a way to start the bot: the five are covered, inbox and webhook are missing (they need a connection), others are unclear', () => {
    for (const t of ['conversation', 'mention', 'channel_message', 'task_assigned', 'routine']) expect(grade(req('trigger', t)), t).toBe('covered');
    expect(grade(req('trigger', 'inbox'))).toBe('missing');
    expect(grade(req('trigger', 'webhook'))).toBe('missing');
    expect(grade(req('trigger', 'carrier-pigeon'))).toBe('unclear');
  });
  it('a model alias that is bound is covered; one that is not is missing', () => {
    expect(grade(req('model', 'smart'))).toBe('covered');
    expect(grade(req('model', 'code'))).toBe('missing');
  });
  it('anything else is unclear: the person is asked', () => expect(grade(req('other'))).toBe('unclear'));
});

describe('a list', () => {
  const asked = [req('knowledge', 'manuals', 'kb'), req('connection', 'mailbox', 'mail'), req('runtime', 'shell', 'sh'), req('other', undefined, 'what')];

  it('is graded in order and nothing is dropped, even two entries with one id', () => {
    const graded = gradeAll([...asked, req('knowledge', 'contracts', 'kb')], inventory());
    expect(graded.map((g) => [g.id, g.grade])).toEqual([
      ['kb', 'covered'],
      ['mail', 'missing'],
      ['sh', 'blocked'],
      ['what', 'unclear'],
      ['kb', 'missing'],
    ]);
  });

  it('merges a new round into the earlier one by id', () => {
    const before = gradeAll(asked, inventory());
    const now = gradeAll([req('other', undefined, 'what'), req('skill', 'review', 'new')], inventory());
    const merged = mergeGraded(before, now);
    expect(merged.map((g) => g.id)).toEqual(['kb', 'mail', 'sh', 'what', 'new']);
    expect(gapsOf(merged).map((g) => g.id)).toEqual(['mail', 'sh', 'what']);
  });
});

describe('a later listing never loosens an earlier grade (P7-03)', () => {
  const before = gradeAll([req('connection', 'mailbox', 'mail'), req('runtime', 'shell', 'sh'), req('knowledge', 'manuals', 'kb')], inventory());

  it('keeps a gap as a gap even when the same thing would now grade as covered', () => {
    const merged = mergeGraded(before, gradeAll([req('runtime', 'shell', 'sh')], inventory({ runtimeAllowed: ['files', 'shell'] })));
    // blocked (not allowed) would become grantable in the new inventory, a looser grade: the stricter one stands
    expect(gradeAll([req('runtime', 'shell', 'sh')], inventory({ runtimeAllowed: ['files', 'shell'] }))[0]?.grade).toBe('grantable');
    expect(merged.find((r) => r.id === 'sh')?.grade).toBe('blocked');
  });

  it("does not let the same id with another kind or name take the old gap's place", () => {
    const merged = mergeGraded(before, gradeAll([req('other', 'nothing at all', 'mail'), req('knowledge', 'manuals', 'sh')], inventory()));
    // the old gaps are still there under their own ids
    expect(merged.find((r) => r.id === 'mail')).toMatchObject({ kind: 'connection', name: 'mailbox', grade: 'missing' });
    expect(merged.find((r) => r.id === 'sh')).toMatchObject({ kind: 'runtime', name: 'shell', grade: 'blocked' });
    // the new entries are added under fresh ids, each graded on its own
    expect(merged.filter((r) => r.id.startsWith('mail-')).map((r) => [r.kind, r.grade])).toEqual([['other', 'unclear']]);
    expect(merged.filter((r) => r.id.startsWith('sh-')).map((r) => [r.kind, r.grade])).toEqual([['knowledge', 'covered']]);
    expect(new Set(merged.map((r) => r.id)).size).toBe(merged.length);
    expect(gapsOf(merged).map((r) => r.id)).toEqual(expect.arrayContaining(['mail', 'sh']));
  });

  it('keeps the stricter grade: a gap is never turned into covered, a covered entry may become a gap', () => {
    const covered = gradeAll([req('model', 'code', 'm')], inventory({ models: [{ alias: 'code' }] }));
    const missing = gradeAll([req('model', 'code', 'm')], inventory({ models: [] }));
    expect(mergeGraded(covered, missing).map((r) => r.grade)).toEqual(['missing']);
    expect(mergeGraded(missing, covered).map((r) => r.grade)).toEqual(['missing']);
  });

  it('applies the same rules inside one listing (the same id twice, first a gap and then covered)', () => {
    const merged = mergeGraded([], gradeAll([req('connection', 'mailbox', 'x'), req('knowledge', 'manuals', 'x')], inventory()));
    expect(merged.map((r) => [r.kind, r.grade])).toEqual([
      ['connection', 'missing'],
      ['knowledge', 'covered'],
    ]);
    expect(new Set(merged.map((r) => r.id)).size).toBe(2);
  });

  it('does not change the lists it was given', () => {
    const copy = JSON.stringify(before);
    mergeGraded(before, gradeAll([req('other', 'x', 'mail')], inventory()));
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe('the questions', () => {
  const graded: GradedRequirement[] = gradeAll(
    [req('knowledge', 'manuals', 'ok'), req('connection', 'mailbox', 'mail'), req('runtime', 'shell', 'sh'), req('other', undefined, 'what'), req('skill', 'triage', 'sk')],
    inventory(),
  );

  it('are one for each gap and none for what is covered, in one batch', () => {
    const questions = questionsForGaps(gapsOf(graded), new Map(), 0);
    expect(questions.map((q) => q.requirementId)).toEqual(['mail', 'sh', 'what', 'sk']);
    expect(questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(questions.every((q) => q.question.length > 0 && q.options.length <= 4)).toBe(true);
  });

  it('use the helper\'s wording when it gave some, and the platform\'s own otherwise', () => {
    const questions = questionsForGaps(gapsOf(graded), new Map([['mail', { question: 'Which mailbox should it read?', options: ['Support', 'Sales', ' ', 'x'.repeat(100)] }]]), 0);
    expect(questions[0]).toMatchObject({ requirementId: 'mail', question: 'Which mailbox should it read?', options: ['Support', 'Sales'] });
    expect(questions[1]!.question).toContain('This team has not allowed bots to use shell');
  });

  it('continue the numbering of the rounds before', () => {
    expect(questionsForGaps(gapsOf(graded), new Map(), 4).map((q) => q.id)).toEqual(['q5', 'q6', 'q7', 'q8']);
  });

  it('offer to create a skill that is missing', () => {
    expect(questionsForGaps(gapsOf(graded), new Map(), 0).find((q) => q.requirementId === 'sk')!.options).toContain('Create a starter skill');
  });
});

describe('what the bot will not be able to do', () => {
  it('has a sentence for each gap and nothing for the rest', () => {
    const graded = gradeAll([req('knowledge', 'manuals', 'ok'), req('connection', 'mailbox', 'mail'), req('runtime', 'shell', 'sh')], inventory());
    const limits = limitsOf(graded);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatch(/^Not available yet: needs mailbox/);
    expect(limits[1]).toMatch(/^Not allowed: needs shell/);
  });
});
