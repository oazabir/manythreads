import { CreateRhythmRequest, nextCronRun, type RhythmEffort, type RhythmKind } from '@manythreads/shared';

/*
 * The pure half of the Rhythms tab (PLAN P6-08, SPEC §6.5): the draft a form holds, the request it becomes, and what the screen can say
 * about a cron expression while it is being typed. The schedule grammar is the shared parser — the same code the plugin stores and the
 * scheduler ticks with — so the form can never accept an expression the server would refuse.
 */

export const RHYTHM_KIND_LABEL: Readonly<Record<RhythmKind, string>> = {
  heartbeat: 'Heartbeat',
  routine: 'Routine',
  task: 'Task',
};

export const RHYTHM_KIND_BLURB: Readonly<Record<RhythmKind, string>> = {
  heartbeat: 'A scheduled prompt. The bot decides what to do with it.',
  routine: 'A scheduled job with a contract under routines/ and a page it writes.',
  task: 'One prompt, one run: it opens a card on the board.',
};

export type RhythmDraft = {
  botSlug: string;
  name: string;
  kind: RhythmKind;
  schedule: string;
  /** Empty means "the bot's own alias". */
  modelAlias: string;
  /** Empty means "the runtime's default effort". */
  effort: '' | RhythmEffort;
  contractPath: string;
  outputPath: string;
  enabled: boolean;
};

/** A new rhythm: hourly heartbeat by default, which fires and is safe to edit before saving. */
export const emptyRhythm = (botSlug = ''): RhythmDraft => ({
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
export type RhythmBuild = { ok: true; body: CreateRhythmRequest } | { ok: false; message: string };

export function rhythmRequest(draft: RhythmDraft): RhythmBuild {
  const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  const parsed = CreateRhythmRequest.safeParse({
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
  return { ok: false, message: issue?.message ?? 'The rhythm is not complete.' };
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
