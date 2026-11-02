import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import type { WorkshopEntry, WorkshopSession } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { endWorkshop, fetchWorkshop, listWorkshop, sayInWorkshop, startWorkshop } from '../src/screens/workshop/api';
import { announcement, asRule, charsLeft, lastReplyId, messagesLeft, modeInfo, modeOf, nextTab, textReady, usageLine, viewOf } from '../src/screens/workshop/model';
import { Compose, EarlierList, EntryView, ModeTabs, ViewTabs, viewPanelProps } from '../src/screens/workshop/parts';

// P7-05, P7-06: the Workshop tab against the mock transport (a scripted helper), the small rules of its model, and the markup of its parts.

const use = (as = 'omar') => setTransport(createMockTransport({ latencyMs: 0, as }));

/** Reads the conversation until it leaves "working" (the mock needs two reads for an answer). */
async function untilReady(slug: string, bot: string, id: string): Promise<WorkshopSession> {
  for (let i = 0; i < 10; i += 1) {
    const { session } = await fetchWorkshop(slug, bot, id);
    if (session.status !== 'working') return session;
  }
  throw new Error('still working');
}

describe('the flow, offline', () => {
  beforeEach(() => use());

  it('Rehearse: the write is held back and badged "not really done"; the answer is a test; the spend line says rehearsal', async () => {
    const { session } = await startWorkshop('engineering', 'brain', 'rehearse', 'Please tell #support what you found.');
    expect(session.status).toBe('working');
    const done = await untilReady('engineering', 'brain', session.id);
    const held = done.entries.filter((e) => e.kind === 'step' && e.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ badge: 'not really done' });
    expect(done.entries.find((e) => e.kind === 'reply')).toMatchObject({ rehearsal: true });
    expect(done.usage.label).toBe('rehearsal');
    expect(usageLine(done.usage)).toMatch(/Rehearsal spend/);
    expect(usageLine(done.usage)).toMatch(/counts toward the bot’s budget/);
  });

  it('Build: a correction (about a rehearsal reply) becomes a lesson and a test case, and "make that a rule" adds a rule; all are proposals', async () => {
    const rehearsal = await untilReady('engineering', 'brain', (await startWorkshop('engineering', 'brain', 'rehearse', 'Hello')).session.id);
    const reply = rehearsal.entries.find((e) => e.kind === 'reply') as Extract<WorkshopEntry, { kind: 'reply' }>;
    const build = (await startWorkshop('engineering', 'brain', 'build')).session;
    expect(build.status).toBe('ready');
    await sayInWorkshop('engineering', 'brain', build.id, 'That answer was wrong. Make that a rule: never promise a date.', { sessionId: rehearsal.id, entryId: reply.id });
    const done = await untilReady('engineering', 'brain', build.id);
    expect(done.entries.filter((e) => e.kind === 'proposal').map((e) => (e as { role: string }).role)).toEqual(['lessons', 'eval', 'rule']);
    // the files are the ones the server writes, for THIS bot
    expect(done.entries.filter((e) => e.kind === 'proposal').map((e) => (e as { path: string }).path)).toEqual(['bots/brain/lessons.md', 'bots/brain/evals/lessons.yaml', 'bots/brain/BOT.md']);
    expect(done.entries.find((e) => e.kind === 'person')).toBeDefined();
  });

  it('Build: a correction that is not about a rehearsal of this person is refused in words', async () => {
    const build = (await startWorkshop('engineering', 'brain', 'build')).session;
    await expect(
      sayInWorkshop('engineering', 'brain', build.id, 'That was wrong.', { sessionId: build.id, entryId: 'e1' }),
    ).rejects.toThrow(/not a reply of your rehearsal/);
  });

  it('Live: answers from the run records, read only', async () => {
    const { session } = await startWorkshop('engineering', 'brain', 'live', 'How has it been doing?');
    const done = await untilReady('engineering', 'brain', session.id);
    expect(done.entries.some((e) => e.kind === 'step' && e.outcome === 'held')).toBe(false);
    expect(done.entries.find((e) => e.kind === 'reply')).toMatchObject({ rehearsal: false });
    expect(done.usage.label).toBe('workshop');
  });

  it('refuses a message while it is answering, and after the conversation ended; lists the conversations of the bot, newest first', async () => {
    const { session } = await startWorkshop('engineering', 'brain', 'build', 'Hello there');
    await expect(sayInWorkshop('engineering', 'brain', session.id, 'Again')).rejects.toThrow(/still answering/);
    await untilReady('engineering', 'brain', session.id);
    const ended = await endWorkshop('engineering', 'brain', session.id);
    expect(ended.session.status).toBe('ended');
    await expect(sayInWorkshop('engineering', 'brain', session.id, 'More')).rejects.toThrow(/over/);
    const list = await listWorkshop('engineering', 'brain');
    expect(list.sessions[0]).toMatchObject({ id: session.id, status: 'ended', mode: 'build' });
    expect((await listWorkshop('engineering', 'other-bot')).sessions).toEqual([]);
  });

  it('says in one plain sentence when the helper cannot finish', async () => {
    const { session } = await startWorkshop('engineering', 'brain', 'build', 'This will fail on purpose.');
    const failed = await untilReady('engineering', 'brain', session.id);
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(/Start a new conversation/);
    expect(announcement(null, failed)).toBe(failed.message);
  });

  it('gives at most three open conversations at once, and keeps the fourth out in words', async () => {
    for (let i = 0; i < 3; i += 1) await startWorkshop('engineering', 'brain', 'build');
    await expect(startWorkshop('engineering', 'brain', 'build')).rejects.toThrow(/already have Workshop conversations open/);
  });
});

describe('a full conversation', () => {
  it('takes 30 messages and then says so in the server\u2019s words', async () => {
    use();
    const { session } = await startWorkshop('engineering', 'brain', 'build', 'First message');
    await untilReady('engineering', 'brain', session.id);
    for (let i = 1; i < 30; i += 1) {
      await sayInWorkshop('engineering', 'brain', session.id, `Message ${String(i)}`);
      await untilReady('engineering', 'brain', session.id);
    }
    await expect(sayInWorkshop('engineering', 'brain', session.id, 'One more')).rejects.toThrow('A conversation takes 30 messages. Start a new one.');
  });
});

describe('Rehearse is for a team lead or an admin', () => {
  it('a plain member is told so; Build and Live stay open to them', async () => {
    use('nadia');
    await expect(startWorkshop('engineering', 'brain', 'rehearse')).rejects.toThrow(/team lead or an admin/);
    expect((await startWorkshop('engineering', 'brain', 'build')).session.mode).toBe('build');
  });
});

describe('the rules of the model', () => {
  it('knows the three modes, in plain words, and falls back to Build for anything else', () => {
    expect(modeInfo('rehearse').lead).toMatch(/held back/);
    expect(modeInfo('live').hint).toMatch(/Read only/);
    expect(modeOf('live')).toBe('live');
    expect(modeOf('nonsense')).toBe('build');
    expect(modeOf(null)).toBe('build');
    expect(viewOf('workshop')).toBe('workshop');
    expect(viewOf('x')).toBe('chat');
  });
  it('checks a message: not empty, not too long; counts what is left', () => {
    expect(textReady('   ')).toBe(false);
    expect(textReady('Hello')).toBe(true);
    expect(textReady('x'.repeat(2001))).toBe(false);
    expect(charsLeft('x'.repeat(1990))).toBe(10);
  });
  it('turns a message into "make that a rule" once, in the person\'s own words', () => {
    expect(asRule('Never promise a date')).toBe('Make that a rule: Never promise a date');
    expect(asRule(asRule('Never promise a date'))).toBe('Make that a rule: Never promise a date');
    expect(asRule('x'.repeat(3000)).length).toBe(2000);
  });
  it('moves between tabs with the arrow keys, wrapping round, and Home and End', () => {
    expect(nextTab('ArrowRight', 2, 3)).toBe(0);
    expect(nextTab('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTab('Home', 2, 3)).toBe(0);
    expect(nextTab('End', 0, 3)).toBe(2);
    expect(nextTab('a', 0, 3)).toBeNull();
  });
  it('counts the messages left and finds the reply that can be corrected', () => {
    expect(messagesLeft({ messageCount: 28 })).toBe(2);
    expect(messagesLeft({ messageCount: 40 })).toBe(0);
    const entries: WorkshopEntry[] = [
      { id: 'e1', at: '2026-10-01T14:02:00.000Z', kind: 'reply', text: 'a', rehearsal: true },
      { id: 'e2', at: '2026-10-01T14:02:00.000Z', kind: 'notice', text: 'n' },
      { id: 'e3', at: '2026-10-01T14:02:00.000Z', kind: 'reply', text: 'b', rehearsal: true },
    ];
    expect(lastReplyId(entries)).toBe('e3');
    expect(lastReplyId([])).toBeNull();
  });
});

const NOW = '2026-10-01T14:02:00.000Z';
const page = (node: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, node));

describe('the markup', () => {
  it('a held write shows the "not really done" badge; a read does not', () => {
    const held = page(createElement(EntryView, { entry: { id: 'e1', at: NOW, kind: 'step', tool: 'messages.post', what: 'Post a message in #support', outcome: 'held', badge: 'not really done' }, slug: 'engineering' }));
    expect(held).toContain('not really done');
    expect(held).toContain('data-outcome="held"');
    const read = page(createElement(EntryView, { entry: { id: 'e2', at: NOW, kind: 'step', tool: 'knowledge.search', what: 'Search', outcome: 'read', badge: null }, slug: 'engineering' }));
    expect(read).not.toContain('not really done');
  });
  it('a rehearsal reply says it is a test and offers "Correct this reply"; a helper reply does not', () => {
    const reply = (rehearsal: boolean) => page(createElement(EntryView, { entry: { id: 'e1', at: NOW, kind: 'reply', text: 'Hello', rehearsal }, slug: 'engineering', onCorrect: () => undefined }));
    expect(reply(true)).toContain('a test answer, nothing was sent');
    expect(reply(true)).toContain('ws-correct');
    expect(reply(false)).not.toContain('ws-correct');
  });
  it('a proposal links to the Proposals screen, in plain words', () => {
    const out = page(createElement(EntryView, { entry: { id: 'e1', at: NOW, kind: 'proposal', proposalId: '00000000-0000-7000-8000-000000000001' as never, path: 'bots/x/lessons.md', role: 'lessons', title: 'Add a lesson' }, slug: 'engineering' }));
    expect(out).toContain('A lesson to remember');
    expect(out).toContain('href="/t/engineering/proposals/00000000-0000-7000-8000-000000000001"');
  });
  it('a row of tabs has one stop in the Tab order (the chosen tab), and says which is chosen', () => {
    const out = page(createElement(ModeTabs, { mode: 'rehearse', onChange: () => undefined, panelId: 'p' }));
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(out).toMatch(/aria-selected="true"[^>]*data-testid="ws-mode-rehearse"|data-testid="ws-mode-rehearse"[^>]*aria-selected="true"/);
    const views = page(createElement(ViewTabs, { view: 'workshop', onChange: () => undefined }));
    expect(views).toContain('Chat');
    expect(views).toContain('Workshop');
  });
  it('only the chosen tab names the panel it controls; the Chat | Workshop tabs have stable ids the panel is labelled by', () => {
    const views = page(createElement(ViewTabs, { view: 'workshop', onChange: () => undefined }));
    expect(views.match(/aria-controls="ws-view-panel"/g)).toHaveLength(1);
    expect(views).toMatch(/id="ws-view-tab-workshop"[^>]*aria-selected="true"[^>]*aria-controls="ws-view-panel"/);
    expect(views).toContain('id="ws-view-tab-chat"');
    expect(viewPanelProps('chat')).toEqual({ id: 'ws-view-panel', role: 'tabpanel', 'aria-labelledby': 'ws-view-tab-chat' });
    expect(viewPanelProps('workshop')['aria-labelledby']).toBe('ws-view-tab-workshop');
    const modes = page(createElement(ModeTabs, { mode: 'build', onChange: () => undefined, panelId: 'p' }));
    expect(modes.match(/aria-controls="p"/g)).toHaveLength(1);
  });
  it('a tab the person may not use stays on the row, says why in sight and to a screen reader, and chooses nothing', () => {
    const out = page(createElement(ModeTabs, { mode: 'build', onChange: () => undefined, panelId: 'p', rehearseReason: 'Only a team lead or an admin can rehearse a bot.' }));
    expect(out).toMatch(/data-testid="ws-mode-rehearse"/);
    expect(out).toContain('aria-disabled="true"');
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-describedby="[^"]+-rehearse-why"/);
    expect(out).toContain('data-testid="ws-mode-rehearse-why"');
    expect(out).toContain('Only a team lead or an admin can rehearse a bot.');
    // nothing is said when every mode is open to the person
    expect(page(createElement(ModeTabs, { mode: 'build', onChange: () => undefined, panelId: 'p' }))).not.toContain('aria-disabled');
  });
  it('the message box labels itself, shows the rule button only in Build, and says why sending is not possible', () => {
    const base = { text: 'hi', onText: () => undefined, onSend: () => undefined, busy: false, error: null, onRule: () => undefined, about: null, onDropAbout: () => undefined, ruleDisabled: false };
    const build = page(createElement(Compose, { ...base, mode: 'build', blocked: null, canRule: true }));
    expect(build).toContain('Make that a rule');
    expect(build).toContain('aria-disabled="false"');
    const rehearse = page(createElement(Compose, { ...base, mode: 'rehearse', blocked: 'The answer is on its way.', canRule: false }));
    expect(rehearse).not.toContain('Make that a rule');
    expect(rehearse).toContain('The answer is on its way.');
    expect(rehearse).toContain('aria-disabled="true"');
    const correcting = page(createElement(Compose, { ...base, mode: 'build', blocked: null, canRule: true, about: 'I would answer from the manuals' }));
    expect(correcting).toContain('Correcting: I would answer from the manuals');
  });
  it('the list of earlier conversations says how each stands, and an empty one says so', () => {
    const none = page(createElement(EarlierList, { items: [], current: null, onOpen: () => undefined }));
    expect(none).toContain('No conversations in this mode yet.');
    const some = page(createElement(EarlierList, { items: [{ id: '00000000-0000-7000-8000-00000000a001' as never, mode: 'build', status: 'ready', title: 'Fix the tone', messageCount: 2, updatedAt: NOW }], current: null, onOpen: () => undefined }));
    expect(some).toContain('Fix the tone');
    expect(some).toContain('open · 2 messages');
  });
});
