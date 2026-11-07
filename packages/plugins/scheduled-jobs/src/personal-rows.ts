import { PersonalRoutine, PersonalRoutineRun, cronToWords } from '@manythreads/shared';

// The plugin's mapper for a personal routine and its firings. A personal routine is a row of `scheduled_jobs` with an owner and no team.

export type PersonalJobRow = {
  id: string;
  workspace_id: string;
  owner_person_id: string;
  asker_person_id: string;
  bot_id: string | null;
  bot_slug: string | null;
  bot_name: string | null;
  name: string;
  slug: string;
  words: string;
  schedule: string;
  schedule_words: string;
  time_zone: string;
  sources: string[];
  contract_path: string;
  output_path: string;
  output_mode: string;
  enabled: boolean;
  next_run_at: Date | null;
  stopped_reason: string | null;
  stopped_at: Date | null;
  stop_told_at: Date | null;
  recipe_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  lr_id: string | null;
  lr_status: string | null;
  lr_started_at: Date | null;
  lr_ended_at: Date | null;
  lr_reason: string | null;
};

/** The columns a personal routine is read with: the job, its bot's names and its newest firing. */
export const PERSONAL_JOB_SELECT = `
  SELECT j.id, j.workspace_id, j.owner_person_id, j.asker_person_id, j.bot_id, b.slug AS bot_slug, b.name AS bot_name, j.name, j.slug, j.words, j.schedule,
         j.schedule_words, j.time_zone, j.sources, j.contract_path, j.output_path, j.output_mode, j.enabled, j.next_run_at, j.stopped_reason, j.stopped_at,
         j.stop_told_at, j.recipe_id, j.created_by, j.created_at, j.updated_at,
         lr.id AS lr_id, lr.status AS lr_status, lr.started_at AS lr_started_at, lr.ended_at AS lr_ended_at, lr.reason AS lr_reason
    FROM app.scheduled_jobs j
    LEFT JOIN app.bots b ON b.id = j.bot_id
    LEFT JOIN LATERAL (SELECT r.id, r.status, r.started_at, r.ended_at, r.reason FROM app.scheduled_job_runs r WHERE r.scheduled_job_id = j.id ORDER BY r.id DESC LIMIT 1) lr ON true`;

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toPersonalRoutine(r: PersonalJobRow, now: Date = new Date()): PersonalRoutine {
  return PersonalRoutine.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    ownerPersonId: r.owner_person_id,
    askerPersonId: r.asker_person_id,
    botId: r.bot_id,
    botSlug: r.bot_slug,
    botName: r.bot_name,
    name: r.name,
    slug: r.slug,
    words: r.words,
    schedule: r.schedule,
    scheduleWords: r.schedule_words || cronToWords(r.schedule, r.time_zone, now),
    timeZone: r.time_zone,
    sources: r.sources,
    contractPath: r.contract_path,
    outputPath: r.output_path,
    outputMode: r.output_mode,
    enabled: r.enabled,
    nextRunAt: iso(r.next_run_at),
    stoppedReason: r.stopped_reason,
    stoppedAt: iso(r.stopped_at),
    lastRun:
      r.lr_id === null
        ? null
        : { id: r.lr_id, status: r.lr_status, startedAt: iso(r.lr_started_at), endedAt: iso(r.lr_ended_at), reason: r.lr_reason ?? '' },
    recipeId: r.recipe_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

export interface PersonalRunRow extends Record<string, unknown> {
  id: string;
  scheduled_job_id: string;
  run_id: string | null;
  status: string;
  output_path: string | null;
  reason: string;
  started_at: Date;
  ended_at: Date | null;
  sources_used: unknown;
}

export function toPersonalRun(r: PersonalRunRow): PersonalRoutineRun {
  return PersonalRoutineRun.parse({
    id: r.id,
    scheduledJobId: r.scheduled_job_id,
    runId: r.run_id,
    status: r.status,
    outputPath: r.output_path,
    reason: r.reason,
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    sourcesUsed: Array.isArray(r.sources_used) ? r.sources_used : [],
  });
}
