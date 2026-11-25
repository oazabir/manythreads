import type { RunActivityItem, RunCounts, RunHead, RunNow } from '@manythreads/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { placeRuns } from '../src/channels/run-card/place';
import { RowView } from '../src/channels/run-card/StepList';
import { buildRows, foldRows, helpersToHide, type Row, type StepRow } from '../src/channels/run-card/steps';
import { forgetShownQuestions, leaveHandoff, setShownQuestions, shownNow, takeHandoff } from '../src/channels/run-card/shownQuestions';
import { commandOf, elapsedText, endLine, nowLine, planLine, previewLines, runElapsedMs, showsEndLine, stateWord, toolPhrase, workParts } from '../src/channels/run-card/words';
import { barLine, currentItem, foldDone, isOpen, progressText, todoProgress } from '../src/channels/todo-card/words';

// The words of the run card and the to-do card (P25-11): plain language, never a raw tool name, a long path or JSON; and where each run's line sits in a thread.

const counts = (over: Partial<RunCounts> = {}): RunCounts => ({ steps: 0, failed: 0, commands: 0, filesChanged: 0, added: 0, removed: 0, helpers: 0, thinkingSeconds: 0, omitted: 0, ...over });
const now = (over: Partial<RunNow> = {}): RunNow => ({ kind: 'read', title: null, paths: [], helper: null, count: 1, ...over });
const head = (over: Partial<Record<keyof RunHead, unknown>> = {}): RunHead =>
  ({
    runId: 'r1',
    botId: 'b1',
    botActorId: 'a1',
    botName: 'Coder',
    channelId: 'c1',
    threadRootId: 'm0',
    askerActorId: null,
    conversation: false,
    startedAt: '2026-11-14T10:00:00.000Z',
    endedAt: null,
    stopReason: null,
    cost: null,
    canStop: true,
    state: 'working',
    now: null,
    counts: counts(),
    plan: { done: 0, total: 0, current: null },
    planVersion: 0,
    helpers: [],
    seq: -1,
    stoppedBy: null,
    ...over,
  }) as unknown as RunHead;

describe('words of the run card', () => {
  it('names the state in plain words, and who a waiting run waits for', () => {
    expect(stateWord('working')).toBe('Working');
    expect(stateWord('waiting', { viewerCanAnswer: true, waitingFor: null })).toBe('Waiting for you');
    expect(stateWord('waiting', { viewerCanAnswer: false, waitingFor: 'Omar' })).toBe('Waiting for Omar');
    expect(stateWord('waiting')).toBe('Waiting for an answer');
  });

  it('says what it is doing now without a raw path or tool name', () => {
    expect(nowLine(now({ paths: ['/srv/app/clients/web/src/ThreadPanel.tsx'] }), 'working').text).toBe('Reading ThreadPanel.tsx');
    expect(nowLine(now({ kind: 'read', count: 4 }), 'working').text).toBe('Reading 4 files');
    expect(nowLine(now({ kind: 'execute', title: 'pnpm test' }), 'working')).toMatchObject({ text: 'Running', code: 'pnpm test' });
    expect(nowLine(now({ kind: 'search' }), 'working').text).toBe('Searching the code');
    expect(nowLine(null, 'starting').text).toBe('Getting ready');
  });

  it('marks a helper step', () => {
    const l = nowLine(now({ kind: 'edit', paths: ['a/b/Card.tsx'], helper: 'Reviewer' }), 'working');
    expect(l.text).toBe('Helper: editing Card.tsx');
    expect(l.helper).toBe('Reviewer');
  });

  it('counts the work in words a person can read', () => {
    expect(workParts(counts())).toEqual([]);
    expect(workParts(counts({ steps: 14, filesChanged: 2, added: 48, removed: 6, commands: 3, helpers: 2, failed: 1 }))).toEqual(['14 steps', '2 files changed (+48 −6)', '2 helpers', '1 step failed']);
    expect(workParts(counts({ steps: 3, commands: 3 }))).toEqual(['3 steps', '3 commands']);
    expect(workParts(counts({ steps: 1, helpers: 1 }))).toEqual(['1 step', '1 helper']);
  });

  it('formats time', () => {
    expect(elapsedText(45_000)).toBe('45 s');
    expect(elapsedText(4 * 60_000 + 10_000)).toBe('4 min');
    expect(elapsedText(65 * 60_000)).toBe('1 h 5 min');
    expect(runElapsedMs({ startedAt: '2026-11-14T10:00:00.000Z', endedAt: null }, Date.parse('2026-11-14T10:00:30.000Z'))).toBe(30_000);
  });

  it('folds the plan to its current item', () => {
    expect(planLine({ done: 0, total: 0, current: null })).toBeNull();
    expect(planLine({ done: 2, total: 5, current: 'Write the test' })).toEqual({ done: 2, total: 5, current: 'Write the test' });
  });

  it('says how a run ended, and who stopped it', () => {
    const done = head({ state: 'done', endedAt: '2026-11-14T10:04:00.000Z', counts: counts({ steps: 14, helpers: 2 }) });
    expect(endLine(done, 0)).toEqual({ lead: 'Worked 4 min', parts: ['14 steps', '2 helpers'], tone: 'done' });
    expect(endLine(head({ state: 'stopped', stoppedBy: 'Omar', endedAt: '2026-11-14T10:02:00.000Z' }), 0).lead).toBe('Stopped by Omar after 2 min');
    expect(endLine(head({ state: 'failed', endedAt: '2026-11-14T10:00:40.000Z' }), 0).lead).toBe('Failed after 40 s');
  });

  it('draws no end line for a quick run that did nothing, always for a stopped or failed one', () => {
    expect(showsEndLine(head({ state: 'done' }))).toBe(false);
    expect(showsEndLine(head({ state: 'done', counts: counts({ steps: 1 }) }))).toBe(true);
    expect(showsEndLine(head({ state: 'stopped' }))).toBe(true);
    expect(showsEndLine(head({ state: 'failed' }))).toBe(true);
  });

  it('keeps the last two lines of the answer, as plain text', () => {
    expect(previewLines('# Title\n\n- one\n- **two**\n3. last')).toEqual(['two', 'last']);
  });
});

const tool = (seq: number, stepId: string, stepKind: string, extra: Record<string, unknown> = {}): RunActivityItem => ({ seq, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'tool', stepId, stepKind, ...extra } }) as RunActivityItem;
const result = (seq: number, stepId: string, ok = true, extra: Record<string, unknown> = {}): RunActivityItem => ({ seq, at: '2026-11-14T10:00:01.000Z', payload: { kind: 'tool_result', stepId, ok, ...extra } }) as RunActivityItem;

describe('steps of a run', () => {
  it('folds steps of one kind that went well', () => {
    const lines = [1, 2, 3, 4].flatMap((n) => [tool(n * 2, `s${n}`, 'read', { paths: [`f${n}.ts`] }), result(n * 2 + 1, `s${n}`)]);
    const rows = buildRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'group', text: 'Read 4 files' });
  });

  it('never folds a step that is still going or failed', () => {
    const lines = [tool(0, 'a', 'read'), result(1, 'a'), tool(2, 'b', 'read'), result(3, 'b', false), tool(4, 'c', 'read'), result(5, 'c'), tool(6, 'd', 'read')];
    const rows = buildRows(lines);
    expect(rows.map((r) => r.type)).toEqual(['step', 'step', 'step', 'step']);
    expect((rows[1] as StepRow).status).toBe('failed');
    expect((rows[3] as StepRow).status).toBe('working');
  });

  it('puts a helper\'s steps inside the helper, with its own status', () => {
    const lines = [
      tool(0, 'agent1', 'other', { title: 'Agent' }),
      { seq: 1, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'agent', agentId: 'agent1', name: 'Reviewer', status: 'working', steps: 1 } } as RunActivityItem,
      tool(2, 's1', 'read', { parentStepId: 'agent1', paths: ['x.ts'] }),
      result(3, 's1'),
    ];
    const rows = buildRows(lines);
    expect(rows).toHaveLength(1);
    const helper = rows[0] as Extract<Row, { type: 'helper' }>;
    expect(helper).toMatchObject({ type: 'helper', name: 'Reviewer', status: 'working', stepCount: 1 });
    expect(helper.rows).toHaveLength(1);
  });

  it('shows thinking as a time, with no text, and a question with its answer', () => {
    const rows = buildRows([
      { seq: 0, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'thinking', seconds: 12 } } as RunActivityItem,
      { seq: 1, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'approval', outcome: 'asked', stepId: 'q1', title: 'Run the tests' } } as RunActivityItem,
      { seq: 2, at: '2026-11-14T10:00:05.000Z', payload: { kind: 'approval', outcome: 'approved', stepId: 'q1', title: 'Run the tests' } } as RunActivityItem,
    ]);
    expect(rows).toMatchObject([{ type: 'thinking', seconds: 12 }, { type: 'question', outcome: 'approved', text: 'Run the tests' }]);
  });

  it('says "out of memory" on a command that was stopped for memory (P31-04), and only on a failed step', () => {
    const rows = buildRows([
      tool(0, 'a', 'execute', { title: 'pnpm typecheck' }),
      result(1, 'a', false, { reason: 'out_of_memory' }),
      tool(2, 'b', 'execute', { title: 'pnpm test' }),
      result(3, 'b', false),
      tool(4, 'c', 'execute', { title: 'ls' }),
      result(5, 'c', true, { reason: 'out_of_memory' }),
    ]) as StepRow[];
    expect(rows.map((r) => [r.status, r.outOfMemory])).toEqual([['failed', true], ['failed', undefined], ['done', undefined]]);
    expect(rows[0]).toMatchObject({ text: 'Ran', code: 'pnpm typecheck' });
    // the card says it on the step's own line, where "Failed" would be
    const draw = (row: StepRow): string => renderToStaticMarkup(createElement(RowView, { row, defaultOpen: false }));
    expect(draw(rows[0]!)).toContain('<span>Out of memory</span>');
    expect(draw(rows[0]!)).not.toContain('<span>Failed</span>');
    expect(draw(rows[1]!)).toContain('<span>Failed</span>');
  });

  it('foldRows leaves a short run of steps alone', () => {
    const one: StepRow = { type: 'step', id: 'a', kind: 'read', text: 'Read a', code: null, files: [], status: 'done', seconds: null, diff: null };
    expect(foldRows([one, { ...one, id: 'b' }])).toHaveLength(2);
  });
});

describe('where each run sits in the thread', () => {
  const msg = (id: string, at: string, meta: Record<string, unknown> = {}) => ({ id, createdAt: at, meta }) as Parameters<typeof placeRuns>[0][number];
  it('puts a live run at the bottom and an ended one under its own answer', () => {
    const items = [msg('m1', '2026-11-14T10:00:10.000Z', { runId: 'r1' }), msg('m2', '2026-11-14T10:05:00.000Z')];
    const placed = placeRuns(items, [head({ runId: 'r1', state: 'done', endedAt: '2026-11-14T10:00:10.000Z' }), head({ runId: 'r2', state: 'working', startedAt: '2026-11-14T10:06:00.000Z' })]);
    expect(placed.live.map((r) => r.runId)).toEqual(['r2']);
    expect(placed.after.get('m1')?.map((r) => r.runId)).toEqual(['r1']);
  });

  it('notes a run that left a failure notice, and anchors a run with no message by time', () => {
    const items = [msg('m1', '2026-11-14T10:00:05.000Z'), msg('m2', '2026-11-14T10:00:30.000Z', { runId: 'r3', runFailure: 'runner_offline' })];
    const placed = placeRuns(items, [head({ runId: 'r3', state: 'failed', endedAt: '2026-11-14T10:00:30.000Z' }), head({ runId: 'r4', state: 'stopped', endedAt: '2026-11-14T10:00:08.000Z' }), head({ runId: 'r5', state: 'stopped', endedAt: '2026-11-14T09:59:00.000Z' })]);
    expect(placed.noticed.has('r3')).toBe(true);
    expect(placed.after.get('m1')?.map((r) => r.runId)).toEqual(['r4']);
    expect(placed.atRoot.map((r) => r.runId)).toEqual(['r5']);
  });
});

describe('words of the to-do card', () => {
  const items = [
    { id: 'a', text: 'Plan it', status: 'done' as const },
    { id: 'b', text: 'Build it', status: 'working' as const },
    { id: 'c', text: 'Check it', status: 'blocked' as const },
    { id: 'd', text: 'Ship it', status: 'waiting' as const },
  ];
  it('counts progress and says it', () => {
    const p = todoProgress(items);
    expect(p).toMatchObject({ done: 1, total: 4, allDone: false, blocked: 1, working: 1 });
    expect(progressText(p)).toBe('1 of 4');
    expect(progressText(todoProgress([{ status: 'done' }, { status: 'done' }]))).toBe('All done');
    expect(todoProgress([]).allDone).toBe(false);
  });

  it('shows the item being worked on, else a blocked one, else the next', () => {
    expect(currentItem(items)?.id).toBe('b');
    expect(currentItem(items.filter((i) => i.id !== 'b'))?.id).toBe('c');
    expect(currentItem([{ id: 'x', text: 'x', status: 'done' }])).toBeNull();
  });

  it('pins only while something is open', () => {
    expect(isOpen(items)).toBe(true);
    expect(isOpen([{ status: 'done' }])).toBe(false);
    expect(isOpen([])).toBe(false);
  });

  it('writes the bar line', () => {
    const todo = { title: '', items } as Parameters<typeof barLine>[0];
    expect(barLine(todo)).toEqual({ text: 'Working on Build it', progress: '1 of 4', tone: 'working' });
  });
});

describe('polish of the run card (P25-11 review)', () => {
  const rowsOf = (helpers: Array<[string, 'working' | 'done' | 'failed']>): Row[] => helpers.map(([id, status]) => ({ type: 'helper', id, name: id, status, stepCount: 1, rows: [] }));

  it('says a command once: "Running" and the program, never "Running a command Running pnpm"', () => {
    expect(nowLine(now({ kind: 'execute', title: 'Running pnpm' }), 'working')).toMatchObject({ text: 'Running', code: 'pnpm' });
    expect(nowLine(now({ kind: 'execute', title: 'Running a command' }), 'working')).toMatchObject({ text: 'Running a command', code: null });
    expect(nowLine(now({ kind: 'execute', title: null }), 'working')).toMatchObject({ text: 'Running a command', code: null });
    expect(commandOf('Terminal')).toBeNull();
  });

  it('does not repeat the state word on the now line', () => {
    expect(nowLine(null, 'working').text).toBe('Thinking');
  });

  it('a finished command reads "Ran" and the program; a question and its answer are one row, even when the answer names no step', () => {
    const rows = buildRows([
      tool(0, 'c1', 'execute', { title: 'Running pnpm' }),
      result(1, 'c1', true, { seconds: 6 }),
      { seq: 2, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'approval', outcome: 'asked', stepId: 'p1', stepKind: 'execute', title: 'Running pnpm' } } as RunActivityItem,
      { seq: 3, at: '2026-11-14T10:00:05.000Z', payload: { kind: 'approval', outcome: 'approved' } } as RunActivityItem,
    ]);
    expect(rows[0]).toMatchObject({ type: 'step', text: 'Ran', code: 'pnpm' });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'question', outcome: 'approved', text: 'Run', code: 'pnpm' });
  });

  it('a step that asked first says the answer on its own line', () => {
    const rows = buildRows([
      tool(0, 'c1', 'execute', { title: 'Running pnpm' }),
      { seq: 1, at: '2026-11-14T10:00:00.000Z', payload: { kind: 'approval', outcome: 'asked', stepId: 'c1', stepKind: 'execute', title: 'Running pnpm' } } as RunActivityItem,
      { seq: 2, at: '2026-11-14T10:00:05.000Z', payload: { kind: 'approval', outcome: 'approved' } } as RunActivityItem,
      result(3, 'c1', true, { seconds: 3 }),
    ]);
    expect(rows).toEqual([expect.objectContaining({ type: 'step', text: 'Ran', code: 'pnpm', answer: 'approved' })]);
  });

  it('never folds steps of the kind "other": each has its own title', () => {
    const lines = [1, 2, 3].flatMap((n) => [tool(n * 2, `o${n}`, 'other', { title: `Handed card ${n}` }), result(n * 2 + 1, `o${n}`)]);
    expect(buildRows(lines).map((r) => r.type)).toEqual(['step', 'step', 'step']);
  });

  it('folds the oldest finished helpers beyond three, never one that is working or failed', () => {
    const hidden = helpersToHide(rowsOf([['a', 'done'], ['b', 'done'], ['c', 'failed'], ['d', 'done'], ['e', 'done'], ['f', 'working']]));
    expect([...hidden].sort()).toEqual(['a', 'b', 'd']);
    expect(helpersToHide(rowsOf([['a', 'done'], ['b', 'done'], ['c', 'done']])).size).toBe(0);
    expect(helpersToHide(rowsOf([['a', 'working'], ['b', 'working'], ['c', 'working'], ['d', 'working']])).size).toBe(0);
  });

  it('never says "Worked 0 s" while the server has not said when the run ended', () => {
    const ended = head({ state: 'done', endedAt: null, counts: counts({ steps: 2 }) });
    expect(endLine(ended, Date.parse('2026-11-14T10:01:30.000Z')).lead).toBe('Worked 1 min');
  });

  it('keeps the folded line short: no commands and no line counts; a stopped run lists no failure', () => {
    const c = counts({ steps: 8, filesChanged: 1, added: 1, commands: 1, helpers: 1, failed: 1 });
    expect(endLine(head({ state: 'done', endedAt: '2026-11-14T10:00:10.000Z', counts: c }), 0).parts).toEqual(['8 steps', '1 file changed', '1 helper', '1 step failed']);
    expect(endLine(head({ state: 'stopped', endedAt: '2026-11-14T10:00:10.000Z', counts: c }), 0).parts).toEqual(['8 steps', '1 file changed', '1 helper']);
  });

  it('a run under a second says no time', () => {
    expect(endLine(head({ state: 'failed', endedAt: '2026-11-14T10:00:00.400Z' }), 0).lead).toBe('Failed');
    expect(endLine(head({ state: 'done', endedAt: '2026-11-14T10:00:00.400Z' }), 0).lead).toBe('Done');
  });

  it('long elapsed times read in hours', () => {
    expect(elapsedText((2 * 60 + 5) * 60_000)).toBe('2 h 5 min');
    expect(elapsedText(3 * 3_600_000)).toBe('3 h');
  });
});

describe('the to-do card, polished', () => {
  it('the pin says who is on the item, or what is next, or what is blocked', () => {
    const todo = { title: 'Run card', items: [{ id: 'a', text: 'Build', status: 'working', ownerId: 'x' }, { id: 'b', text: 'Ship', status: 'waiting' }] } as unknown as Parameters<typeof barLine>[0];
    expect(barLine(todo, () => 'Coder').text).toBe('Coder is working on Build');
    expect(barLine(todo).text).toBe('Working on Build');
    const next = { title: '', items: [{ id: 'b', text: 'Ship', status: 'waiting' }] } as unknown as Parameters<typeof barLine>[0];
    expect(barLine(next).text).toBe('Next: Ship');
  });

  it('a long list folds its finished items into one line; a short one shows them all', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ status: i < 12 ? ('done' as const) : ('waiting' as const) }));
    expect(foldDone(long)).toBe(12);
    expect(foldDone(long.slice(0, 5))).toBe(0);
  });
});

describe('the questions a run card draws', () => {
  it('hides in the strip exactly the questions a card drew, and forgets them when the card goes', () => {
    forgetShownQuestions();
    setShownQuestions('root', 'run1', ['q1']);
    setShownQuestions('root', 'run2', ['q2']);
    setShownQuestions('other', 'run3', ['q3']);
    const seen = new Set<string>();
    // read through the same store the hook reads
    for (const id of ['q1', 'q2', 'q3']) if (shownNow('root').has(id)) seen.add(id);
    expect([...seen]).toEqual(['q1', 'q2']);
    setShownQuestions('root', 'run1', []);
    expect(shownNow('root').has('q1')).toBe(false);
  });

  it('hands the focus and the open list of a card to the folded line, once', () => {
    leaveHandoff('r9', { focus: true, open: true });
    expect(takeHandoff('r9')).toEqual({ focus: true, open: true });
    expect(takeHandoff('r9')).toBeUndefined();
  });
});

describe('what real runs titled their steps (P25-16 threads)', () => {
  it('says a call to one of our own tools in plain words, never its raw name', () => {
    expect(toolPhrase('mcp__manythreads__tasks_claim', 'now')).toBe('Taking the card');
    expect(toolPhrase('mcp__manythreads__tasks_handoff', 'past')).toBe('Handed the card on');
    expect(toolPhrase('mcp__manythreads__memory.recall', 'past')).toBe('Recalled from memory');
    expect(toolPhrase('mcp__manythreads__tasks_private_note', 'past')).toBe("Read the card's private note");
    expect(toolPhrase('mcp__manythreads__surface_render', 'now')).toBe("Using the workspace's surface tool");
    expect(toolPhrase('mcp__github__create_issue', 'past')).toBe('Used github: create issue');
    expect(toolPhrase('Running pnpm', 'now')).toBeNull();
    expect(toolPhrase(null, 'now')).toBeNull();
  });

  it('the now line of a tool call, also when the agent marks it a command', () => {
    expect(nowLine(now({ kind: 'other', title: 'mcp__manythreads__tasks_claim' }), 'working')).toMatchObject({ text: 'Taking the card', code: null });
    expect(nowLine(now({ kind: 'execute', title: 'mcp__manythreads__messages.post' }), 'working')).toMatchObject({ text: 'Posting a message', code: null });
    expect(nowLine(now({ kind: 'other', title: 'mcp__manythreads__memory_recall', helper: 'Reviewer' }), 'working').text).toBe('Helper: recalling from memory');
  });

  it('a step list row of a tool call says what it did; a bare "Read File" gives way to the file', () => {
    const rows = buildRows([tool(0, 'a', 'execute', { title: 'mcp__manythreads__tasks.read' }), result(1, 'a'), tool(2, 'b', 'read', { title: 'Read File', paths: ['src/a/Card.tsx'] }), result(3, 'b')]);
    expect(rows[0]).toMatchObject({ type: 'step', kind: 'other', text: 'Read a card', code: null });
    expect(rows[1]).toMatchObject({ type: 'step', text: 'Read Card.tsx' });
  });

  it('a failed count names its steps', () => {
    expect(workParts(counts({ steps: 39, filesChanged: 5, failed: 2 }), { compact: true })).toEqual(['39 steps', '5 files changed', '2 steps failed']);
  });
});
