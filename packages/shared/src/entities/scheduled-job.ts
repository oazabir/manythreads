import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, PersonId, ScheduledJobId, ScheduledJobRunId, RunId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

// Jobs (SPEC §6.5, PLAN P6-08): a prompt on a timer (heartbeat), a contract with a page output (routine), or a recurring task.
// The scheduler runs on the kernel's job queue; `nextRunAt` is what the screen shows and what each tick advances.

export const ScheduledJobKind = z.enum(['heartbeat', 'routine', 'task']);
export type ScheduledJobKind = z.infer<typeof ScheduledJobKind>;

/** `queued` until a worker starts it; then `running`, and `done` or `failed` with a reason. */
export const ScheduledJobRunStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type ScheduledJobRunStatus = z.infer<typeof ScheduledJobRunStatus>;

/** A 5-field cron expression in UTC (`0 9 * * mon-fri`), validated by the shared parser when the scheduled job is created. */
export const CronExpression = z
  .string()
  .trim()
  .regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'a 5-field cron expression in UTC, e.g. "0 9 * * mon-fri"');
export type CronExpression = z.infer<typeof CronExpression>;

export const ScheduledJobEffort = z.enum(['low', 'medium', 'high']);
export type ScheduledJobEffort = z.infer<typeof ScheduledJobEffort>;

export const ScheduledJob = z.object({
  id: ScheduledJobId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  /** The bot that runs it. A scheduled job always runs as a bot, never as the person who created it. */
  botId: BotId,
  name: z.string().min(1).max(80),
  kind: ScheduledJobKind,
  schedule: CronExpression,
  /** Overrides the bot's alias for this scheduled job (`fast` for an hourly heartbeat); null uses the bot's own. */
  modelAlias: z.string().min(1).max(40).nullable(),
  /** `thinking` effort passed to the runtime; null leaves the runtime's default. */
  effort: ScheduledJobEffort.nullable(),
  /** For a routine: the repo path of its contract (`routines/<slug>.yaml`). Null for a heartbeat or a task. */
  contractPath: z.string().min(1).max(300).nullable(),
  /** For a routine: the page the output is written to. */
  outputPath: z.string().min(1).max(300).nullable(),
  enabled: z.boolean(),
  nextRunAt: IsoDateTime.nullable(),
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const ScheduledJobRun = z.object({
  id: ScheduledJobRunId,
  scheduledJobId: ScheduledJobId,
  teamId: TeamId,
  /** The bot run the scheduled job opened, once a runtime opened one. */
  runId: RunId.nullable(),
  /** The task a `task` scheduled job created. */
  taskId: TaskId.nullable(),
  status: ScheduledJobRunStatus,
  /** The page a routine wrote (or was asked to write). */
  outputPath: z.string().nullable(),
  /** Why it failed, or what it did, in one line; empty while it runs. */
  reason: z.string().max(500),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
});
export type ScheduledJobRun = z.infer<typeof ScheduledJobRun>;

// ---- Personal routines (PLAN P20-10 to P20-12, D10) ---------------------------------------------------------------------------------------------
// A personal routine is a scheduled job that belongs to ONE person (`app.scheduled_jobs.owner_person_id`, no team). It runs as a bot, with the owner as the
// asker (set by the platform when the firing is filed, never by a token or the bot), so it reads what its owner may read in a private context and writes only
// into the owner's own space. The words and the contract of a routine are the file `Routines/<slug>/routine.yaml` in the owner's Files, with versions.

/** What a personal routine may be asked to look at. The platform decides what is really readable (the run's spaces); this list only narrows what the routine tells the bot to read. */
export const ROUTINE_SOURCES = ['mail', 'calendar', 'mentions', 'threads', 'approvals', 'cards', 'meetings', 'notes', 'memory', 'knowledge', 'action_items'] as const;
export const RoutineSource = z.enum(ROUTINE_SOURCES);
export type RoutineSource = z.infer<typeof RoutineSource>;

/** The plain label of a source, as the screens say it. */
export const ROUTINE_SOURCE_LABELS: Record<RoutineSource, string> = {
  mail: 'My mail',
  calendar: 'My calendar',
  mentions: 'Mentions of me',
  threads: 'Threads waiting on me',
  approvals: 'My approvals',
  cards: 'My cards',
  meetings: 'My meeting notes',
  notes: 'My notes',
  memory: 'My memory',
  knowledge: 'My knowledge bases',
  action_items: 'My action items',
};

/** The kind of the person's own connection a source needs before it can be read; a source not listed needs none. */
export const ROUTINE_SOURCE_CONNECTION: Partial<Record<RoutineSource, string>> = { mail: 'email', calendar: 'calendar' };

/** Limits every personal routine lives under (the guards of P20-14). The monthly spend cap is a workspace setting; the default is here. */
export const PERSONAL_ROUTINE_LIMITS = {
  maxPerPerson: 20,
  minIntervalMinutes: 15,
  /** Tool calls one firing may make before the gateway turns the next one away. */
  runToolCalls: 40,
  monthlyCapUsdDefault: 5,
  runsPerDay: 96,
} as const;

/** Why a routine was switched off by the platform (one plain direct message is sent with it). */
export const PersonalRoutineStopReason = z.enum(['bot_off', 'bot_gone', 'consent_withdrawn', 'connection_gone', 'owner_deactivated', 'spend_cap', 'not_a_member']);
export type PersonalRoutineStopReason = z.infer<typeof PersonalRoutineStopReason>;

/** The plain sentence for each stop reason: what the person reads in the direct message and on the routine's row. */
export const PERSONAL_ROUTINE_STOP_WORDS: Record<PersonalRoutineStopReason, string> = {
  bot_off: 'the bot that runs it is turned off',
  bot_gone: 'the bot that runs it is no longer there',
  consent_withdrawn: 'you turned off that bot’s access to your Personal space',
  connection_gone: 'a connection it reads from (your mail or calendar) is no longer connected',
  owner_deactivated: 'your account was deactivated',
  spend_cap: 'it used up your spending allowance for this month',
  not_a_member: 'you are no longer on the team of the bot that runs it',
};

export const RoutineOutputMode = z.enum(['create', 'replace', 'append']);
export type RoutineOutputMode = z.infer<typeof RoutineOutputMode>;

/** A path inside the owner's Personal files, `Routines/morning-brief/output.md`: no `..`, no empty part, under a folder. */
export const PersonalRoutinePath = z
  .string()
  .min(3)
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.endsWith('/'), 'a path has no leading or trailing slash')
  .refine((p) => p.includes('/'), 'a file lives inside a folder')
  .refine((p) => !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'), 'a path has no empty, . or .. part');

/** A personal routine as the screens read it. `roles` of the bot, the schedule in UTC and the same thing in words and in the owner's time zone. */
export const PersonalRoutine = z.object({
  id: ScheduledJobId,
  workspaceId: WorkspaceId,
  ownerPersonId: PersonId,
  /** The asker of every run: always the owner (the column is generated from it, so they cannot differ). */
  askerPersonId: PersonId,
  botId: BotId,
  botSlug: z.string(),
  botName: z.string(),
  name: z.string().min(1).max(80),
  /** The slug of the routine's folder: `Routines/<slug>/`. */
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  /** The sentence the person wrote. */
  words: z.string().max(2000),
  /** A 5-field cron expression in UTC. */
  schedule: CronExpression,
  /** The schedule in plain words in the owner's time zone ("Weekdays at 7:00 AM"). */
  scheduleWords: z.string().max(120),
  timeZone: z.string().min(1).max(64),
  sources: z.array(RoutineSource).max(ROUTINE_SOURCES.length),
  /** `Routines/<slug>/routine.yaml`. */
  contractPath: z.string(),
  /** Where the output goes; always a file of the owner's Personal space. */
  outputPath: z.string(),
  outputMode: RoutineOutputMode,
  enabled: z.boolean(),
  nextRunAt: IsoDateTime.nullable(),
  /** Set when the platform switched the routine off; the person turns it on again from the routine. */
  stoppedReason: PersonalRoutineStopReason.nullable(),
  stoppedAt: IsoDateTime.nullable(),
  lastRun: z
    .object({ id: ScheduledJobRunId, status: ScheduledJobRunStatus, startedAt: IsoDateTime, endedAt: IsoDateTime.nullable(), reason: z.string().max(500) })
    .nullable(),
  /** The recipe this routine was started from (`personal-recipes`), if any. */
  recipeId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PersonalRoutine = z.infer<typeof PersonalRoutine>;

/** One firing of a personal routine, with what it read. */
export const PersonalRoutineRun = z.object({
  id: ScheduledJobRunId,
  scheduledJobId: ScheduledJobId,
  runId: RunId.nullable(),
  status: ScheduledJobRunStatus,
  outputPath: z.string().nullable(),
  reason: z.string().max(500),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  /** The sources the run used, one line each (a count per kind; never their text). */
  sourcesUsed: z.array(z.object({ type: z.string().max(40), ref: z.string().max(200), scope: z.enum(['team', 'channel', 'person']) })).max(50),
});
export type PersonalRoutineRun = z.infer<typeof PersonalRoutineRun>;

/** A cleaned-up time of day, "22:00". */
export const RoutineClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 22:00');
