import { Rhythm, RhythmRun } from '@manythreads/shared';

export interface RhythmRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  bot_id: string;
  name: string;
  kind: string;
  schedule: string;
  model_alias: string | null;
  effort: string | null;
  contract_path: string | null;
  output_path: string | null;
  enabled: boolean;
  next_run_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toRhythm(r: RhythmRow): Rhythm {
  return Rhythm.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    botId: r.bot_id,
    name: r.name,
    kind: r.kind,
    schedule: r.schedule,
    modelAlias: r.model_alias,
    effort: r.effort,
    contractPath: r.contract_path,
    outputPath: r.output_path,
    enabled: r.enabled,
    nextRunAt: iso(r.next_run_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

export interface RhythmRunRow extends Record<string, unknown> {
  id: string;
  rhythm_id: string;
  team_id: string;
  run_id: string | null;
  task_id: string | null;
  status: string;
  output_path: string | null;
  reason: string;
  started_at: Date;
  ended_at: Date | null;
}

export function toRhythmRun(r: RhythmRunRow): RhythmRun {
  return RhythmRun.parse({
    id: r.id,
    rhythmId: r.rhythm_id,
    teamId: r.team_id,
    runId: r.run_id,
    taskId: r.task_id,
    status: r.status,
    outputPath: r.output_path,
    reason: r.reason,
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
  });
}
