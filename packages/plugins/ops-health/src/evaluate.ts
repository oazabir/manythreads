import type { OpsHealthCheck, OpsHealthSnapshot } from '@manythreads/shared';
import type { Thresholds } from './config.ts';

// The health watcher's judgement, with no database and no clock of its own: a snapshot, the limits and what the last round remembered go
// in; the checks to show, what to remember next and the changes worth telling anybody about come out.
//
// Each check is `value > threshold` for one number. A check that trips is reported once (`breached`). It is reported fixed (`recovered`) only
// after `recoverRounds` rounds in a row back inside its limit, so a number hovering at the line makes one message, not a stream. A volume must
// also fall 2 points under the line before a round counts as clear.

export interface CheckState {
  breached: boolean;
  /** When the current episode began (ISO); null while fine. */
  since: string | null;
  /** Rounds in a row inside the limit while breached. */
  clearRounds: number;
  /** For a check about how long a condition has lasted: when the condition began (ISO), null while it does not hold. */
  conditionSince: string | null;
}

export type StateMap = Readonly<Record<string, CheckState>>;

export interface Transition {
  check: string;
  label: string;
  state: 'breached' | 'recovered';
  value: number;
  threshold: number;
  unit: 'percent' | 'seconds';
  since: string;
}

export interface Evaluation {
  checks: OpsHealthCheck[];
  next: StateMap;
  transitions: Transition[];
}

interface CheckSpec {
  name: string;
  label: string;
  unit: 'percent' | 'seconds';
  threshold: number;
  /** How far under the threshold the value must fall before a round counts as clear. */
  margin: number;
  /** The measurement, or null when the section it reads is missing. For a duration check, the condition instead. */
  value: number | null;
  /** A check about how long something has lasted: `condition` says whether it holds now, the value is then the time it has held. */
  condition?: boolean | null;
}

const FRESH: CheckState = { breached: false, since: null, clearRounds: 0, conditionSince: null };

const VOLUME_LABEL: Record<string, string> = { blobs: 'Attachment store', repos: 'Team repositories' };
export const volumeLabel = (name: string): string => VOLUME_LABEL[name] ?? `Volume ${name}`;

const CHECK_LABEL: Record<string, string> = {
  outbox_lag: 'Outbox lag',
  job_age: 'Oldest waiting job',
  run_slots: 'Bot run slots full',
  approval_age: 'Oldest pending approval',
  budget_burn: 'Fullest model budget',
  db_connections: 'Database connections in use',
};

/** The label of a check by its name (the mail job rebuilds its text from this, never from a payload); null for a name no check has. */
export function checkLabel(name: string): string | null {
  if (name.startsWith('volume_')) return `${volumeLabel(name.slice('volume_'.length))} used`;
  return CHECK_LABEL[name] ?? null;
}

function specsOf(s: OpsHealthSnapshot, t: Thresholds): CheckSpec[] {
  const specs: CheckSpec[] = [
    { name: 'outbox_lag', label: 'Outbox lag', unit: 'seconds', threshold: t.outboxLagSeconds, margin: 0, value: s.outbox ? s.outbox.oldestAgeSeconds : null },
    { name: 'job_age', label: 'Oldest waiting job', unit: 'seconds', threshold: t.jobAgeSeconds, margin: 0, value: s.jobs ? s.jobs.oldestReadyAgeSeconds : null },
    {
      name: 'run_slots',
      label: 'Bot run slots full',
      unit: 'seconds',
      threshold: t.runSlotsSeconds,
      margin: 0,
      value: 0,
      condition: s.runs ? s.runs.slotsUsed >= s.runs.slotsLimit && s.runs.queued > 0 : null,
    },
    { name: 'approval_age', label: 'Oldest pending approval', unit: 'seconds', threshold: t.approvalAgeSeconds, margin: 0, value: s.approvals ? s.approvals.oldestPendingAgeSeconds : null },
    { name: 'budget_burn', label: 'Fullest model budget', unit: 'percent', threshold: t.budgetPercent, margin: 0, value: s.budgets ? s.budgets.maxBurnPercent : null },
    {
      name: 'db_connections',
      label: 'Database connections in use',
      unit: 'percent',
      threshold: t.dbConnectionsPercent,
      margin: 0,
      value: s.database && s.database.connectionsMax > 0 ? (s.database.connectionsUsed / s.database.connectionsMax) * 100 : null,
    },
  ];
  for (const v of s.volumes) {
    specs.push({ name: `volume_${v.name}`, label: `${volumeLabel(v.name)} used`, unit: 'percent', threshold: t.volumePercent, margin: 2, value: v.usedPercent });
  }
  return specs;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** One round of judgement. `recoverRounds` is how many clear rounds in a row end an episode. */
export function evaluate(snapshot: OpsHealthSnapshot, thresholds: Thresholds, prev: StateMap, now: Date, recoverRounds: number): Evaluation {
  const checks: OpsHealthCheck[] = [];
  const next: Record<string, CheckState> = {};
  const transitions: Transition[] = [];
  const stamp = now.toISOString();

  for (const spec of specsOf(snapshot, thresholds)) {
    const before = prev[spec.name] ?? FRESH;
    const known = spec.condition !== null && spec.value !== null;
    if (!known) {
      // The section could not be read this round: say nothing new, keep what was known.
      next[spec.name] = before;
      checks.push({ name: spec.name, label: spec.label, unit: spec.unit, value: null, threshold: spec.threshold, breached: before.breached, since: before.since });
      continue;
    }

    let conditionSince = before.conditionSince;
    let value = spec.value as number;
    if (spec.condition !== undefined) {
      if (spec.condition) {
        conditionSince = conditionSince ?? stamp;
        value = Math.max(0, (now.getTime() - Date.parse(conditionSince)) / 1000);
      } else {
        conditionSince = null;
        value = 0;
      }
    }
    value = round(value);

    // 0 switches the check off: it never trips, and an episode that was open ends quietly.
    const over = spec.threshold > 0 && value > spec.threshold;
    let state: CheckState = { ...before, conditionSince };
    if (!state.breached) {
      if (over) {
        state = { breached: true, since: stamp, clearRounds: 0, conditionSince };
        transitions.push({ check: spec.name, label: spec.label, state: 'breached', value, threshold: spec.threshold, unit: spec.unit, since: stamp });
      }
    } else if (spec.threshold === 0) {
      state = { breached: false, since: null, clearRounds: 0, conditionSince };
    } else {
      const clear = value <= spec.threshold - spec.margin;
      const rounds = clear ? state.clearRounds + 1 : 0;
      if (rounds >= recoverRounds) {
        transitions.push({ check: spec.name, label: spec.label, state: 'recovered', value, threshold: spec.threshold, unit: spec.unit, since: state.since ?? stamp });
        state = { breached: false, since: null, clearRounds: 0, conditionSince };
      } else {
        state = { ...state, clearRounds: rounds };
      }
    }
    next[spec.name] = state;
    checks.push({ name: spec.name, label: spec.label, unit: spec.unit, value, threshold: spec.threshold, breached: state.breached, since: state.since });
  }
  return { checks, next, transitions };
}

/** `95 s`, `12 min`, `26 h`, `3.5 d`; a percent as `91 %`. */
export function formatValue(unit: 'percent' | 'seconds', value: number): string {
  if (unit === 'percent') return `${Math.round(value * 10) / 10} %`;
  if (value < 120) return `${Math.round(value)} s`;
  if (value < 2 * 3600) return `${Math.round(value / 60)} min`;
  if (value < 2 * 86400) return `${Math.round((value / 3600) * 10) / 10} h`;
  return `${Math.round((value / 86400) * 10) / 10} d`;
}

const WHAT: Record<string, string> = {
  outbox_lag: 'The oldest change waiting to be passed on to the rest of the system has waited',
  job_age: 'The oldest background job waiting for a worker has waited',
  run_slots: 'Every slot for running bots is taken, and more runs are waiting, for',
  approval_age: 'The oldest approval nobody has decided has waited',
  budget_burn: 'The fullest model budget is used up to',
  db_connections: 'The database has connections open to',
};

/** A plain-language title and detail for a change, used in the mail and the event log. */
export function describeTransition(t: Transition): { title: string; detail: string } {
  const value = formatValue(t.unit, t.value);
  const limit = formatValue(t.unit, t.threshold);
  if (t.state === 'recovered') {
    return { title: `${t.label}: back to normal`, detail: `${t.label} is back inside its limit (${value}, limit ${limit}).` };
  }
  if (t.check.startsWith('volume_')) {
    return { title: `${t.label} is ${value} full`, detail: `${t.label} has passed its limit of ${limit}. Free some space or grow the volume before it fills up.` };
  }
  return { title: `${t.label}: ${value}`, detail: `${WHAT[t.check] ?? `${t.label} is at`} ${value} (limit ${limit}).` };
}
