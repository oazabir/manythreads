import { beforeEach, describe, expect, it } from 'vitest';
import { Board, BotSummary, RosterMember, Task, TaskEvent } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import {
  branchFor,
  boardFilter,
  boardLabel,
  boardPath,
  botBoardOf,
  cardRequest,
  activityLabel,
  columnOf,
  columnMovedText,
  placeCards,
  reorder,
  dropTargets,
  emptyCard,
  eventLine,
  mayTagLabel,
  mayTagResolves,
  moveProblem,
  orgChart,
  ownerLabel,
} from '../src/screens/boards/board';
import { cronNote, emptyScheduledJob, scheduledJobRequest } from '../src/screens/boards/scheduled-job';
import {
  addColumn,
  deleteColumn,
  fetchCardActivity,
  fetchPlaces,
  renameColumn,
  reorderColumns,
  claimTask,
  completeTask,
  createBoard,
  createScheduledJob,
  createTask,
  fetchBoard,
  fetchBoards,
  fetchColumnTasks,
  fetchScheduledJobRuns,
  fetchScheduledJobs,
  fetchTaskEvents,
  handoffTask,
  moveTask,
  releaseTask,
  reworkTask,
  runScheduledJob,
  updateScheduledJob,
} from '../src/screens/boards/api';

/*
 * The Boards screen's two halves, neither of which the gate could otherwise see: the pure rules (which column a card is drawn in, which
 * moves the screen will send, how the chart and the scheduled job form read) and the client calls (each one reaching the path the plugin
 * mounts, with the body the shared schema expects). The React screen itself is proved by Playwright, as every other screen is.
 */

const AT = '2026-05-01T09:00:00.000Z';
const TEAM = '00000000-0000-7000-8000-0000000000aa';
const WS = '00000000-0000-7000-8000-000000000001';
const ACTOR = '00000000-0000-7000-8000-0000000000a1';
const BOT = '00000000-0000-7000-8000-0000000000b1';
/** The bot's actor id: what a card carries as its owner. Deliberately not the bots row id. */
const BOT_ACTOR = '00000000-0000-7000-8000-0000000000a9';
const BOARD = '00000000-0000-7000-8000-0000000000bb';

/** A column in the stored shape; the id is the state's name unless given. */
const col = (state: string, name: string, id: string = state) => ({ id, name, state, title: name });

const board = (over: Record<string, unknown> = {}): Board =>
  Board.parse({
    id: BOARD,
    workspaceId: WS,
    teamId: TEAM,
    name: 'Engineering',
    columns: [
      col('open', 'Open'),
      col('in_progress', 'In progress'),
      col('verify', 'Verify'),
      col('waiting_on_person', 'Waiting on a person'),
      col('done', 'Done'),
    ],
    filter: {},
    channelId: null,
    createdAt: AT,
    ...over,
  });

const task = (over: Record<string, unknown> = {}): Task =>
  Task.parse({
    id: '00000000-0000-7000-8000-0000000000c1',
    workspaceId: WS,
    teamId: TEAM,
    goalId: null,
    title: 'Fix the login redirect',
    description: '',
    state: 'open',
    kind: 'code',
    priority: 'normal',
    ownerId: null,
    branch: 'task/fix-login',
    baseSha: null,
    testedSha: null,
    environmentId: null,
    boardId: null,
    threadRootId: null,
    pullRequest: null,
    blockerReason: '',
    reworkCount: 0,
    handoffCount: 0,
    createdBy: ACTOR,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    ...over,
  });

const member = (over: Record<string, unknown> = {}): RosterMember =>
  RosterMember.parse({
    personId: '00000000-0000-7000-8000-0000000000d1',
    actorId: ACTOR,
    displayName: 'Nadia Rahman',
    email: 'nadia@kahf.example',
    workspaceRole: 'member',
    role: 'member',
    tags: [],
    joinedAt: AT,
    ...over,
  });

const bot = (over: Record<string, unknown> = {}): BotSummary =>
  BotSummary.parse({
    id: BOT,
    actorId: BOT_ACTOR,
    workspaceId: WS,
    teamId: TEAM,
    slug: 'reviewer',
    name: 'Reviewer',
    role: 'Reviews pull requests',
    kind: 'agent',
    runtime: 'hermes',
    visibility: 'team',
    definitionSha: 'a'.repeat(64),
    status: 'active',
    placement: null,
    mayTag: [],
    conversational: true,
    mentionable: true,
    invalid: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });

describe('a board draws its own columns in their saved order', () => {
  it('keeps the saved order and pairs each column with its cards and total', () => {
    const b = board({ columns: [col('verify', 'Checking'), col('open', 'Todo')] });
    const drawn = placeCards(b, [
      { state: 'open', items: [task()], total: 3 },
      { state: 'verify', items: [], total: 0 },
    ]);
    expect(drawn.map((c) => c.column.name)).toEqual(['Checking', 'Todo']);
    expect(drawn[0]).toMatchObject({ cards: [], total: 0 });
    expect(drawn[1]?.cards).toHaveLength(1);
    expect(drawn[1]?.total).toBe(3);
  });

  it('draws a column empty rather than dropping it when its read is missing', () => {
    const drawn = placeCards(board(), []);
    expect(drawn).toHaveLength(5);
    expect(drawn.every((c) => c.cards.length === 0 && c.total === 0)).toBe(true);
  });

  it('puts a card in its own place when that column still counts as its state, and in the first column of the state otherwise', () => {
    const b = board({ columns: [col('open', 'Open'), col('verify', 'Code review'), col('verify', 'QA', 'c_qa')] });
    const t = task({ state: 'verify' });
    const loaded = [{ state: 'verify' as const, items: [t], total: 4 }];
    const inQa = placeCards(b, loaded, { places: new Map([[t.id, 'c_qa']]), counts: new Map([['c_qa', 3]]) });
    expect(inQa.map((c) => [c.column.name, c.cards.length, c.total])).toEqual([['Open', 0, 0], ['Code review', 0, 1], ['QA', 1, 3]]);
    // a place in a column that is gone, or one of another state, falls back to the first column of the state
    for (const stale of ['c_gone', 'open']) {
      const drawn = placeCards(b, loaded, { places: new Map([[t.id, stale]]), counts: new Map() });
      expect(drawn.find((c) => c.cards.length > 0)?.column.name).toBe('Code review');
    }
    expect(columnOf(b, t, new Map([[t.id, 'c_qa']]))?.name).toBe('QA');
    expect(columnOf(b, task({ state: 'done' }), new Map())).toBeUndefined();
  });
});

describe('the moves the board offers follow the task rules', () => {
  it('offers only transitions the table allows and the board draws, and the other columns of the card\u2019s own state', () => {
    const b = board({ columns: [col('open', 'Open'), col('done', 'Done'), col('open', 'Backlog', 'c_backlog')] });
    expect(dropTargets(task(), b, 'open').map((c) => c.name)).toEqual(['Done', 'Backlog']);
    expect(dropTargets(task({ state: 'in_progress' }), b).map((c) => c.name)).toEqual(['Open', 'Done', 'Backlog']);
  });

  it('names the reason a drop is not sent, and sends the ones that are', () => {
    const b = board();
    const t = task();
    const to = (id: string) => b.columns.find((c) => c.id === id)!;
    expect(moveProblem(t, b, to('open'), 'open')).toMatch(/already in Open/);
    expect(moveProblem(t, b, to('verify'), 'open')).toMatch(/cannot move to Verify/);
    expect(moveProblem(t, b, to('in_progress'), 'open')).toBeNull();
    const other = { id: 'c_x', name: 'Elsewhere', state: 'done', title: 'Elsewhere' } as const;
    expect(moveProblem(t, b, other, 'open')).toMatch(/no such column/);
  });

  it('lets a card move to another column of its own state', () => {
    const b = board({ columns: [col('open', 'Open'), col('open', 'Backlog', 'c_backlog')] });
    expect(moveProblem(task(), b, b.columns[1]!, 'open')).toBeNull();
  });

  it('refuses a code card into Done without the sha that was tested, and allows one with it', () => {
    const b = board();
    const done = b.columns.find((c) => c.id === 'done')!;
    expect(moveProblem(task({ state: 'verify' }), b, done, 'verify')).toMatch(/tested commit/);
    expect(moveProblem(task({ state: 'verify', testedSha: 'abcdef1' }), b, done, 'verify')).toBeNull();
    // a content card has nothing to test, so the rule does not apply to it
    expect(moveProblem(task({ state: 'verify', kind: 'content' }), b, done, 'verify')).toBeNull();
  });
});

describe('reordering columns', () => {
  it('moves one id by a step and stops at the ends', () => {
    expect(reorder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(reorder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(reorder(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], 'c', 5)).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b'], 'zz', 1)).toEqual(['a', 'b']);
  });

  it('says where the column went in plain words', () => {
    expect(columnMovedText('Code review', ['a', 'code', 'b'], 'code')).toBe('Code review is now column 2 of 3');
  });
});

describe('the bot icon\u2019s words', () => {
  it('names one or two bots, counts more, and says about to for a queued run', () => {
    expect(activityLabel(['Coder'])).toBe('Coder is working on this');
    expect(activityLabel(['Coder', 'Tester'])).toBe('Coder and Tester are working on this');
    expect(activityLabel(['a', 'b', 'c'])).toBe('3 bots are working on this');
    expect(activityLabel(['Coder'], 'queued')).toBe('Coder is about to work on this');
    expect(activityLabel([])).toBe('A bot is working on this');
  });
});

describe('a board filter is read, not trusted', () => {
  it('takes the three filter keys the list route knows and ignores anything else', () => {
    const goal = '00000000-0000-7000-8000-0000000000e9';
    expect(boardFilter(board({ filter: { goalId: goal, ownerId: ACTOR, kind: 'ops', colour: 'red' } }))).toEqual({ goalId: goal, ownerId: ACTOR, kind: 'ops' });
    expect(boardFilter(board({ filter: { kind: 'not-a-kind' } }))).toEqual({});
    // an id that is not a uuid is dropped too: the list route would refuse the query, and the board would show an error instead of cards
    expect(boardFilter(board({ filter: { goalId: 'g1', ownerId: 'a1' } }))).toEqual({});
    expect(boardFilter(board())).toEqual({});
  });
});

describe('a new card', () => {
  it('turns a title into a branch a git ref can spell', () => {
    expect(branchFor('Fix the login redirect')).toBe('task/fix-the-login-redirect');
    expect(branchFor('  ')).toBe('task/card');
    expect(branchFor('A/B: c_d')).toBe('task/a-b-c-d');
  });

  it('is refused while it has no title or branch, with the schema’s own words', () => {
    expect(cardRequest({ ...emptyCard(), branch: 'task/x' }).ok).toBe(false);
    expect(cardRequest({ ...emptyCard(), title: 'Do the thing' })).toMatchObject({ ok: false });
  });

  it('becomes the request the create route expects', () => {
    const built = cardRequest({ title: 'Do the thing', description: '', kind: 'code', priority: 'high', branch: 'task/do-the-thing' });
    expect(built).toEqual({
      ok: true,
      body: { title: 'Do the thing', description: '', kind: 'code', priority: 'high', branch: 'task/do-the-thing' },
    });
  });
});

describe('who holds a card', () => {
  it('names a person, a bot, nobody, or an actor the team no longer has', () => {
    const people = [member()];
    const bots = [bot()];
    expect(ownerLabel(null, people, bots)).toBe('nobody yet');
    expect(ownerLabel(ACTOR, people, bots)).toBe('Nadia Rahman');
    expect(ownerLabel(BOT_ACTOR, people, bots)).toBe('Reviewer');
    // the bots row id is not an actor: a card never carries it
    expect(ownerLabel(BOT, people, bots)).toBe('someone no longer on the team');
    expect(ownerLabel('00000000-0000-7000-8000-0000000000ff', people, bots)).toBe('someone no longer on the team');
  });
});

describe('a card’s history reads in words', () => {
  const nameOf = (id: string | null): string => (id === BOT_ACTOR ? 'Reviewer' : 'Nadia Rahman');
  const event = (type: TaskEvent['type'], data: Record<string, unknown> = {}): TaskEvent =>
    TaskEvent.parse({ id: '00000000-0000-7000-8000-0000000000e1', taskId: task().id, teamId: TEAM, actorId: ACTOR, type, data, createdAt: AT });

  it('says what happened for every kind of line the substrate writes', () => {
    expect(eventLine(event('created'), nameOf)).toBe('created the card');
    expect(eventLine(event('claimed'), nameOf)).toBe('claimed it');
    expect(eventLine(event('released', { reason: 'claim expired' }), nameOf)).toBe('released it (claim expired)');
    expect(eventLine(event('state_changed', { from: 'open', to: 'in_progress' }), nameOf)).toBe('Open → In progress');
    expect(eventLine(event('handed_off', { toActorId: BOT_ACTOR, mode: 'bot' }), nameOf)).toBe('handed it to Reviewer (bot)');
    expect(eventLine(event('completed', { testedSha: 'abcdef1' }), nameOf)).toBe('completed it, tested at abcdef1');
    expect(eventLine(event('completed', { from: 'verify', to: 'done' }), nameOf)).toBe('moved it to Done');
    expect(eventLine(event('reworked', { reason: 'tests red' }), nameOf)).toBe('sent it back: tests red');
    expect(eventLine(event('deployed', { environment: 'production' }), nameOf)).toBe('deployed to production');
  });
});

describe('the org chart', () => {
  it('puts leads above members and lists the bots beside them', () => {
    const chart = orgChart(
      [member(), member({ personId: '00000000-0000-7000-8000-0000000000d2', actorId: '00000000-0000-7000-8000-0000000000a2', displayName: 'Omar Al Zabir', role: 'lead', tags: ['role:on-call'] })],
      [bot({ mayTag: ['reviewer', 'on-call'] })],
    );
    expect(chart.leads.map((p) => p.name)).toEqual(['Omar Al Zabir']);
    expect(chart.members.map((p) => p.name)).toEqual(['Nadia Rahman']);
    expect(chart.bots.map((b) => b.slug)).toEqual(['reviewer']);
  });

  it('carries each person\u2019s and bot\u2019s picture to the chart, and sorts every band by name', () => {
    const chart = orgChart(
      [member({ avatar: 'preset:fox' }), member({ personId: '00000000-0000-7000-8000-0000000000d3', actorId: '00000000-0000-7000-8000-0000000000a3', displayName: 'Aisha Khan' })],
      [bot({ slug: 'writer', name: 'Writer', avatar: 'preset:owl' }), bot({ avatar: null })],
    );
    expect(chart.members.map((p) => p.name)).toEqual(['Aisha Khan', 'Nadia Rahman']);
    expect(chart.members[1]).toMatchObject({ personId: '00000000-0000-7000-8000-0000000000d1', avatar: 'preset:fox' });
    expect(chart.members[0]?.avatar).toBeNull();
    expect(chart.bots.map((b) => [b.name, b.avatar])).toEqual([['Reviewer', null], ['Writer', 'preset:owl']]);
  });

  it('reads a mayTag entry as a bot, a person, a role, or something nobody on the team holds', () => {
    const people = [
      { actorId: ACTOR, name: 'Nadia Rahman', role: 'member', tags: ['role:on-call'], lead: false },
      { actorId: '00000000-0000-7000-8000-0000000000a2', name: 'Omar Al Zabir', role: 'lead', tags: [], lead: true },
    ];
    const bots = [{ slug: 'reviewer', name: 'Reviewer', role: '', mayTag: [] }];
    expect(mayTagLabel('reviewer', people, bots)).toBe('Reviewer');
    expect(mayTagLabel('person:00000000-0000-7000-8000-0000000000a2', people, bots)).toBe('Omar Al Zabir');
    expect(mayTagLabel('on-call', people, bots)).toBe('on-call');
    expect(mayTagLabel('tester', people, bots)).toBe('tester');

    expect(mayTagResolves('reviewer', people, bots)).toBe(true);
    expect(mayTagResolves('on-call', people, bots)).toBe(true);
    expect(mayTagResolves('person:00000000-0000-7000-8000-0000000000a2', people, bots)).toBe(true);
    expect(mayTagResolves('tester', people, bots)).toBe(false);
  });
});

describe('the scheduled job form', () => {
  it('accepts a heartbeat with no contract, and turns the blank optional fields into null', () => {
    const built = scheduledJobRequest({ ...emptyScheduledJob('brain'), name: 'Hourly nudge' });
    expect(built).toMatchObject({ ok: true, body: { modelAlias: null, effort: null, contractPath: null, outputPath: null, enabled: true } });
  });

  it('refuses a routine without a contract, and accepts one under routines/', () => {
    const base = { ...emptyScheduledJob('brain'), name: 'Weekly', kind: 'routine' as const };
    expect(scheduledJobRequest(base)).toMatchObject({ ok: false, message: 'a routine needs a contract path' });
    expect(scheduledJobRequest({ ...base, contractPath: 'routines/weekly.yaml', outputPath: 'pages/reports/weekly.md' })).toMatchObject({ ok: true });
  });

  it('refuses a schedule that is not five fields', () => {
    expect(scheduledJobRequest({ ...emptyScheduledJob('brain'), name: 'Bad', schedule: 'every hour' })).toMatchObject({ ok: false });
  });

  it('says when the schedule next fires, and why it never will', () => {
    const now = new Date('2026-05-01T09:30:00.000Z'); // a Friday
    expect(cronNote('0 9 * * mon-fri', now)).toContain('Next run');
    expect(cronNote('0 9 * * mon-fri', now)).toContain('UTC');
    expect(cronNote('0 0 31 2 *', now)).toBe('This schedule never fires.');
    expect(cronNote('nope', now)).toMatch(/5 fields/);
  });
});

// ---- the client reaches the routes the plugins mount --------------------------------------------------------

const REPLIES: Record<string, unknown> = {
  [`GET /api/teams/engineering/boards`]: { items: [board()] },
  [`GET /api/teams/engineering/boards/${BOARD}`]: { board: board() },
  [`POST /api/teams/engineering/boards`]: { board: board({ name: 'Ops' }) },
  [`POST /api/teams/engineering/boards/${BOARD}/move`]: { task: task({ state: 'in_progress' }) },
  [`POST /api/teams/engineering/boards/${BOARD}/columns`]: { board: board() },
  [`PATCH /api/teams/engineering/boards/${BOARD}/columns/c_qa`]: { board: board() },
  [`DELETE /api/teams/engineering/boards/${BOARD}/columns/c_qa`]: { board: board() },
  [`PUT /api/teams/engineering/boards/${BOARD}/columns/order`]: { board: board() },
  [`GET /api/teams/engineering/boards/${BOARD}/places`]: { places: [], counts: [{ columnId: 'open', total: 1 }] },
  [`GET /api/teams/engineering/tasks/activity`]: { items: [{ taskId: task().id, bots: [{ actorId: BOT_ACTOR, phase: 'running' }] }] },
  [`GET /api/teams/engineering/tasks`]: { items: [task()], total: 1 },
  [`POST /api/teams/engineering/tasks`]: { task: task() },
  [`GET /api/teams/engineering/tasks/${task().id}`]: { task: task() },
  [`GET /api/teams/engineering/tasks/${task().id}/events`]: { items: [] },
  [`POST /api/teams/engineering/tasks/${task().id}/claim`]: { task: task(), expiresAt: AT },
  [`POST /api/teams/engineering/tasks/${task().id}/release`]: { task: task() },
  [`POST /api/teams/engineering/tasks/${task().id}/complete`]: { task: task({ state: 'done' }) },
  [`POST /api/teams/engineering/tasks/${task().id}/rework`]: { task: task({ state: 'in_progress' }) },
  [`POST /api/teams/engineering/tasks/${task().id}/handoff`]: {
    task: task({ ownerId: BOT_ACTOR }),
    handoff: {
      id: '00000000-0000-7000-8000-0000000000f1',
      taskId: task().id,
      teamId: TEAM,
      fromActorId: ACTOR,
      toActorId: BOT,
      mode: 'bot',
      note: '',
      approvalId: null,
      appliedAt: AT,
      createdAt: AT,
    },
    pendingApproval: false,
    approvalId: null,
  },
  [`GET /api/teams/engineering/scheduled-jobs`]: { items: [] },
  [`POST /api/teams/engineering/scheduled-jobs`]: {
    scheduledJob: {
      id: '00000000-0000-7000-8000-0000000000f2',
      workspaceId: WS,
      teamId: TEAM,
      botId: BOT,
      name: 'Hourly',
      kind: 'heartbeat',
      schedule: '0 * * * *',
      modelAlias: null,
      effort: null,
      contractPath: null,
      outputPath: null,
      enabled: true,
      nextRunAt: AT,
      createdBy: ACTOR,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  [`PATCH /api/teams/engineering/scheduled-jobs/00000000-0000-7000-8000-0000000000f2`]: {
    scheduledJob: {
      id: '00000000-0000-7000-8000-0000000000f2',
      workspaceId: WS,
      teamId: TEAM,
      botId: BOT,
      name: 'Hourly',
      kind: 'heartbeat',
      schedule: '0 * * * *',
      modelAlias: null,
      effort: null,
      contractPath: null,
      outputPath: null,
      enabled: false,
      nextRunAt: null,
      createdBy: ACTOR,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  [`GET /api/teams/engineering/scheduled-jobs/00000000-0000-7000-8000-0000000000f2/runs`]: { items: [] },
  [`POST /api/teams/engineering/scheduled-jobs/00000000-0000-7000-8000-0000000000f2/run`]: {
    run: {
      id: '00000000-0000-7000-8000-0000000000f3',
      scheduledJobId: '00000000-0000-7000-8000-0000000000f2',
      teamId: TEAM,
      runId: null,
      taskId: null,
      status: 'queued',
      outputPath: null,
      reason: '',
      startedAt: AT,
      endedAt: null,
    },
  },
};

let seen: TransportRequest[] = [];

beforeEach(() => {
  seen = [];
  setTransport(async (req) => {
    seen.push(req);
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const body = REPLIES[key];
    return body === undefined ? { status: 404, body: { error: { code: 'not_found', message: `no reply for ${key}` } } } : { status: 200, body };
  });
});

const last = (): TransportRequest => {
  const req = seen[seen.length - 1];
  if (!req) throw new Error('no request was sent');
  return req;
};

describe('the board endpoints reach the routes the plugins mount', () => {
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; path: string; body?: unknown }> = [
    { name: 'lists boards', run: () => fetchBoards('engineering'), method: 'GET', path: '/api/teams/engineering/boards' },
    { name: 'reads one board', run: () => fetchBoard('engineering', BOARD), method: 'GET', path: `/api/teams/engineering/boards/${BOARD}` },
    { name: 'creates a board', run: () => createBoard('engineering', { name: 'Ops' }), method: 'POST', path: '/api/teams/engineering/boards', body: { name: 'Ops' } },
    {
      name: 'moves a card through the board',
      run: () => moveTask('engineering', BOARD, task().id, 'in_progress'),
      method: 'POST',
      path: `/api/teams/engineering/boards/${BOARD}/move`,
      body: { taskId: task().id, columnId: 'in_progress' },
    },
    { name: 'adds a column', run: () => addColumn('engineering', BOARD, { name: 'QA', state: 'verify' }), method: 'POST', path: `/api/teams/engineering/boards/${BOARD}/columns`, body: { name: 'QA', state: 'verify' } },
    { name: 'renames a column', run: () => renameColumn('engineering', BOARD, 'c_qa', { name: 'Tests' }), method: 'PATCH', path: `/api/teams/engineering/boards/${BOARD}/columns/c_qa`, body: { name: 'Tests' } },
    { name: 'deletes a column', run: () => deleteColumn('engineering', BOARD, 'c_qa'), method: 'DELETE', path: `/api/teams/engineering/boards/${BOARD}/columns/c_qa` },
    { name: 'reorders the columns', run: () => reorderColumns('engineering', BOARD, ['done', 'open']), method: 'PUT', path: `/api/teams/engineering/boards/${BOARD}/columns/order`, body: { columnIds: ['done', 'open'] } },
    { name: 'reads where cards sit', run: () => fetchPlaces('engineering', BOARD), method: 'GET', path: `/api/teams/engineering/boards/${BOARD}/places` },
    { name: 'reads which bots work on cards', run: () => fetchCardActivity('engineering'), method: 'GET', path: '/api/teams/engineering/tasks/activity' },
    {
      name: 'creates a card',
      run: () => createTask('engineering', { title: 'Do', description: '', kind: 'code', priority: 'normal', branch: 'task/do' }),
      method: 'POST',
      path: '/api/teams/engineering/tasks',
      body: { title: 'Do', description: '', kind: 'code', priority: 'normal', branch: 'task/do' },
    },
    { name: 'claims a card', run: () => claimTask('engineering', task().id), method: 'POST', path: `/api/teams/engineering/tasks/${task().id}/claim` },
    { name: 'releases a card', run: () => releaseTask('engineering', task().id), method: 'POST', path: `/api/teams/engineering/tasks/${task().id}/release` },
    {
      name: 'completes a card with the tested sha',
      run: () => completeTask('engineering', task().id, { testedSha: 'abcdef1', summary: 'done' }),
      method: 'POST',
      path: `/api/teams/engineering/tasks/${task().id}/complete`,
      body: { testedSha: 'abcdef1', summary: 'done' },
    },
    { name: 'sends a card back', run: () => reworkTask('engineering', task().id, { reason: 'red' }), method: 'POST', path: `/api/teams/engineering/tasks/${task().id}/rework`, body: { reason: 'red' } },
    {
      name: 'hands a card over',
      run: () => handoffTask('engineering', task().id, { toBotSlug: 'reviewer', mode: 'bot', note: 'look', strict: false }),
      method: 'POST',
      path: `/api/teams/engineering/tasks/${task().id}/handoff`,
      body: { toBotSlug: 'reviewer', mode: 'bot', note: 'look', strict: false },
    },
    { name: 'reads a card’s history', run: () => fetchTaskEvents('engineering', task().id), method: 'GET', path: `/api/teams/engineering/tasks/${task().id}/events` },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      await c.run();
      const req = last();
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.path);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('asks a column for its state with the board’s filter, as a query', async () => {
    await fetchColumnTasks('engineering', { state: 'verify', kind: 'code' });
    const req = last();
    expect(req.method).toBe('GET');
    expect(req.url.split('?')[0]).toBe('/api/teams/engineering/tasks');
    const query = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
    expect(Object.fromEntries(query)).toEqual({ state: 'verify', kind: 'code', limit: '100' });
  });
});

describe('the scheduled job endpoints reach the routes the scheduled jobs plugin mounts', () => {
  const id = '00000000-0000-7000-8000-0000000000f2';
  it('lists, creates, updates, reads runs and runs one now', async () => {
    await fetchScheduledJobs('engineering');
    expect(last()).toMatchObject({ method: 'GET', url: '/api/teams/engineering/scheduled-jobs' });

    await createScheduledJob('engineering', { botSlug: 'brain', name: 'Hourly', kind: 'heartbeat', schedule: '0 * * * *', modelAlias: null, effort: null, contractPath: null, outputPath: null, enabled: true });
    expect(last()).toMatchObject({ method: 'POST', url: '/api/teams/engineering/scheduled-jobs' });

    await updateScheduledJob('engineering', id, { enabled: false });
    expect(last()).toMatchObject({ method: 'PATCH', url: `/api/teams/engineering/scheduled-jobs/${id}` });
    expect(JSON.parse(last().body ?? 'null')).toEqual({ enabled: false });

    await fetchScheduledJobRuns('engineering', id);
    expect(last()).toMatchObject({ method: 'GET', url: `/api/teams/engineering/scheduled-jobs/${id}/runs` });

    await runScheduledJob('engineering', id);
    expect(last()).toMatchObject({ method: 'POST', url: `/api/teams/engineering/scheduled-jobs/${id}/run` });
  });
});

describe('a channel board', () => {
  const CHANNEL = '00000000-0000-7000-8000-0000000000d1';

  it('is read by the cards filed on it, not by a saved filter', () => {
    expect(boardFilter(board({ channelId: CHANNEL, filter: { kind: 'ops' } }))).toEqual({ boardId: BOARD });
  });

  it('is labelled with its channel in the picker, and a team board is just its name', () => {
    const names = new Map([[CHANNEL, 'shipping']]);
    expect(boardLabel(board({ channelId: CHANNEL, name: 'Bot Board' }), names)).toBe('Bot Board · #shipping');
    expect(boardLabel(board({ channelId: CHANNEL, name: 'Bot Board' }), new Map())).toBe('Bot Board');
    expect(boardLabel(board(), names)).toBe('Engineering');
  });

  it('is the channel header link only when the board is attached and named Bot Board', () => {
    expect(botBoardOf([])).toBeUndefined();
    expect(botBoardOf([board({ channelId: CHANNEL, name: 'Sprint' })])).toBeUndefined();
    expect(botBoardOf([board({ name: 'Bot Board' })])).toBeUndefined();
    expect(botBoardOf([board({ channelId: CHANNEL, name: 'Bot Board' })])?.id).toBe(BOARD);
    expect(boardPath('engineering', BOARD)).toBe(`/t/engineering/boards?board=${BOARD}`);
  });
});
