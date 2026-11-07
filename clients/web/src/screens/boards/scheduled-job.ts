import { CreateScheduledJobRequest, nextCronRun, type ScheduledJobEffort, type ScheduledJobKind } from '@manythreads/shared';

/*
 * The pure half of the Jobs tab (PLAN P6-08, SPEC §6.5): the draft a form holds, the request it becomes, and what the screen can say
 * about a cron expression while it is being typed. The schedule grammar is the shared parser — the same code the plugin stores and the
 * scheduler ticks with — so the form can never accept an expression the server would refuse.
 */

export const SCHEDULED_JOB_KIND_LABEL: Readonly<Record<ScheduledJobKind, string>> = {
  heartbeat: 'Heartbeat',
  routine: 'Routine',
  task: 'Task',
};

export const SCHEDULED_JOB_KIND_BLURB: Readonly<Record<ScheduledJobKind, string>> = {
  heartbeat: 'A scheduled prompt. The bot decides what to do with it.',
  routine: 'A scheduled job with a contract under routines/ and a page it writes.',
  task: 'One prompt, one run: it opens a card on the board.',
};

export type ScheduledJobDraft = {
  botSlug: string;
  name: string;
  kind: ScheduledJobKind;
  schedule: string;
  /** Empty means "the bot's own alias". */
  modelAlias: string;
  /** Empty means "the runtime's default effort". */
  effort: '' | ScheduledJobEffort;
  contractPath: string;
  outputPath: string;
  enabled: boolean;
};

/** A new scheduled job: hourly heartbeat by default, which fires and is safe to edit before saving. */
export const emptyScheduledJob = (botSlug = ''): ScheduledJobDraft => ({
  botSlug,
  name: '',
  kind: 'heartbeat',
  schedule: '0 * * * *',
  modelAlias: '',
  effort: '',
  contractPath: '',
  outputPath: '',
  enabled: true,
});

/** What the form sends: the shared schema applies its defaults, and an empty optional field is `null`, never an empty string. */
export type ScheduledJobBuild = { ok: true; body: CreateScheduledJobRequest } | { ok: false; message: string };

export function scheduledJobRequest(draft: ScheduledJobDraft): ScheduledJobBuild {
  const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  const parsed = CreateScheduledJobRequest.safeParse({
    botSlug: draft.botSlug,
    name: draft.name,
    kind: draft.kind,
    schedule: draft.schedule,
    modelAlias: blank(draft.modelAlias),
    effort: draft.effort === '' ? null : draft.effort,
    contractPath: draft.kind === 'routine' ? blank(draft.contractPath) : null,
    outputPath: draft.kind === 'routine' ? blank(draft.outputPath) : null,
    enabled: draft.enabled,
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: issue?.message ?? 'The job is not complete.' };
}

const TIME = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

/**
 * What the form says under the schedule field: the next time it fires, or why it never will. `now` is passed in so the sentence is a
 * function of its inputs (the tests do not depend on the wall clock).
 */
export function cronNote(expr: string, now: Date): string {
  try {
    const next = nextCronRun(expr, now);
    if (next === null) return 'This schedule never fires.';
    return `Next run ${TIME.format(next)} UTC, then every time it matches after that.`;
  } catch (err) {
    return err instanceof Error ? err.message : 'The schedule is not a cron expression.';
  }
}

/** The plain sentence of a run's status for the ledger. */
export const RUN_STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
};

// ---- the three tiles of an empty Jobs page (PLAN P21-15) --------------------------------------------------------

export type JobTile = {
  kind: ScheduledJobKind;
  /** What the kind does, in one line of plain words. */
  line: string;
  /** An example in one sentence, in the words a person would use. */
  example: string;
  /** What the form starts with when the tile's button is pressed; the person edits it before saving. */
  preset: Pick<ScheduledJobDraft, 'name' | 'schedule' | 'contractPath' | 'outputPath'>;
};

export const JOB_TILES: readonly JobTile[] = [
  {
    kind: 'heartbeat',
    line: 'A prompt sent to a bot on a schedule. The bot decides what to do with it.',
    example: 'Every weekday at 9, ask the reviewer whether anything is waiting on a person.',
    preset: { name: 'Weekday check', schedule: '0 9 * * mon-fri', contractPath: '', outputPath: '' },
  },
  {
    kind: 'routine',
    line: 'A saved set of steps a bot follows each time, ending in a page it writes.',
    example: 'Every Monday at 8, write last week’s numbers into a page the team can read.',
    preset: { name: 'Weekly numbers', schedule: '0 8 * * mon', contractPath: 'routines/weekly.yaml', outputPath: 'pages/reports/weekly.md' },
  },
  {
    kind: 'task',
    line: 'One request that opens a card on the board each time it fires.',
    example: 'Every Friday at 16:00, open a card to tidy up the board before the weekend.',
    preset: { name: 'Friday tidy-up', schedule: '0 16 * * fri', contractPath: '', outputPath: '' },
  },
];

/** The form a tile opens: the blank draft of the first bot, with the tile's kind and example filled in. */
export const tileDraft = (tile: JobTile, botSlug: string): ScheduledJobDraft => ({ ...emptyScheduledJob(botSlug), kind: tile.kind, ...tile.preset });
