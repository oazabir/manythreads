import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks on the files in deploy/helm/monitoring (PLAN P10-09): the dashboard is well-formed Grafana JSON, and every metric a rule or a panel names is one /metrics really serves.
// `promtool check rules` (in a prom/prometheus container) judges the rule syntax; this judges what promtool cannot, that the names exist.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// `yaml` is a dependency of the shared package, not of this folder.
const YAML = createRequire(join(root, 'packages/shared/package.json'))('yaml') as { parse: (s: string) => unknown };

export const parseYaml = (text: string): unknown => YAML.parse(text);
export const readRepo = (path: string): string => readFileSync(join(root, path), 'utf8');

/** Every `manythreads_*` metric name /metrics can serve, read from the renderer's source. */
export function servedMetrics(): Set<string> {
  const source = readRepo('packages/plugins/ops-health/src/prometheus.ts');
  return new Set([...source.matchAll(/'(manythreads_[a-z0-9_]+)'/g)].map((m) => m[1]!));
}

/** The `manythreads_*` names an expression reads. */
export function metricsIn(expr: string): string[] {
  return [...new Set([...expr.matchAll(/\bmanythreads_[a-z0-9_]+/g)].map((m) => m[0]))];
}

interface Panel {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  gridPos?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  targets?: Array<{ refId?: unknown; expr?: unknown }>;
  panels?: unknown;
}

/** What is wrong with a Grafana dashboard document; an empty list means it is well-formed. A structural check of the fields Grafana needs to load it, not Grafana's own validation. */
export function dashboardProblems(doc: unknown): string[] {
  const problems: string[] = [];
  if (typeof doc !== 'object' || doc === null) return ['the dashboard is not an object'];
  const d = doc as Record<string, unknown>;
  if (typeof d['uid'] !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(d['uid'])) problems.push('uid must be 1 to 40 letters, digits, - or _');
  if (typeof d['title'] !== 'string' || d['title'] === '') problems.push('title is missing');
  if (typeof d['schemaVersion'] !== 'number') problems.push('schemaVersion must be a number');
  if (d['id'] !== undefined && d['id'] !== null) problems.push('id must be left out (Grafana picks it), or the import clashes');
  if (!Array.isArray(d['panels']) || d['panels'].length === 0) return [...problems, 'panels must be a non-empty list'];
  const ids = new Set<unknown>();
  const check = (panel: Panel, where: string): void => {
    if (typeof panel.id !== 'number') problems.push(`${where}: id must be a number`);
    else if (ids.has(panel.id)) problems.push(`${where}: id ${String(panel.id)} is used twice`);
    else ids.add(panel.id);
    if (typeof panel.type !== 'string') problems.push(`${where}: type is missing`);
    if (typeof panel.title !== 'string' || panel.title === '') problems.push(`${where}: title is missing`);
    const g = panel.gridPos;
    if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' || typeof g.w !== 'number' || typeof g.h !== 'number') problems.push(`${where}: gridPos needs x, y, w, h`);
    else if (g.x < 0 || g.w < 1 || g.x + g.w > 24) problems.push(`${where}: gridPos leaves the 24-column grid`);
    if (panel.type !== 'row') {
      if (!Array.isArray(panel.targets) || panel.targets.length === 0) problems.push(`${where}: a panel needs at least one target`);
      const refs = new Set<unknown>();
      for (const t of panel.targets ?? []) {
        if (typeof t.refId !== 'string' || refs.has(t.refId)) problems.push(`${where}: each target needs its own refId`);
        refs.add(t.refId);
        if (typeof t.expr !== 'string' || t.expr.trim() === '') problems.push(`${where}: a target has no expr`);
      }
    }
    if (Array.isArray(panel.panels)) panel.panels.forEach((p, i) => check(p as Panel, `${where}.panels[${i}]`));
  };
  (d['panels'] as Panel[]).forEach((p, i) => check(p, `panels[${i}] "${String(p.title)}"`));
  return problems;
}

/** Every expression of a dashboard's panels. */
export function dashboardExpressions(doc: { panels: Panel[] }): string[] {
  const out: string[] = [];
  const walk = (panels: Panel[]): void => {
    for (const p of panels) {
      for (const t of p.targets ?? []) if (typeof t.expr === 'string') out.push(t.expr);
      if (Array.isArray(p.panels)) walk(p.panels as Panel[]);
    }
  };
  walk(doc.panels);
  return out;
}
