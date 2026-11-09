import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Helpers for the chart tests: render the chart with `helm template` and read the objects back. These tests need the `helm` binary and skip without it.
// `yaml` is not a dependency of this folder (it is no package of its own); the shared package has it, so it is loaded from there.

const here = dirname(fileURLToPath(import.meta.url));
export const chartDir = resolve(here, '../manythreads');
const requireFromShared = createRequire(resolve(here, '../../../packages/shared/package.json'));
const YAML = requireFromShared('yaml') as { parseAllDocuments: (s: string) => { toJS: () => unknown }[] };

export const haveHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;

export interface K8sDoc {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a rendered Kubernetes object: each test reads the part it pins
  [field: string]: any;
}

/** The values files of a release, as the devbox applies them (tools/devbox/stage.sh, ci.sh, deploy.sh). */
export const VALUE_SETS: Record<string, string[]> = {
  base: [],
  ci: ['values-ci.yaml'],
  stage: ['values-ci.yaml', 'values-demo.yaml', 'values-stage.yaml'],
  live: ['values-live.yaml'],
};

/** `helm template` with the named values files (relative to the chart) and `--set` pairs; the release is `manythreads` in `manythreads`, like the live one. */
export function renderRaw(set: string, sets: string[] = [], dir: string = chartDir): { code: number; out: string; err: string } {
  const files = (VALUE_SETS[set] ?? []).flatMap((f) => ['-f', join(dir, f)]);
  const args = ['template', 'manythreads', dir, '-n', 'manythreads', ...files, ...sets.flatMap((s) => ['--set', s])];
  const r = spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function parseDocs(text: string): K8sDoc[] {
  return YAML.parseAllDocuments(text)
    .map((d) => d.toJS() as K8sDoc | null)
    .filter((d): d is K8sDoc => d !== null && typeof d === 'object');
}

/** Render and parse; throws with helm's own message when the render fails. */
export function render(set: string, sets: string[] = []): K8sDoc[] {
  const r = renderRaw(set, sets);
  if (r.code !== 0) throw new Error(`helm template failed: ${r.err}`);
  return parseDocs(r.out);
}

/** `Kind/namespace/name` of every object, the shape of workloads-before.json (a namespace the chart leaves to the release is `-`). */
export const idOf = (d: K8sDoc): string => `${d.kind}/${d.metadata.namespace ?? '-'}/${d.metadata.name}`;

export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Cluster']);

/** The text NOTES.txt prints after an install (`helm template` never shows it): the file is wrapped into a ConfigMap of a copy of the chart and rendered. */
export function renderNotes(sets: string[] = []): string {
  const tmp = mkdtempSync(join(tmpdir(), 'mt-chart-'));
  try {
    const copy = join(tmp, 'chart');
    cpSync(chartDir, copy, { recursive: true });
    const notes = readFileSync(join(copy, 'templates/NOTES.txt'), 'utf8');
    rmSync(join(copy, 'templates/NOTES.txt'));
    writeFileSync(join(copy, 'templates/zz-notes.yaml'), `{{- define "t.notes" -}}\n${notes}\n{{- end -}}\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: notes }\ndata:\n  notes: {{ include "t.notes" . | toJson }}\n`);
    const args = ['template', 'manythreads', copy, '-n', 'manythreads', '-s', 'templates/zz-notes.yaml', '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32', ...sets.flatMap((s) => ['--set', s])];
    const r = spawnSync('helm', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`helm template (notes) failed: ${r.stderr}`);
    return (parseDocs(r.stdout)[0]?.['data'] as { notes: string }).notes;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
