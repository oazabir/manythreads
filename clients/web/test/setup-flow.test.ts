import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { StaticRouter } from 'react-router';
import type { SetupSession } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { answerSetup, cancelSetup, fetchSetup, startSetup } from '../src/screens/setup/api';
import { fetchProposal, approveProposal } from '../src/screens/proposals/api';
import { BriefForm, Feasibility, InventoryPanel, Questions } from '../src/screens/setup/parts';

// P7-04: the "Add a bot" flow against the mock transport (a scripted helper), and the markup of its parts.

const use = (as = 'omar') => setTransport(createMockTransport({ latencyMs: 0, as }));
const BRIEF = 'A bot that answers questions from the manuals and reads the support mailbox.';

/** Reads the conversation until it leaves "working" (the mock needs two reads for each stage). */
async function untilQuiet(slug: string, id: string): Promise<SetupSession> {
  for (let i = 0; i < 10; i += 1) {
    const { session } = await fetchSetup(slug, id);
    if (session.status !== 'working') return session;
  }
  throw new Error('still working');
}

describe('the flow, offline', () => {
  beforeEach(() => use());

  it('works, finds what the team has, grades the brief and asks the open questions in one list', async () => {
    const { session } = await startSetup('engineering', BRIEF, 'Manual helper');
    expect(session.status).toBe('working');
    expect(session.name).toBe('Manual helper');
    const asking = await untilQuiet('engineering', session.id);
    expect(asking.status).toBe('asking');
    expect(asking.inventory?.team.slug).toBe('engineering');
    expect(asking.requirements.map((r) => r.grade)).toEqual(['covered', 'covered', 'missing', 'unclear']);
    expect(asking.questions.map((q) => q.requirementId)).toEqual(['mail', 'tone']);
  });

  it('wants every question answered, then proposes the bot as a diff that waits for Approve', async () => {
    const { session } = await startSetup('engineering', BRIEF);
    const asking = await untilQuiet('engineering', session.id);
    await expect(answerSetup('engineering', session.id, [{ questionId: 'q1', text: 'Skip email' }])).rejects.toThrow(/answer every question/);

    const back = await answerSetup('engineering', session.id, asking.questions.map((q) => ({ questionId: q.id, text: q.options[0] as string })));
    expect(back.session.status).toBe('working');
    expect(back.session.answers).toHaveLength(2);

    const proposed = await untilQuiet('engineering', session.id);
    expect(proposed.status).toBe('proposed');
    expect(proposed.proposals).toHaveLength(1);
    expect(proposed.limits.join(' ')).toMatch(/mailbox/);
    const filed = await fetchProposal('engineering', proposed.proposals[0]!.proposalId);
    expect(filed.proposal.proposal.status).toBe('open');
    expect(filed.proposal.proposal.diff).toContain('+name: Manual helper');
    expect(filed.proposal.canApply).toBe(true);

    const done = await approveProposal('engineering', proposed.proposals[0]!.proposalId);
    expect(done.proposal.proposal.status).toBe('applied');
  });

  it('refuses an answer when it is not waiting for one, and can be stopped', async () => {
    const { session } = await startSetup('engineering', BRIEF);
    await expect(answerSetup('engineering', session.id, [{ questionId: 'q1', text: 'x' }])).rejects.toThrow(/not waiting for answers/);
    const stopped = await cancelSetup('engineering', session.id);
    expect(stopped.session.status).toBe('cancelled');
  });

  it('says in one plain sentence when the helper cannot finish', async () => {
    const { session } = await startSetup('engineering', 'This brief will fail on purpose, thanks.');
    const failed = await untilQuiet('engineering', session.id);
    expect(failed.status).toBe('failed');
    expect(failed.message).toBe('The model did not answer. Try again in a minute.');
  });

  it('refuses a brief that is too short', async () => {
    // the request is checked before it is sent
    expect(() => startSetup('engineering', 'x')).toThrow(/sentence or two/);
  });
});

describe('who may approve', () => {
  it('a member sees the proposal but is told who approves it, and cannot', async () => {
    use('nadia');
    const { session } = await startSetup('engineering', BRIEF);
    const asking = await untilQuiet('engineering', session.id);
    await answerSetup('engineering', session.id, asking.questions.map((q) => ({ questionId: q.id, text: 'ok' })));
    const proposed = await untilQuiet('engineering', session.id);
    const id = proposed.proposals[0]!.proposalId;
    const detail = (await fetchProposal('engineering', id)).proposal;
    expect(detail.canApply).toBe(false);
    expect(detail.cannotApplyReason).toMatch(/admin/);
    await expect(approveProposal('engineering', id)).rejects.toThrow(/admin/);
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(StaticRouter, { location: '/t/engineering/bots/new' }, el));

describe('the parts', () => {
  const noop = () => undefined;

  it('the brief form is labelled, and the way to configure by hand is a link', () => {
    const out = html(createElement(BriefForm, { slug: 'engineering', busy: false, error: null, onStart: noop }));
    expect(out).toContain('What should this bot do?');
    expect(out).toContain('Let it explore');
    expect(out).toContain('href="/t/engineering/files?path=bots"');
    expect(out).toContain('What happens next');
    expect(out).toContain('What it cannot do');
    // the start button is off until there is a brief
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-testid="setup-start"/);
  });

  it('the feasibility list shows each grade as words, not only colour', () => {
    const out = html(
      createElement(Feasibility, {
        requirements: [
          { id: 'a', text: 'Answer from the manuals', kind: 'knowledge', grade: 'covered', reason: 'The team has it.' },
          { id: 'b', text: 'Read the mailbox', kind: 'connection', grade: 'missing', reason: 'No such connection.' },
        ],
      }),
    );
    expect(out).toContain('Covered');
    expect(out).toContain('Missing');
    expect(out).toContain('2 things asked for · 1 open');
  });

  it('the questions are numbered, offer options as toggle buttons and hold back "Send answers" until all are answered', () => {
    const questions = [
      { id: 'q1', requirementId: 'mail', question: 'What about the mailbox?', options: ['Skip it', 'Add it first'] },
      { id: 'q2', requirementId: 'tone', question: 'How long?', options: [] },
    ];
    const props = { questions, busy: false, error: null, onChange: noop, onSend: noop };
    const none = html(createElement(Questions, { ...props, draft: {} }));
    expect(none).toContain('1. What about the mailbox?');
    expect(none).toContain('2. How long?');
    expect(none).toContain('0 of 2 answered');
    expect(none).toContain('aria-pressed="false"');
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*data-testid="setup-send"/);
    const all = html(createElement(Questions, { ...props, draft: { q1: 'Skip it', q2: 'Short' } }));
    expect(all).toContain('2 of 2 answered');
    expect(all).toContain('aria-pressed="true"');
    expect(all).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="setup-send"/);
  });

  it('the inventory shows names only, and says when there is nothing', () => {
    const inv = {
      team: { slug: 'engineering', name: 'Engineering' },
      asker: { role: 'member', canGrantDestructive: false, canAddBot: false },
      bots: [], knowledge: [{ slug: 'manuals', name: 'Manuals' }], skills: [], runners: [], models: [{ alias: 'smart' }], channels: [{ name: 'dev' }], roleTags: [],
      capabilities: [], triggers: [{ type: 'mention', available: true }, { type: 'inbox', available: false }],
      runtimeAllowed: [], guardDefault: 'standard', connections: [], connectionsNote: 'No connections exist in this release.',
    } as const;
    const out = html(createElement(InventoryPanel, { inv: inv as never }));
    expect(out).toContain('What Engineering has');
    expect(out).toContain('Manuals');
    expect(out).toContain('#dev');
    expect(out).toContain('none this team may use');
    expect(out).toContain('not allowed for bots in this team');
    expect(out).toContain('No connections exist in this release.');
    expect(out).toContain('you cannot switch on tools that change things');
    // an inbox trigger is not listed as available
    expect(out).not.toContain('inbox');
  });
});
