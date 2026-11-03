import { GRADES, isGap, type GradedRequirement, type SetupRequirement } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { gapsOf, gradeAll, gradeRequirement, limitsOf, mergeGraded, questionProblem, questionsForGaps } from '../src/grade.ts';
import { looksInternal, plainify } from '../src/labels.ts';
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
  it('a connection is missing: the helper cannot give a bot one', () => expect(grade(req('connection', 'mailbox'))).toBe('missing'));
  it('a connection the inventory does list is covered', () => expect(grade(req('connection', 'mailbox'), inventory({ connections: [{ name: 'mailbox', tools: ['email.send'] }] }))).toBe('covered'));
  it('a runner the team may use is covered; any other is blocked in words that say nothing about it', () => {
    expect(grade(req('runner', 'fast-model'))).toBe('covered');
    const other = gradeRequirement(req('runner', 'secret-gpu-box'), inventory());
    expect(other.grade).toBe('blocked');
    expect(other.reason).toBe('"secret-gpu-box" is not a runner this team may use.');
    expect(grade(req('runner'))).toBe('covered');
  });
  it('a way to start the bot: the five are covered, inbox and webhook are missing (they need a connection), drop is blocked (the Archivist owns it), others are unclear', () => {
    for (const t of ['conversation', 'mention', 'channel_message', 'task_assigned', 'routine']) expect(grade(req('trigger', t)), t).toBe('covered');
    expect(grade(req('trigger', 'inbox'))).toBe('missing');
    expect(grade(req('trigger', 'webhook'))).toBe('missing');
    expect(grade(req('trigger', 'drop'))).toBe('blocked');
    expect(gradeRequirement(req('trigger', 'drop'), inventory()).reason).toBe('The team Archivist starts from drops.');
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
    expect(questions[1]!.question).toContain('This team has not allowed bots to use a shell');
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

describe('the words a person reads', () => {
  const inv = inventory();
  const all: SetupRequirement[] = [
    req('capability', 'messages.post'),
    req('capability', 'email.send'),
    req('capability', 'telepathy.read'),
    req('runtime', 'shell'),
    req('trigger', 'channel_message'),
    req('trigger', 'inbox'),
    req('model', 'smart-and-slow'),
    { id: 'o', text: 'Reply in the PR channel using messages.post when a channel_message arrives', kind: 'other', name: 'no-write-access' },
  ];
  const graded = gradeAll(all.map((r) => (r.kind === 'other' ? r : { ...r, text: 'Something the brief asked for' })), inv);

  it('never show an internal tool, trigger or requirement id in a reason', () => {
    for (const g of graded) {
      expect(looksInternal(g.reason), g.reason).toBe(false);
      expect(g.reason).not.toMatch(/"(?:messages\.post|channel_message|no-write-access|guard-team-only)"/);
    }
  });
  it('say the other kind of need in the helper\'s sentence, never by the name it picked', () => {
    const other = graded.find((g) => g.id === 'r1' && g.kind === 'other') ?? graded.at(-1)!;
    expect(other.reason).toContain('post messages');
    expect(other.reason).toContain('a new message appears in a channel');
    expect(other.reason).not.toContain('no-write-access');
  });
  it('spell out a name the table does not know instead of showing it as an id', () => {
    expect(plainify('needs messages.post')).toBe('needs post messages');
  });
  it('are in the limits and the platform\'s own questions too', () => {
    for (const line of limitsOf(graded)) expect(looksInternal(line.replace(/\(.*\)$/, '')), line).toBe(false);
    for (const q of questionsForGaps(graded, new Map(), 0)) {
      expect(q.question).toContain('?');
      expect(q.options.length).toBeGreaterThan(0);
    }
  });
});

describe('a question the helper worded', () => {
  it('is refused when it has no question mark, no choice, or an internal name; accepted otherwise', () => {
    expect(questionProblem('Watch the mailbox', { question: 'No write access to the mailbox, so it stays out.', options: ['Yes'] })).toMatch(/question mark/);
    expect(questionProblem('Watch the mailbox', { question: 'Which mailbox?', options: [] })).toMatch(/choices/);
    expect(questionProblem('Watch the mailbox', { question: 'Which mailbox?', options: [' ', 'x'.repeat(90)] })).toMatch(/choices/);
    expect(questionProblem('Watch the mailbox', { question: 'Should guard-team-only stay on?', options: ['Yes', 'No'] })).toMatch(/internal name/);
    expect(questionProblem('Watch the mailbox', { question: 'Should it use messages.post?', options: ['Yes', 'No'] })).toMatch(/internal name/);
    expect(questionProblem('Watch the mailbox', { question: 'Which mailbox should it read?', options: ['Support', 'Sales'] })).toBeNull();
  });
  it('is replaced by the platform\'s own question, which always has choices, when it is unusable', () => {
    const g = gradeAll([req('connection', 'mailbox', 'mail')], inventory());
    const [q] = questionsForGaps(g, new Map([['mail', { question: 'The mailbox requirement: no-write-access', options: [] }]]), 0);
    expect(q!.question).toContain('?');
    expect(q!.options.length).toBeGreaterThan(0);
    expect(looksInternal(q!.question)).toBe(false);
  });
});

describe('a gap the person answered', () => {
  const graded = gradeAll([req('connection', 'mailbox', 'mail'), req('other', undefined, 'tone'), req('runtime', 'shell', 'sh')], inventory());
  const answer = (requirementId: string, text: string, questionId = 'q1') => ({ questionId, requirementId, question: 'Q?', answer: text });

  it('reads "You decided" in their words; the grade does not change', () => {
    const limits = limitsOf(graded, [answer('mail', 'Skip email, mention only')]);
    expect(limits[0]).toMatch(/^You decided: Skip email, mention only \(/);
    expect(limits[1]).toMatch(/^Not settled/);
    expect(limits[2]).toMatch(/^Not allowed/);
    expect(gapsOf(graded)).toHaveLength(3);
  });
  it('stays Not settled when nothing was recorded, and an empty answer is no answer', () => {
    expect(limitsOf(graded).every((l) => !l.startsWith('You decided'))).toBe(true);
    expect(limitsOf(graded, [answer('mail', '   ')])[0]).toMatch(/^Not available yet/);
  });
  it('is not decided by the model: only a recorded answer for that requirement counts, so a gap re-listed under a new id stays open', () => {
    // the helper lists the mailbox again under a fresh id after the answer was recorded for `mail`
    const merged = mergeGraded(graded, gradeAll([{ id: 'mail', text: 'Watch the mailbox', kind: 'connection', name: 'other-mailbox' }], inventory()));
    const relisted = merged.find((r) => r.name === 'other-mailbox')!;
    expect(relisted.id).not.toBe('mail');
    const limits = limitsOf(merged, [answer('mail', 'Skip email')]);
    expect(limits.filter((l) => l.startsWith('You decided'))).toHaveLength(1);
    expect(limits.filter((l) => l.startsWith('Not available yet'))).toHaveLength(1);
    // an answer that names a requirement that is not a gap (or does not exist) changes nothing
    expect(limitsOf(graded, [answer('nothing', 'ok'), answer('covered-one', 'ok')]).every((l) => !l.startsWith('You decided'))).toBe(true);
  });
  it('uses the latest answer when a question was answered in two rounds', () => {
    expect(limitsOf(graded, [answer('mail', 'First', 'q1'), answer('mail', 'Second', 'q4')])[0]).toMatch(/^You decided: Second/);
  });
});
