import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BoardId, ChannelId, EnvironmentId, GoalId, HandoffId, MessageId, RunnerId, TaskClaimId, TaskEventId, TaskId, TeamId, WorkspaceId } from '../ids.ts';
import { JsonObject } from './kernel.ts';

// Phase 6 task substrate (SPEC §8, PLAN A.6). Every enum here matches a CHECK of the tasks plugin's migration 0001_tasks.sql;
// the enum columns are listed in the kernel's schema-enums map, so SQL and Zod cannot drift.

/** The five states of a card. `waiting_on_person` is the one state a bot may not leave by itself. */
export const TaskState = z.enum(['open', 'in_progress', 'verify', 'waiting_on_person', 'done']);
export type TaskState = z.infer<typeof TaskState>;

/**
 * What kind of work the card is. A `code` card may not reach `done` without a `testedSha` (the route and the database both say so);
 * content, ops and other work have nothing to test a commit against, so they carry none.
 */
export const TaskKind = z.enum(['code', 'content', 'ops', 'other']);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskPriority = z.enum(['low', 'normal', 'high']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** How a card moved between owners: to a bot (a handover) or to a person (a hand-back or an escalation). */
export const HandoffMode = z.enum(['bot', 'person']);
export type HandoffMode = z.infer<typeof HandoffMode>;

/** One line of the card's history. `state_changed` carries `from` and `to` in `data`. */
export const TaskEventType = z.enum([
  'created',
  'claimed',
  'released',
  'state_changed',
  'handed_off',
  'completed',
  'reworked',
  'deployed',
  /** The new owner of a card could not be woken (`data.reason` says why); the card was handed over all the same. */
  'not_woken',
  /** A pull request was opened for the card (`data` has its number, address and the tested commit); the card waits for a person to merge it. */
  'pull_request_opened',
  /** The pull request was closed without a merge (`data.reason`); the card went back to its owner. A merge is a `completed` line with `data.mergeSha`. */
  'pull_request_closed',
  /** The description changed: its owner rewrote it, or a person ticked a checklist box (`data.tick` has the box's number and new state). `data` has the lengths before and after and a sha256 of the new text, never the text. */
  'described',
]);
export type TaskEventType = z.infer<typeof TaskEventType>;

/** A goal: a line of work several cards belong to. `done` and `dropped` are final (the card states are unaffected). */
export const GoalStatus = z.enum(['open', 'done', 'dropped']);
export type GoalStatus = z.infer<typeof GoalStatus>;

/** The most steps a goal's plan holds (matches the CHECK of tasks migration 0016_goal_plan.sql). */
export const MAX_GOAL_STEPS = 12;

/**
 * Which of a goal's cards a plan step is worked out from: `plan` (the card the plan is written and reviewed on), `work` (the one card that
 * travels the chain of bots; the default) and `publish` (the card that opens the pull request). See `goalSteps` in tasks/goal-steps.ts.
 */
export const GoalCardRef = z.enum(['plan', 'work', 'publish']);
export type GoalCardRef = z.infer<typeof GoalCardRef>;

/** One step of a goal's plan: what it is, the bots (by slug) that do it and what done looks like. Whether it is done is worked out from the cards, never stored. */
export const GoalStep = z.strictObject({
  title: z.string().trim().min(1).max(120),
  bots: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(64)).min(1).max(3),
  cardRef: GoalCardRef.optional(),
  done: z.string().trim().min(1).max(300),
});
export type GoalStep = z.infer<typeof GoalStep>;

export const Goal = z.object({
  id: GoalId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  /** The short number within the team: goal 27 is shown as `G-27`. Given by the database, never chosen. */
  number: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  status: GoalStatus,
  /** What the goal may cost, in US dollars; shown beside the spend, never enforced. */
  budgetUsd: z.number().min(0).nullable(),
  /** The team channel and the thread (its first message) the goal was given in; null for a goal made on the Goals API. */
  channelId: ChannelId.nullable(),
  threadRootId: MessageId.nullable(),
  steps: z.array(GoalStep).max(MAX_GOAL_STEPS),
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Goal = z.infer<typeof Goal>;

/** One active claim per task (the partial unique index `task_claims_active`); released claims stay as history. */
export const TaskClaim = z.object({
  id: TaskClaimId,
  taskId: TaskId,
  teamId: TeamId,
  actorId: ActorId,
  claimedAt: IsoDateTime,
  /** A claim not released by then is released by the sweep (`tasks.claim-timeout`), never silently kept. */
  expiresAt: IsoDateTime,
  releasedAt: IsoDateTime.nullable(),
});
export type TaskClaim = z.infer<typeof TaskClaim>;

/** Where a card's pull request stands on the project's origin. Matches the CHECK of tasks migration 0010_pull_request.sql. */
/** `withdrawn`: the card moved on by another door (finished, handed over, moved on the board), so the pull request is no longer followed. */
export const TaskPullRequestState = z.enum(['open', 'merged', 'closed', 'withdrawn']);
export type TaskPullRequestState = z.infer<typeof TaskPullRequestState>;

/** The pull request a card waits on: a person merges it in GitHub, and that merge is the approval. */
export const TaskPullRequest = z.object({
  /** The name of the project (repository) it was opened against. */
  project: z.string().min(1).max(61),
  number: z.number().int().positive(),
  url: z.string().max(300),
  state: TaskPullRequestState,
  /** The commit the merge made; null until merged. */
  mergeSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
});
export type TaskPullRequest = z.infer<typeof TaskPullRequest>;

/** One card. `ownerId` is null until somebody claims it; `baseSha` and `testedSha` are the freshness facts. */
export const Task = z.object({
  id: TaskId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  goalId: GoalId.nullable(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000),
  state: TaskState,
  kind: TaskKind,
  priority: TaskPriority,
  /** The actor holding it: a person or a bot. Null when nobody does. */
  ownerId: ActorId.nullable(),
  /** The branch of work the card is about. Two cards may share one branch; one card never has two owners. */
  branch: z.string().min(1).max(200),
  /** The commit the work is based on. A publish or merge is blocked when the branch moved past it (freshness). */
  baseSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  /** The commit that was tested. A `code` card may not be done without one. */
  testedSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  /** The Environment a deploy of this card goes through, when it has one. */
  environmentId: EnvironmentId.nullable(),
  /** The channel board the card is filed on, when it has one (a handover never changes it). */
  boardId: BoardId.nullable(),
  /** The thread the card's conversation lives in. */
  threadRootId: z.uuid().nullable(),
  /** The pull request the card waits on, once the tested branch was published; null for a card with none. */
  pullRequest: TaskPullRequest.nullable(),
  /** Why the card waits on a person, in words; empty otherwise. */
  blockerReason: z.string().max(500),
  /** How many times the work was sent back (bounded by `MAX_REWORKS`). */
  reworkCount: z.number().int().nonnegative(),
  /** How many times the card changed hands (bounded by `MAX_HANDOFFS`). */
  handoffCount: z.number().int().nonnegative(),
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type Task = z.infer<typeof Task>;

export const TaskEvent = z.object({
  id: TaskEventId,
  taskId: TaskId,
  teamId: TeamId,
  /** Who did it; null for the platform (a sweep). */
  actorId: ActorId.nullable(),
  type: TaskEventType,
  /** The details the type needs (`from`/`to` states, the tested sha, the deploy environment); open, never a secret. */
  data: JsonObject,
  createdAt: IsoDateTime,
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/** A handover: who gave the card to whom, with the note the new owner reads first. */
export const Handoff = z.object({
  id: HandoffId,
  taskId: TaskId,
  teamId: TeamId,
  fromActorId: ActorId,
  toActorId: ActorId,
  mode: HandoffMode,
  note: z.string().max(1000),
  /** The approval a `dispatch: strict` handover waited on, if it did. */
  approvalId: z.uuid().nullable(),
  /** When the handover took effect; null while a strict handover waits for its approval. */
  appliedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Handoff = z.infer<typeof Handoff>;

/**
 * An Environment a card deploys into (SPEC §8): `protected` makes every tool tagged with this environment wait for a person who is not the
 * requester; `deployCap` counts deploys per day; `windows` are the hours a deploy may run; `credentialRef` names the stored credential
 * (never the secret).
 */
export const DeployWindow = z.strictObject({
  days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1),
  /** `HH:MM`, inclusive. */
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** `HH:MM`, exclusive; a window that crosses midnight is two windows. */
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type DeployWindow = z.infer<typeof DeployWindow>;

export const Environment = z.object({
  id: EnvironmentId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  /** Every deploy tool tagged with this environment waits for a person other than the requester. */
  protected: z.boolean(),
  /** A second, explicit wait flag (PLAN P6-05) for an environment that is not `protected`. */
  needsApproval: z.boolean(),
  windows: z.array(DeployWindow),
  /** Deploys allowed per day; null for no cap. */
  deployCap: z.number().int().positive().nullable(),
  autoRollback: z.boolean(),
  /** The name of the credential this environment uses; the secret itself is never in this row. */
  credentialRef: z.string().max(200),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Environment = z.infer<typeof Environment>;

/** The id of one column of one board (stable while the column is renamed or moved). A column stored before ids existed uses its state's name. */
export const BoardColumnId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
export type BoardColumnId = z.infer<typeof BoardColumnId>;

/**
 * One column of a board: its own id, the name people see, and the task state it counts as. Two columns of a board may count as the same state
 * (for example "Code review" and "QA" both count as `verify`). `title` is a copy of `name` kept so a tab opened before columns had names still
 * draws its headings; new code reads `name`.
 */
export const BoardColumn = z.strictObject({
  id: BoardColumnId,
  name: z.string().trim().min(1).max(60),
  state: TaskState,
  title: z.string().min(1).max(60),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

/** The most columns a board holds. */
export const MAX_BOARD_COLUMNS = 12;

export const Board = z.object({
  id: BoardId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: z.string().min(1).max(80),
  /** The columns in the order the board draws them (the array order). Ids are unique; two columns may count as the same state. */
  columns: z
    .array(BoardColumn)
    .min(1)
    .max(MAX_BOARD_COLUMNS)
    .refine((cols) => new Set(cols.map((c) => c.id)).size === cols.length, { message: 'column ids must be unique' }),
  /** A `ListTasksQuery`-shaped filter (`goalId`, `ownerId`, `kind`), applied on read. */
  filter: JsonObject,
  /** The channel the board belongs to, or null for a team-level saved view. A channel board shows the cards filed on it, not a filter. */
  channelId: ChannelId.nullable(),
  createdAt: IsoDateTime,
});
export type Board = z.infer<typeof Board>;

/** The name of the board the bots of a channel keep their cards on (capability `boards.ensure`). */
export const BOT_BOARD_NAME = 'Bot Board';

export const RunnerStatus = z.enum(['online', 'offline']);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

/** A capability a runner advertises (`chrome`, `docker`, `gpu`, ...): what a bot's `placement.node` is matched against. */
export const RunnerCapability = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export type RunnerCapability = z.infer<typeof RunnerCapability>;

export const Runner = z.object({
  id: RunnerId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: z.string().min(1).max(80),
  capabilities: z.array(RunnerCapability),
  status: RunnerStatus,
  lastSeenAt: IsoDateTime.nullable(),
  registeredAt: IsoDateTime,
});
export type Runner = z.infer<typeof Runner>;

/** The state machine every move is checked against (a drag and a tool call obey the same table). */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  open: ['in_progress', 'done'],
  in_progress: ['verify', 'waiting_on_person', 'open', 'done'],
  verify: ['in_progress', 'waiting_on_person', 'done'],
  waiting_on_person: ['in_progress', 'verify', 'open'],
  done: [],
};

export const TASK_STATES: readonly TaskState[] = ['open', 'in_progress', 'verify', 'waiting_on_person', 'done'];

/** Rework and handoff bounds (PLAN P6-04): past these, a card needs a person, not another loop. */
export const MAX_REWORKS = 3;
export const MAX_HANDOFFS = 30;

/** The defaults of a new board: the five states, in pipeline order. */
export const DEFAULT_BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: 'open', name: 'Open', state: 'open', title: 'Open' },
  { id: 'in_progress', name: 'In progress', state: 'in_progress', title: 'In progress' },
  { id: 'verify', name: 'Verify', state: 'verify', title: 'Verify' },
  { id: 'waiting_on_person', name: 'Waiting on a person', state: 'waiting_on_person', title: 'Waiting on a person' },
  { id: 'done', name: 'Done', state: 'done', title: 'Done' },
];

/**
 * Reads one stored column leniently. Boards written before columns had ids and names hold `{state, title}`: the id is then the state's name
 * (unique, because the old rule allowed each state once) and the name is the title. Returns null for something that is not a column.
 */
export function readStoredColumn(raw: unknown): BoardColumn | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const state = TaskState.safeParse(c['state']);
  if (!state.success) return null;
  const name = typeof c['name'] === 'string' && c['name'] !== '' ? c['name'] : typeof c['title'] === 'string' ? c['title'] : '';
  if (name === '') return null;
  const id = typeof c['id'] === 'string' && c['id'] !== '' ? c['id'] : state.data;
  return BoardColumn.safeParse({ id, name, state: state.data, title: name }).data ?? null;
}
