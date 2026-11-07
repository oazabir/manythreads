import {
  PERSONAL_ROUTINE_STOP_WORDS,
  ROUTINE_SOURCE_LABELS,
  type PersonalRoutine,
  type PersonalRoutineRun,
  type RoutineLimits,
  type RoutineOutputMode,
  type RoutineQuietHours,
  type RoutineSource,
} from '@manythreads/shared';

/*
 * The words of the routines screens: what a routine's row says about itself, in the plain sentences a person reads. Pure functions, so the wording is
 * tested without a screen.
 */

/** The time zone this browser is in; `UTC` when it cannot tell. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A problem with a time zone name, or null when the browser knows it. The server checks again. */
export function timeZoneProblem(name: string): string | null {
  const zone = name.trim();
  if (zone === '') return 'Write a time zone such as Asia/Dubai.';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return null;
  } catch {
    return 'That time zone is not one I know. Use a name such as Asia/Dubai.';
  }
}

export type RoutineLook = { tone: 'ok' | 'warn' | 'idle'; label: 'On' | 'Paused' | 'Stopped' };

/** Stopped (by the platform, with a reason) is not the same as paused (by the person). */
export function routineLook(r: Pick<PersonalRoutine, 'enabled' | 'stoppedReason'>): RoutineLook {
  if (r.stoppedReason) return { tone: 'warn', label: 'Stopped' };
  return r.enabled ? { tone: 'ok', label: 'On' } : { tone: 'idle', label: 'Paused' };
}

/** Why the platform stopped a routine, as one sentence. Null when it was not stopped. */
export function stopSentence(r: Pick<PersonalRoutine, 'stoppedReason'>): string | null {
  return r.stoppedReason ? `This routine was turned off because ${PERSONAL_ROUTINE_STOP_WORDS[r.stoppedReason]}.` : null;
}

/** Turning a stopped routine back on only helps when the reason is gone; the server checks and says so. The button says what it does. */
export const turnOnLabel = (r: Pick<PersonalRoutine, 'stoppedReason'>): string => (r.stoppedReason ? 'Turn back on' : 'Turn on');

export function lastRunSentence(run: PersonalRoutine['lastRun']): string {
  if (!run) return 'It has not run yet.';
  if (run.status === 'failed') return run.reason ? `The last run did not finish: ${run.reason}` : 'The last run did not finish.';
  if (run.status === 'running' || run.status === 'queued') return 'It is running now.';
  return 'The last run finished.';
}

const SOURCE_PHRASE: Record<RoutineSource, string> = {
  mail: 'your mail',
  calendar: 'your calendar',
  mentions: 'mentions of you',
  threads: 'threads waiting on you',
  approvals: 'your approvals',
  cards: 'your cards',
  meetings: 'your meeting notes',
  notes: 'your notes',
  memory: 'your memory',
  knowledge: 'your knowledge bases',
  action_items: 'your action items',
};

export function sourcesSentence(sources: readonly RoutineSource[]): string {
  if (sources.length === 0) return 'It does not look at anything of yours.';
  return `It looks at ${sources.map((s) => SOURCE_PHRASE[s]).join(', ')}.`;
}

export const sourceLabel = (s: RoutineSource): string => ROUTINE_SOURCE_LABELS[s];

const MODE_WORDS: Record<RoutineOutputMode, string> = {
  replace: 'Replaces the file each time',
  append: 'Adds to the end of the file each time',
  create: 'Makes a new file each time',
};
export const outputModeLabel = (m: RoutineOutputMode): string => MODE_WORDS[m];
export const OUTPUT_MODES: readonly RoutineOutputMode[] = ['replace', 'append', 'create'];

/** The run's sources, counted per kind ("mail 4, calendar 2"); never their text. */
export function sourcesUsedSentence(run: Pick<PersonalRoutineRun, 'sourcesUsed'>): string {
  if (run.sourcesUsed.length === 0) return 'It did not read anything.';
  const counts = new Map<string, number>();
  for (const s of run.sourcesUsed) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  return `It read ${[...counts].map(([type, n]) => `${type.replace(/_/g, ' ')} ${n}`).join(', ')}.`;
}

export const runStatusLabel = (status: PersonalRoutineRun['status']): string =>
  status === 'done' ? 'Finished' : status === 'failed' ? 'Did not finish' : status === 'running' ? 'Running' : 'Waiting to start';

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The spending allowance, in words: used so far this month and what is left. */
export function allowanceSentence(l: Pick<RoutineLimits, 'spentUsd' | 'monthlyCapUsd'>): string {
  if (l.monthlyCapUsd <= 0) return 'Your routines have no spending allowance, so none of them can run.';
  const left = Math.max(0, l.monthlyCapUsd - l.spentUsd);
  return `${usd(l.spentUsd)} of your ${usd(l.monthlyCapUsd)} allowance used this month, ${usd(left)} left. A routine stops when it is used up.`;
}

/** 0 to 100, for the allowance bar. */
export const allowancePercent = (l: Pick<RoutineLimits, 'spentUsd' | 'monthlyCapUsd'>): number =>
  l.monthlyCapUsd <= 0 ? 100 : Math.min(100, Math.round((l.spentUsd / l.monthlyCapUsd) * 100));

export const countSentence = (l: Pick<RoutineLimits, 'used' | 'maxRoutines'>): string => `${l.used} of ${l.maxRoutines} routines.`;

/** The line under the limits: what a single routine is held to. */
export const limitsSentence = (l: Pick<RoutineLimits, 'minIntervalMinutes' | 'runToolCalls'>): string =>
  `A routine runs at most once every ${l.minIntervalMinutes} minutes and makes at most ${l.runToolCalls} tool calls in one run.`;

export function quietHoursProblem(from: string, to: string): string | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(from) || !time.test(to)) return 'Write both times like 22:00.';
  if (from === to) return 'The quiet hours need two different times.';
  return null;
}

export function quietHoursSentence(q: RoutineQuietHours | null): string {
  return q ? `Nothing starts between ${q.from} and ${q.to}. A routine due then runs when the quiet hours end.` : 'No quiet hours: a routine runs when it is due.';
}

/** Whether "Run now" is offered: the routine is on and was not stopped. */
export const canRunNow = (r: Pick<PersonalRoutine, 'enabled' | 'stoppedReason'>): boolean => r.enabled && !r.stoppedReason;

/** Where a routine writes, in words: the default (`Routines/<name>/output.md`) is "a folder of its own under Routines"; any other place is named by its folder. */
export function outputPlaceWords(path: string): string {
  const p = path.trim();
  const own = /^Routines\/[^/]+\/output\.md$/.exec(p);
  if (own) return 'Saved in your files, in the Routines folder, in a folder named after this routine.';
  const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  return folder === '' ? 'Saved in your files.' : `Saved in your files, in ${folder}.`;
}
