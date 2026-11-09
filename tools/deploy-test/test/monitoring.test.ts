import { describe, expect, it } from 'vitest';
import { dashboardExpressions, dashboardProblems, metricsIn, parseYaml, readRepo, servedMetrics } from '../src/monitoring.ts';

const DASHBOARD = 'deploy/helm/monitoring/grafana/manythreads-overview.json';
const RULES = 'deploy/helm/monitoring/prometheus-rules.yaml';

describe('the Grafana dashboard', () => {
  const doc = JSON.parse(readRepo(DASHBOARD)) as { panels: never[] };

  it('is well-formed', () => {
    expect(dashboardProblems(doc)).toEqual([]);
  });

  it('only reads metrics that /metrics serves', () => {
    const served = servedMetrics();
    const used = new Set(dashboardExpressions(doc as never).flatMap(metricsIn));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((m) => !served.has(m))).toEqual([]);
  });

  it('shows the replica lag and the outbox lag', () => {
    const used = new Set(dashboardExpressions(doc as never).flatMap(metricsIn));
    expect(used.has('manythreads_db_replica_lag_seconds')).toBe(true);
    expect(used.has('manythreads_outbox_oldest_age_seconds')).toBe(true);
  });

  it('the checker catches what Grafana would refuse', () => {
    expect(dashboardProblems({})).toContain('title is missing');
    expect(dashboardProblems({ uid: 'x', title: 't', schemaVersion: 39, panels: [{ id: 1, type: 'timeseries', title: 'a', gridPos: { x: 20, y: 0, w: 8, h: 4 }, targets: [{ refId: 'A' }] }] })).toEqual([
      'panels[0] "a": gridPos leaves the 24-column grid',
      'panels[0] "a": a target has no expr',
    ]);
    const twice = { id: 1, type: 'stat', title: 'a', gridPos: { x: 0, y: 0, w: 4, h: 4 }, targets: [{ refId: 'A', expr: 'up' }] };
    expect(dashboardProblems({ uid: 'x', title: 't', schemaVersion: 39, panels: [twice, twice] })).toEqual(['panels[1] "a": id 1 is used twice']);
  });
});

describe('the Prometheus rules', () => {
  const doc = parseYaml(readRepo(RULES)) as { groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }> }> };
  const rules = doc.groups.flatMap((g) => g.rules);

  it('only read metrics that /metrics serves', () => {
    const served = servedMetrics();
    const used = new Set(rules.flatMap((r) => metricsIn(r.expr)));
    expect([...used].filter((m) => !served.has(m))).toEqual([]);
  });

  it('every alert says what happened and has a severity', () => {
    for (const r of rules) {
      expect(r.annotations?.['summary'], r.alert).toBeTruthy();
      expect(['critical', 'warning', 'info'], r.alert).toContain(r.labels?.['severity']);
    }
  });

  it('has an alert for each check the built-in watcher makes, replica lag included', () => {
    const names = rules.map((r) => r.alert);
    for (const n of ['ManythreadsVolumeFull', 'ManythreadsOutboxLag', 'ManythreadsJobsStuck', 'ManythreadsRunSlotsSaturated', 'ManythreadsApprovalWaiting', 'ManythreadsBudgetNearlyUsed', 'ManythreadsDatabaseConnections', 'ManythreadsReplicaLag']) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('sees a standby that dropped away (the lag metric is left out then, so the lag alert alone would stay silent)', () => {
    const rule = rules.find((r) => r.alert === 'ManythreadsStandbyGone');
    expect(rule?.expr).toContain('manythreads_db_replicas');
    expect(rule?.expr).toContain('max_over_time');
  });

  it('uses the same limits as the built-in watcher defaults', () => {
    const config = readRepo('packages/plugins/ops-health/src/config.ts');
    expect(config).toMatch(/replicaLagSeconds[^\n]*30/);
    expect(rules.find((r) => r.alert === 'ManythreadsReplicaLag')?.expr).toContain('> 30');
  });
});
