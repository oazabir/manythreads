import {
  ActorId,
  CreateTaskRequest,
  GoalId,
  TASK_TRANSITIONS,
  TaskKind,
  type Board,
  type BoardColumn,
  type BotSummary,
  type RosterMember,
  type Task,
  type TaskEvent,
  type TaskState,
} from '@manythreads/shared';
import { isApiError } from '../../api/client';

/*
 * The pure half of the Boards screen (PLAN P6-07): how a board's saved columns line up with the cards the server returned, which moves
 * the screen offers, and how a refusal is worded. Everything here is a function of its arguments, so the rules can be tested without a
 * browser — and the one thing this file never does is decide a move: `moveProblem` only says whether the screen would send it, and the
 * server's answer (409 and the reason) is what the person sees.
 */

export const STATE_LABEL: Readonly<Record<TaskState, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  verify: 'Verify',
  waiting_on_person: 'Waiting on a person',
  done: 'Done',
};

/** What one task read returned, per state the board asks for. */
export type LoadedColumn = { state: TaskState; items: Task[]; total: number };

export type ColumnCards = { column: BoardColumn; cards: Task[]; total: number };

/**
 * The board's columns in their saved order, each with the cards of that state. A column with no read yet (or a failed one) draws empty
 * rather than hiding — a board that silently lost a column would look like the work was gone.
 */
export function columnsWithCards(board: Board, loaded: readonly LoadedColumn[]): ColumnCards[] {
  const byState = new Map(loaded.map((l) => [l.state, l]));
  return board.columns.map((column) => {
    const l = byState.get(column.state);
    return { column, cards: l?.items ?? [], total: l?.total ?? 0 };
  });
}

/** The states this card may be dragged to on this board: a transition the rules allow and a column the board draws. */
export function dropTargets(task: Task, board: Board): TaskState[] {
  const states = new Set(board.columns.map((c) => c.state));
  return TASK_TRANSITIONS[task.state].filter((to) => states.has(to));
}

/**
 * Why the screen will not send this move, or null to send it. The last two checks repeat rules the server enforces (a board's column
 * set, the transition table, a code card's tested sha): keeping them here lets a drag onto an impossible column say why instead of
 * making a request that can only be refused, and the server still has the last word on every move that is sent.
 */
export function moveProblem(task: Task, board: Board, to: TaskState): string | null {
  if (to === task.state) return `“${task.title}” is already in ${STATE_LABEL[to]}.`;
  if (!board.columns.some((c) => c.state === to)) return `This board has no ${STATE_LABEL[to]} column.`;
  if (!TASK_TRANSITIONS[task.state].includes(to)) {
    return `A card in ${STATE_LABEL[task.state]} cannot move to ${STATE_LABEL[to]}.`;
  }
  if (task.kind === 'code' && to === 'done' && !task.testedSha) {
    return 'A code card needs its tested commit before Done: complete the card with the sha that was tested rather than dragging it.';
  }
  return null;
}

/** The sentence a refused call is shown as: the server's own reason when it sent one (409, 403), otherwise a plain fallback. */
export function refusalText(err: unknown): string {
  if (isApiError(err)) {
    if (err.status === 404) return `That card is no longer on this board. ${err.message}`.trim();
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'The server refused that move.';
}

/** A board's saved filter as the task list query the columns are read with (unknown keys are ignored, never sent). */
export function boardFilter(board: Board): { goalId?: GoalId; ownerId?: ActorId; kind?: TaskKind } {
  const out: { goalId?: GoalId; ownerId?: ActorId; kind?: TaskKind } = {};
  const f = board.filter;
  // The filter is open data (a saved view may grow a key later): a value that is not a valid id is dropped, never sent as a guess.
  const goalId = GoalId.safeParse(f['goalId']);
  if (goalId.success) out.goalId = goalId.data;
  const ownerId = ActorId.safeParse(f['ownerId']);
  if (ownerId.success) out.ownerId = ownerId.data;
  const kind = TaskKind.safeParse(f['kind']);
  if (kind.success) out.kind = kind.data;
  return out;
}

/** Whoever holds a card, by name: a person from the roster, a bot from the roster. An id nobody on the team knows is said as such. */
export function ownerLabel(ownerId: string | null, roster: readonly RosterMember[], bots: readonly BotSummary[]): string {
  if (ownerId === null) return 'nobody yet';
  const person = roster.find((m) => m.actorId === ownerId);
  if (person) return person.displayName;
  // A card names its holder by ACTOR id; a bot's actor id is `actorId` (its `id` is the bots row, a different uuid).
  const bot = bots.find((b) => b.actorId === ownerId);
  if (bot) return bot.name;
  return 'someone no longer on the team';
}

/** A new card's draft: the form holds text, and the shared schema says what a card needs. */
export type CardDraft = {
  title: string;
  description: string;
  kind: CreateTaskRequest['kind'];
  priority: CreateTaskRequest['priority'];
  branch: string;
};

export const emptyCard = (): CardDraft => ({ title: '', description: '', kind: 'code', priority: 'normal', branch: '' });

/** The branch a new card defaults to: `task/` plus the title, as a git ref can spell it. */
export function branchFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'task/card' : `task/${slug}`;
}

export type CardBuild = { ok: true; body: CreateTaskRequest } | { ok: false; message: string };

export function cardRequest(draft: CardDraft): CardBuild {
  const parsed = CreateTaskRequest.safeParse({
    title: draft.title,
    description: draft.description,
    kind: draft.kind,
    priority: draft.priority,
    branch: draft.branch.trim(),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: issue?.message ?? 'The card is not complete.' };
}

const text = (data: Record<string, unknown>, key: string): string | undefined => {
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

/** One line of a card's history, in words, with `nameOf` resolving the actor (and a handoff's target) from the roster. */
export function eventLine(e: TaskEvent, nameOf: (id: string | null) => string): string {
  const d = e.data as Record<string, unknown>;
  const from = text(d, 'from') as TaskState | undefined;
  const to = text(d, 'to') as TaskState | undefined;
  switch (e.type) {
    case 'created':
      return 'created the card';
    case 'claimed':
      return 'claimed it';
    case 'released':
      return text(d, 'reason') ? `released it (${text(d, 'reason')})` : 'released it';
    case 'state_changed':
      return from && to ? `${STATE_LABEL[from] ?? from} → ${STATE_LABEL[to] ?? to}` : 'moved it';
    case 'handed_off': {
      const target = nameOf(text(d, 'toActorId') ?? null);
      const mode = text(d, 'mode');
      return `handed it to ${target}${mode ? ` (${mode})` : ''}`;
    }
    case 'completed':
      return text(d, 'testedSha') ? `completed it, tested at ${text(d, 'testedSha')}` : 'moved it to Done';
    case 'reworked':
      return text(d, 'reason') ? `sent it back: ${text(d, 'reason')}` : 'sent it back';
    case 'deployed':
      return `deployed to ${text(d, 'environment') ?? 'an environment'}`;
    default:
      return e.type;
  }
}

// ---- the org chart (P6-07: leads above specialists, mayTag edges) --------------------------------------------

export type OrgPerson = { actorId: string; name: string; role: string; tags: string[]; lead: boolean };
export type OrgBot = { slug: string; name: string; role: string; mayTag: string[] };
export type OrgChartData = { leads: OrgPerson[]; members: OrgPerson[]; bots: OrgBot[] };

/** The team as a chart: the leads first, then everyone else, with the bots and the hands each one may tag. */
export function orgChart(roster: readonly RosterMember[], bots: readonly BotSummary[]): OrgChartData {
  const people: OrgPerson[] = roster
    .map((m) => ({ actorId: m.actorId, name: m.displayName, role: m.role, tags: m.tags, lead: m.role === 'lead' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    leads: people.filter((p) => p.lead),
    members: people.filter((p) => !p.lead),
    bots: bots
      .map((b) => ({ slug: b.slug, name: b.name, role: b.role, mayTag: b.mayTag }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * How one `handover.mayTag` entry reads in the chart: a bot by its slug, a person by `person:<id>`, or a role by the tag's name (a
 * `BOT.md` writes `reviewer`, and the handoff check matches the person's `role:reviewer`). An entry that names nobody on the team today
 * still shows — the loader kept it, and the chart must not hide a move that will be refused.
 */
export function mayTagLabel(tag: string, people: readonly OrgPerson[], bots: readonly OrgBot[]): string {
  if (tag.startsWith('person:')) return people.find((p) => p.actorId === tag.slice('person:'.length))?.name ?? tag;
  const bot = bots.find((b) => b.slug === tag);
  if (bot) return bot.name;
  if (tag.startsWith('role:')) return tag.slice('role:'.length);
  return tag;
}

/** Whether a `mayTag` entry names anyone on the team today: the chart marks the ones that do not. */
export function mayTagResolves(tag: string, people: readonly OrgPerson[], bots: readonly OrgBot[]): boolean {
  if (tag.startsWith('person:')) return people.some((p) => p.actorId === tag.slice('person:'.length));
  if (bots.some((b) => b.slug === tag)) return true;
  const role = tag.startsWith('role:') ? tag : `role:${tag}`;
  return people.some((p) => p.tags.includes(role));
}
