import type { FullReplayEstimate, ReassessmentReason, ReplayCounts, ReplayResult, ReplayState, ReplayVerdict, RunDecisionKind } from '@manythreads/shared';

/*
 * The words of the Replay section and of the "check this again" notices (PLAN P7-07). Pure, so they are tested without a browser. Every sentence a person reads is here or in the
 * component, in plain words: no internal name, no id, no message text.
 */

export const DAY_CHOICES = [7, 14, 30] as const;

export const KIND_WORDS: Record<RunDecisionKind, string> = {
  gate: 'Topic list',
  guard: 'Data check',
  tool: 'Permissions',
};

export const STATE_WORDS: Record<ReplayState, string> = {
  allowed: 'went through',
  redacted: 'went through with parts hidden',
  waits_for_person: 'waited for a person',
  refused: 'was stopped',
};

/** The state a decision would have today, as a person says it. */
export const NOW_STATE_WORDS: Record<ReplayState, string> = {
  allowed: 'would go through',
  redacted: 'would go through with parts hidden',
  waits_for_person: 'would wait for a person',
  refused: 'would be stopped',
};

export const VERDICT_WORDS: Record<ReplayVerdict, string> = {
  same: 'Same',
  tighter: 'Stricter now',
  looser: 'Milder now',
  not_replayed: 'Cannot be checked again',
};

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The one-line result a screen reader hears when the replay finishes. */
export function summaryLine(r: ReplayResult): string {
  if (r.runs === 0) return `There are no runs of this bot in the last ${plural(r.days, 'day', 'days')} that you can replay.`;
  const c = r.counts;
  if (c.total === 0) return `${plural(r.runs, 'run', 'runs')} in the last ${plural(r.days, 'day', 'days')}, but none of them recorded a gate, data check or permission decision to ask again.`;
  const parts: string[] = [];
  if (c.tighter > 0) parts.push(`${plural(c.tighter, 'would be stricter', 'would be stricter')}`);
  if (c.looser > 0) parts.push(`${plural(c.looser, 'would be milder', 'would be milder')}`);
  if (c.notReplayed > 0) parts.push(`${plural(c.notReplayed, 'cannot be checked again', 'cannot be checked again')}`);
  const tail = parts.length === 0 ? 'None of them would come out differently.' : `${parts.join(', ')}; the other ${c.same.toLocaleString('en-US')} come out the same.`;
  return `Checked ${plural(c.total, 'decision', 'decisions')} from ${plural(r.runs, 'run', 'runs')}${r.runsCapped ? ' (the newest ones)' : ''}. ${tail}`;
}

/** One kind's line in the table of counts. */
export function kindLine(c: ReplayCounts): string {
  if (c.total === 0) return 'Nothing recorded';
  const bits = [`${c.same.toLocaleString('en-US')} same`];
  if (c.tighter > 0) bits.push(`${c.tighter.toLocaleString('en-US')} stricter`);
  if (c.looser > 0) bits.push(`${c.looser.toLocaleString('en-US')} milder`);
  if (c.notReplayed > 0) bits.push(`${c.notReplayed.toLocaleString('en-US')} not checked again`);
  return bits.join(', ');
}

/** "was: went through, now: would wait for a person" or the reason it cannot be checked. */
export function changeLine(recorded: ReplayState, now: ReplayState | null): string {
  return now === null ? `Then it ${STATE_WORDS[recorded]}.` : `Then it ${STATE_WORDS[recorded]}. Now it ${NOW_STATE_WORDS[now]}.`;
}

export function dollars(value: number): string {
  return value < 0.1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** What the cost estimate says before anything runs. */
export function estimateLines(e: FullReplayEstimate): string[] {
  const price = e.costUsd !== null ? `The original run cost ${dollars(e.costUsd)}.` : 'No price is recorded for the original run.';
  return [
    e.tokens > 0
      ? `Asking the bot again would use about ${e.tokens.toLocaleString('en-US')} tokens (${e.promptTokens.toLocaleString('en-US')} read, ${e.completionTokens.toLocaleString('en-US')} written). ${price}`
      : `The original run left no count of model use, so there is no number to show. ${price}`,
    `It stops after ${String(e.maxCalls)} model calls whatever happens.`,
    'It runs as a rehearsal: every action that would change something is held back and marked “not really done”.',
  ];
}

export const confirmLabel = (e: FullReplayEstimate): string => (e.tokens > 0 ? `Run it (about ${e.tokens.toLocaleString('en-US')} tokens)` : 'Run it anyway');

/** What a notice is about, as a short label above its sentence. */
export const REASON_WORDS: Record<ReassessmentReason, string> = {
  knowledge_added: 'Knowledge base added',
  knowledge_removed: 'Knowledge base removed',
  runner_added: 'Runner added',
  runner_revoked: 'Runner taken away',
  runner_changed: 'Runner changed',
  connection_added: 'Connection added',
  connection_revoked: 'Connection taken away',
  eval_dropped: 'Test score dropped',
};

export const noticesLine = (n: number): string => (n === 1 ? '1 thing to check again' : `${String(n)} things to check again`);
