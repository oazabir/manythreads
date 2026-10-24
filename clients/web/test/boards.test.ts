import { beforeEach, describe, expect, it } from 'vitest';
import { Board, BotSummary, RosterMember, Task, TaskEvent } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import {
  branchFor,
  boardFilter,
  cardRequest,
  columnsWithCards,
  dropTargets,
  emptyCard,
  eventLine,
  mayTagLabel,
  mayTagResolves,
  moveProblem,
  orgChart,
  ownerLabel,
} from '../src/screens/boards/board';
import { cronNote, emptyRhythm, rhythmRequest } from '../src/screens/boards/rhythm';
import {
  claimTask,
  completeTask,
  createBoard,
  createRhythm,
  createTask,
  fetchBoard,
  fetchBoards,
  fetchColumnTasks,
  fetchRhythmRuns,
  fetchRhythms,
  fetchTaskEvents,
  handoffTask,
  moveTask,
  releaseTask,
  reworkTask,
  runRhythm,
  updateRhythm,
} from '../src/screens/boards/api';

/*
 * The Boards screen's two halves, neither of which the gate could otherwise see: the pure rules (which column a card is drawn in, which
 * moves the screen will send, how the chart and the rhythm form read) and the client calls (each one reaching the path the plugin
 * mounts, with the body the shared schema expects). The React screen itself is proved by Playwright, as every other screen is.
 */

const AT = '2026-05-01T09:00:00.000Z';
const TEAM = '00000000-0000-7000-8000-0000000000aa';
const WS = '00000000-0000-7000-8000-000000000001';
const ACTOR = '00000000-0000-7000-8000-0000000000a1';
const BOT = '00000000-0000-7000-8000-0000000000b1';
const BOARD = '00000000-0000-7000-8000-0000000000bb';

const board = (over: Record<string, unknown> = {}): Board =>
  Board.parse({
    id: BOARD,
    workspaceId: WS,
    teamId: TEAM,
    name: 'Engineering',
    columns: [
      { state: 'open', title: 'Open' },
      { state: 'in_progress', title: 'In progress' },
      { state: 'verify', title: 'Verify' },
      { state: 'waiting_on_person', title: 'Waiting on a person' },
      { state: 'done', title: 'Done' },
    ],
    filter: {},
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
    threadRootId: null,
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
    invalid: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });

describe('a board draws its own columns in their saved order', () => {
  it('keeps the saved order and pairs each column with its cards and total', () => {
    const b = board({ columns: [{ state: 'verify', title: 'Checking' }, { state: 'open', title: 'Todo' }] });
    const drawn = columnsWithCards(b, [
      { state: 'open', items: [task()], total: 3 },
      { state: 'verify', items: [], total: 0 },
    ]);
    expect(drawn.map((c) => c.column.title)).toEqual(['Checking', 'Todo']);
    expect(drawn[0]).toMatchObject({ cards: [], total: 0 });
    expect(drawn[1]?.cards).toHaveLength(1);
    expect(drawn[1]?.total).toBe(3);
  });

  it('draws a column empty rather than dropping it when its read is missing', () => {
    const drawn = columnsWithCards(board(), []);
    expect(drawn).toHaveLength(5);
    expect(drawn.every((c) => c.cards.length === 0 && c.total === 0)).toBe(true);
  });
});

describe('the moves the board offers follow the task rules', () => {
  it('offers only transitions the table allows and the board draws', () => {
    const b = board({ columns: [{ state: 'open', title: 'Open' }, { state: 'done', title: 'Done' }] });
    expect(dropTargets(task(), b)).toEqual(['done']);
    expect(dropTargets(task({ state: 'in_progress' }), b)).toEqual(['open', 'done']);
  });

  it('names the reason a drop is not sent, and sends the ones that are', () => {
    const b = board();
    const t = task();
    expect(moveProblem(t, b, 'open')).toMatch(/already in Open/);
    expect(moveProblem(t, b, 'verify')).toMatch(/cannot move to Verify/);
    expect(moveProblem(t, board({ columns: [{ state: 'open', title: 'Open' }] }), 'done')).toMatch(/no Done column/);
    expect(moveProblem(t, b, 'in_progress')).toBeNull();
  });

  it('refuses a code card into Done without the sha that was tested, and allows one with it', () => {
    const b = board();
    expect(moveProblem(task({ state: 'verify' }), b, 'done')).toMatch(/tested commit/);
    expect(moveProblem(task({ state: 'verify', testedSha: 'abcdef1' }), b, 'done')).toBeNull();
    // a content card has nothing to test, so the rule does not apply to it
    expect(moveProblem(task({ state: 'verify', kind: 'content' }), b, 'done')).toBeNull();
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
    expect(ownerLabel(BOT, people, bots)).toBe('Reviewer');
    expect(ownerLabel('00000000-0000-7000-8000-0000000000ff', people, bots)).toBe('someone no longer on the team');
  });
});

describe('a card’s history reads in words', () => {
  const nameOf = (id: string | null): string => (id === BOT ? 'Reviewer' : 'Nadia Rahman');
  const event = (type: TaskEvent['type'], data: Record<string, unknown> = {}): TaskEvent =>
    TaskEvent.parse({ id: '00000000-0000-7000-8000-0000000000e1', taskId: task().id, teamId: TEAM, actorId: ACTOR, type, data, createdAt: AT });

  it('says what happened for every kind of line the substrate writes', () => {
    expect(eventLine(event('created'), nameOf)).toBe('created the card');
    expect(eventLine(event('claimed'), nameOf)).toBe('claimed it');
    expect(eventLine(event('released', { reason: 'claim expired' }), nameOf)).toBe('released it (claim expired)');
    expect(eventLine(event('state_changed', { from: 'open', to: 'in_progress' }), nameOf)).toBe('Open → In progress');
    expect(eventLine(event('handed_off', { toActorId: BOT, mode: 'bot' }), nameOf)).toBe('handed it to Reviewer (bot)');
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

describe('the rhythm form', () => {
  it('accepts a heartbeat with no contract, and turns the blank optional fields into null', () => {
    const built = rhythmRequest({ ...emptyRhythm('brain'), name: 'Hourly nudge' });
    expect(built).toMatchObject({ ok: true, body: { modelAlias: null, effort: null, contractPath: null, outputPath: null, enabled: true } });
  });

  it('refuses a routine without a contract, and accepts one under routines/', () => {
    const base = { ...emptyRhythm('brain'), name: 'Weekly', kind: 'routine' as const };
    expect(rhythmRequest(base)).toMatchObject({ ok: false, message: 'a routine needs a contract path' });
    expect(rhythmRequest({ ...base, contractPath: 'routines/weekly.yaml', outputPath: 'pages/reports/weekly.md' })).toMatchObject({ ok: true });
  });

  it('refuses a schedule that is not five fields', () => {
    expect(rhythmRequest({ ...emptyRhythm('brain'), name: 'Bad', schedule: 'every hour' })).toMatchObject({ ok: false });
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
  [`GET /api/teams/engineering/tasks`]: { items: [task()], total: 1 },
  [`POST /api/teams/engineering/tasks`]: { task: task() },
  [`GET /api/teams/engineering/tasks/${task().id}`]: { task: task() },
  [`GET /api/teams/engineering/tasks/${task().id}/events`]: { items: [] },
  [`POST /api/teams/engineering/tasks/${task().id}/claim`]: { task: task(), expiresAt: AT },
  [`POST /api/teams/engineering/tasks/${task().id}/release`]: { task: task() },
  [`POST /api/teams/engineering/tasks/${task().id}/complete`]: { task: task({ state: 'done' }) },
  [`POST /api/teams/engineering/tasks/${task().id}/rework`]: { task: task({ state: 'in_progress' }) },
  [`POST /api/teams/engineering/tasks/${task().id}/handoff`]: {
    task: task({ ownerId: BOT }),
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
  [`GET /api/teams/engineering/rhythms`]: { items: [] },
  [`POST /api/teams/engineering/rhythms`]: {
    rhythm: {
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
  [`PATCH /api/teams/engineering/rhythms/00000000-0000-7000-8000-0000000000f2`]: {
    rhythm: {
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
  [`GET /api/teams/engineering/rhythms/00000000-0000-7000-8000-0000000000f2/runs`]: { items: [] },
  [`POST /api/teams/engineering/rhythms/00000000-0000-7000-8000-0000000000f2/run`]: {
    run: {
      id: '00000000-0000-7000-8000-0000000000f3',
      rhythmId: '00000000-0000-7000-8000-0000000000f2',
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
      body: { taskId: task().id, to: 'in_progress' },
    },
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

describe('the rhythm endpoints reach the routes the rhythms plugin mounts', () => {
  const id = '00000000-0000-7000-8000-0000000000f2';
  it('lists, creates, updates, reads runs and runs one now', async () => {
    await fetchRhythms('engineering');
    expect(last()).toMatchObject({ method: 'GET', url: '/api/teams/engineering/rhythms' });

    await createRhythm('engineering', { botSlug: 'brain', name: 'Hourly', kind: 'heartbeat', schedule: '0 * * * *', modelAlias: null, effort: null, contractPath: null, outputPath: null, enabled: true });
    expect(last()).toMatchObject({ method: 'POST', url: '/api/teams/engineering/rhythms' });

    await updateRhythm('engineering', id, { enabled: false });
    expect(last()).toMatchObject({ method: 'PATCH', url: `/api/teams/engineering/rhythms/${id}` });
    expect(JSON.parse(last().body ?? 'null')).toEqual({ enabled: false });

    await fetchRhythmRuns('engineering', id);
    expect(last()).toMatchObject({ method: 'GET', url: `/api/teams/engineering/rhythms/${id}/runs` });

    await runRhythm('engineering', id);
    expect(last()).toMatchObject({ method: 'POST', url: `/api/teams/engineering/rhythms/${id}/run` });
  });
});
