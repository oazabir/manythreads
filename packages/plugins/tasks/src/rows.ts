import type { PluginTx } from '@manythreads/sdk';
import { Board, Environment, Goal, Handoff, Runner, Task, TaskEvent } from '@manythreads/shared';

/** A row as the SQL columns come back; PostgreSQL returns timestamptz as Date. */
export interface TaskRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  state: string;
  kind: string;
  priority: string;
  owner_id: string | null;
  branch: string;
  base_sha: string | null;
  tested_sha: string | null;
  environment_id: string | null;
  board_id: string | null;
  thread_root_id: string | null;
  blocker_reason: string;
  rework_count: number;
  handoff_count: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/** The columns every task read returns, in one place so a new column cannot be forgotten in half the routes. */
export const TASK_SELECT = `
  SELECT t.id, t.workspace_id, t.team_id, t.goal_id, t.title, t.description, t.state, t.kind, t.priority, t.owner_id,
         t.branch, t.base_sha, t.tested_sha, t.environment_id, t.board_id, t.thread_root_id, t.blocker_reason, t.rework_count,
         t.handoff_count, t.created_by, t.created_at, t.updated_at, t.completed_at
    FROM app.tasks t`;

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** One place a `tasks` row becomes the shared `Task`; a column that disagrees with the schema is a bug and throws here. */
export function toTask(r: TaskRow): Task {
  return Task.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    goalId: r.goal_id,
    title: r.title,
    description: r.description,
    state: r.state,
    kind: r.kind,
    priority: r.priority,
    ownerId: r.owner_id,
    branch: r.branch,
    baseSha: r.base_sha,
    testedSha: r.tested_sha,
    environmentId: r.environment_id,
    boardId: r.board_id,
    threadRootId: r.thread_root_id,
    blockerReason: r.blocker_reason,
    reworkCount: r.rework_count,
    handoffCount: r.handoff_count,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    completedAt: iso(r.completed_at),
  });
}

export interface GoalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  title: string;
  description: string;
  status: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export function toGoal(r: GoalRow): Goal {
  return Goal.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    title: r.title,
    description: r.description,
    status: r.status,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

export interface TaskEventRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  team_id: string;
  actor_id: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}

export function toTaskEvent(r: TaskEventRow): TaskEvent {
  return TaskEvent.parse({
    id: r.id,
    taskId: r.task_id,
    teamId: r.team_id,
    actorId: r.actor_id,
    type: r.type,
    data: r.data,
    createdAt: iso(r.created_at),
  });
}

export interface HandoffRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  team_id: string;
  from_actor_id: string;
  to_actor_id: string;
  mode: string;
  note: string;
  approval_id: string | null;
  applied_at: Date | null;
  created_at: Date;
}

export function toHandoff(r: HandoffRow): Handoff {
  return Handoff.parse({
    id: r.id,
    taskId: r.task_id,
    teamId: r.team_id,
    fromActorId: r.from_actor_id,
    toActorId: r.to_actor_id,
    mode: r.mode,
    note: r.note,
    approvalId: r.approval_id,
    appliedAt: iso(r.applied_at),
    createdAt: iso(r.created_at),
  });
}

export interface EnvironmentRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  protected: boolean;
  needs_approval: boolean;
  windows: Array<{ days: string[]; from: string; to: string }>;
  deploy_cap: number | null;
  auto_rollback: boolean;
  credential_ref: string;
  created_at: Date;
  updated_at: Date;
}

export function toEnvironment(r: EnvironmentRow): Environment {
  return Environment.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    protected: r.protected,
    needsApproval: r.needs_approval,
    windows: r.windows ?? [],
    deployCap: r.deploy_cap,
    autoRollback: r.auto_rollback,
    credentialRef: r.credential_ref,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

export interface BoardRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  columns: Array<{ state: string; title: string }>;
  filter: Record<string, unknown>;
  channel_id: string | null;
  created_at: Date;
}

export function toBoard(r: BoardRow): Board {
  return Board.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    columns: r.columns ?? [],
    filter: r.filter ?? {},
    channelId: r.channel_id,
    createdAt: iso(r.created_at),
  });
}

export interface RunnerRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  capabilities: string[];
  status: string;
  last_seen_at: Date | null;
  registered_at: Date;
}

export function toRunner(r: RunnerRow): Runner {
  return Runner.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    capabilities: r.capabilities ?? [],
    status: r.status,
    lastSeenAt: iso(r.last_seen_at),
    registeredAt: iso(r.registered_at),
  });
}

/** The team of a slug, or a 403/404 exactly as `requireTeam` answers. Re-exported here so every route file has one import. */
export { requireTeam, requireManage } from '@manythreads/sdk';

/** The actor's kind and ref, for a route that must treat bots and people differently (a bot's `mayTag`). */
export async function actorOf(tx: PluginTx, actorId: string): Promise<{ kind: string; ref_id: string; name: string } | null> {
  const row = (
    await tx.query<{ kind: string; ref_id: string; name: string }>(
      // Through the door: `app.actors` shows a person only their own row, so another actor is resolved as the system.
      `SELECT o_kind AS kind, o_ref_id AS ref_id, o_name AS name FROM app.tasks_actor_of($1::uuid)`,
      [actorId],
    )
  ).rows[0];
  return row ?? null;
}
