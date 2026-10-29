import type { OpsHealthCheck, OpsHealthSnapshot } from '@manythreads/shared';

// The Prometheus text format (version 0.0.4) for a snapshot. Labels are only ever a fixed name (a job queue, a volume, a check), never a
// person, a team or an id, so the number of series stays small and the same from one scrape to the next.

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

interface Sample {
  labels?: Readonly<Record<string, string>>;
  value: number;
}

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const formatNumber = (n: number): string => {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? '+Inf' : '-Inf';
  return String(n);
};

class Writer {
  private readonly lines: string[] = [];
  metric(name: string, type: 'gauge' | 'counter', help: string, samples: readonly Sample[]): void {
    if (samples.length === 0) return;
    this.lines.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${type}`);
    for (const s of samples) {
      const labels = s.labels && Object.keys(s.labels).length > 0
        ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`
        : '';
      this.lines.push(`${name}${labels} ${formatNumber(s.value)}`);
    }
  }
  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

const one = (value: number | undefined | null): Sample[] => (value === undefined || value === null ? [] : [{ value }]);

/** Which sections could not be read this pass, as `manythreads_ops_section_ok{section}` (1 read, 0 failed). */
export type SectionStatus = Readonly<Record<string, boolean>>;

export function renderPrometheus(snapshot: OpsHealthSnapshot, checks: readonly OpsHealthCheck[], sections: SectionStatus = {}): string {
  const w = new Writer();
  const { outbox, jobs, runs, approvals, budgets, database } = snapshot;

  w.metric('manythreads_outbox_backlog', 'gauge', 'Events written with a change and not yet delivered to every subscriber.', one(outbox?.backlog));
  w.metric('manythreads_outbox_retrying', 'gauge', 'Undelivered events that have already failed at least once.', one(outbox?.retrying));
  w.metric('manythreads_outbox_oldest_age_seconds', 'gauge', 'Outbox lag: age in seconds of the oldest event that is due and not yet delivered (0 when none).', one(outbox?.oldestAgeSeconds));

  w.metric('manythreads_jobs_ready', 'gauge', 'Background jobs due now and waiting for a worker, all queues.', one(jobs?.ready));
  w.metric('manythreads_jobs_running', 'gauge', 'Background jobs being worked on, all queues.', one(jobs?.running));
  w.metric('manythreads_jobs_dead', 'gauge', 'Background jobs that failed their last attempt and were given up on (read every few minutes).', one(jobs?.dead));
  w.metric('manythreads_jobs_oldest_ready_age_seconds', 'gauge', 'Age in seconds of the oldest due job waiting for a worker (0 when none).', one(jobs?.oldestReadyAgeSeconds));
  w.metric('manythreads_jobs_queue_ready', 'gauge', 'Due jobs waiting for a worker, per queue that has any.', (jobs?.queues ?? []).map((q) => ({ labels: { queue: q.queue }, value: q.ready })));
  w.metric('manythreads_jobs_queue_oldest_age_seconds', 'gauge', 'Age in seconds of the oldest due job, per queue that has any waiting.', (jobs?.queues ?? []).map((q) => ({ labels: { queue: q.queue }, value: q.oldestAgeSeconds })));

  w.metric('manythreads_run_slots_used', 'gauge', 'Bot runs in progress (each holds one slot).', one(runs?.slotsUsed));
  w.metric('manythreads_run_slots_limit', 'gauge', 'Runs allowed at once in one server process.', one(runs?.slotsLimit));
  w.metric('manythreads_runs_queued', 'gauge', 'Bot runs waiting for a free slot.', one(runs?.queued));
  w.metric('manythreads_runs_oldest_queued_age_seconds', 'gauge', 'Age in seconds of the run that has waited longest for a slot (0 when none).', one(runs?.oldestQueuedAgeSeconds));

  w.metric('manythreads_approvals_pending', 'gauge', 'Approvals waiting for a decision.', one(approvals?.pending));
  w.metric('manythreads_approvals_oldest_pending_age_seconds', 'gauge', 'Age in seconds of the approval that has waited longest (0 when none).', one(approvals?.oldestPendingAgeSeconds));

  w.metric('manythreads_budget_limits', 'gauge', 'Model budgets that carry a dollar cap.', one(budgets?.limits));
  w.metric('manythreads_budget_limits_near', 'gauge', 'Model budgets that are at 80 percent or more of their cap in the current window.', one(budgets?.nearLimit));
  w.metric('manythreads_budget_limits_exhausted', 'gauge', 'Model budgets that are used up in the current window.', one(budgets?.exhausted));
  w.metric('manythreads_budget_burn_ratio_max', 'gauge', 'The fullest model budget as a share of its cap (1 = used up).', one(budgets ? budgets.maxBurnPercent / 100 : undefined));

  w.metric('manythreads_db_connections_in_use', 'gauge', 'Client connections open to the database server.', one(database?.connectionsUsed));
  w.metric('manythreads_db_connections_max', 'gauge', 'The database server connection limit.', one(database?.connectionsMax));

  w.metric('manythreads_process_resident_memory_bytes', 'gauge', 'Resident memory of this server process.', one(snapshot.process.residentBytes));
  w.metric('manythreads_process_heap_used_bytes', 'gauge', 'JavaScript heap in use in this server process.', one(snapshot.process.heapUsedBytes));
  w.metric('manythreads_event_loop_lag_p99_seconds', 'gauge', '99th percentile of how late the event loop ran since the last scrape.', one(snapshot.process.eventLoopLagP99Seconds));
  w.metric('manythreads_process_uptime_seconds', 'gauge', 'Seconds since this server process started.', one(snapshot.process.uptimeSeconds));

  w.metric('manythreads_volume_total_bytes', 'gauge', 'Size of a volume the server writes to.', snapshot.volumes.map((v) => ({ labels: { volume: v.name }, value: v.totalBytes })));
  w.metric('manythreads_volume_free_bytes', 'gauge', 'Space still available on a volume.', snapshot.volumes.map((v) => ({ labels: { volume: v.name }, value: v.freeBytes })));
  w.metric('manythreads_volume_used_ratio', 'gauge', 'Share of a volume in use (1 = full).', snapshot.volumes.map((v) => ({ labels: { volume: v.name }, value: v.usedPercent / 100 })));

  w.metric('manythreads_health_check_breached', 'gauge', 'Whether the built-in health watcher holds a check as tripped (1) or fine (0), judged against the limits in the environment.', checks.map((c) => ({ labels: { check: c.name }, value: c.breached ? 1 : 0 })));
  w.metric('manythreads_ops_section_ok', 'gauge', 'Whether a section of these metrics could be read (1) or failed this pass (0).', Object.entries(sections).map(([section, ok]) => ({ labels: { section }, value: ok ? 1 : 0 })));
  w.metric('manythreads_ops_scrape_timestamp_seconds', 'gauge', 'When this snapshot was taken, in Unix seconds.', [{ value: Math.floor(Date.parse(snapshot.takenAt) / 1000) }]);
  return w.text();
}
