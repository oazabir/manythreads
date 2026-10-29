import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate.ts';
import { renderPrometheus } from '../src/prometheus.ts';
import { at, healthy, thresholds } from './fixtures.ts';

const render = (snapshot = healthy()) => renderPrometheus(snapshot, evaluate(snapshot, thresholds, {}, at(0), 3).checks, { outbox: true, jobs: true });

describe('renderPrometheus', () => {
  it('writes HELP and TYPE once per metric and one line per sample', () => {
    const text = render();
    expect(text.endsWith('\n')).toBe(true);
    for (const name of text.match(/^# TYPE (\S+) /gm)?.map((l) => l.split(' ')[2]) ?? []) {
      expect(text.match(new RegExp(`^# HELP ${name} `, 'gm'))).toHaveLength(1);
      expect(text.match(new RegExp(`^# TYPE ${name} `, 'gm'))).toHaveLength(1);
    }
    expect(text).toMatch(/^manythreads_outbox_oldest_age_seconds 0$/m);
    expect(text).toMatch(/^manythreads_run_slots_used 1$/m);
    expect(text).toMatch(/^manythreads_run_slots_limit 6$/m);
    expect(text).toMatch(/^manythreads_db_connections_in_use 20$/m);
    expect(text).toMatch(/^manythreads_volume_used_ratio\{volume="blobs"\} 0\.4$/m);
    expect(text).toMatch(/^manythreads_volume_free_bytes\{volume="repos"\} 40000000000$/m);
    expect(text).toMatch(/^manythreads_budget_burn_ratio_max 0\.1$/m);
  });

  it('exposes the numbers the alerts need', () => {
    const text = render(
      healthy({
        outbox: { backlog: 12, retrying: 2, oldestAgeSeconds: 75 },
        jobs: { ready: 4, running: 1, dead: 3, oldestReadyAgeSeconds: 700, queues: [{ queue: 'files.gc', ready: 4, oldestAgeSeconds: 700 }] },
        runs: { slotsUsed: 6, slotsLimit: 6, queued: 2, oldestQueuedAgeSeconds: 40 },
        approvals: { pending: 2, oldestPendingAgeSeconds: 90_000 },
      }),
    );
    expect(text).toMatch(/^manythreads_outbox_backlog 12$/m);
    expect(text).toMatch(/^manythreads_outbox_oldest_age_seconds 75$/m);
    expect(text).toMatch(/^manythreads_jobs_oldest_ready_age_seconds 700$/m);
    expect(text).toMatch(/^manythreads_jobs_queue_ready\{queue="files\.gc"\} 4$/m);
    expect(text).toMatch(/^manythreads_runs_queued 2$/m);
    expect(text).toMatch(/^manythreads_approvals_oldest_pending_age_seconds 90000$/m);
    expect(text).toMatch(/^manythreads_health_check_breached\{check="outbox_lag"\} 1$/m);
    expect(text).toMatch(/^manythreads_health_check_breached\{check="volume_blobs"\} 0$/m);
  });

  it('leaves out a section that could not be read instead of reporting zero', () => {
    const text = render(healthy({ outbox: null, approvals: null }));
    expect(text).not.toContain('manythreads_outbox_');
    expect(text).not.toContain('manythreads_approvals_');
    expect(text).toContain('manythreads_process_resident_memory_bytes');
  });

  it('escapes label values', () => {
    const text = render(healthy({ volumes: [{ name: 'a"b\\c\nd', totalBytes: 1, freeBytes: 1, usedPercent: 0 }] }));
    expect(text).toContain('volume="a\\"b\\\\c\\nd"');
  });

  it('uses only fixed names as labels: never a person, team or id', () => {
    const labels = new Set(render().match(/(\w+)="/g)?.map((l) => l.slice(0, -2)));
    expect([...labels].sort()).toEqual(['check', 'section', 'volume']);
  });

  it('every line is valid exposition text', () => {
    for (const line of render().trimEnd().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) \S+ .+|[a-z0-9_]+(\{[^}]*\})? -?[0-9.e+]+)$/);
    }
  });
});
