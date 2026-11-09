import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Persona, ViewportKind } from './journey.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Where the pictures and the manifests go (PLAN P12-01): `docs/journeys` (E34: the PNGs are not committed). `MANYTHREADS_JOURNEYS_OUT` moves it; the example run
 * of the harness itself uses `docs/journeys/_example` so it never mixes with the real set.
 */
export function journeysRoot(): string {
  const set = process.env['MANYTHREADS_JOURNEY_SET'];
  const base = process.env['MANYTHREADS_JOURNEYS_OUT'] ?? join(REPO_ROOT, 'docs', 'journeys');
  return set === 'example' ? join(base, '_example') : base;
}

/** One picture, as the manifest records it (PLAN P12-01). */
export interface ManifestEntry {
  persona: Persona;
  journey: string;
  step: string;
  kind: ViewportKind;
  viewport: { width: number; height: number };
  /** Address on the stack without its origin (the origin changes every run). */
  url: string;
  /** The landmark that was checked. */
  landmark: string;
  /** Persona-wide running number. */
  number: number;
  /** Path below the journeys folder. */
  file: string;
  sha256: string;
  bytes: number;
  time: string;
}

export type StepStatus = 'passed' | 'failed' | 'pending' | 'not-run';
export type JourneyStatus = 'passed' | 'failed' | 'pending';

/** How one journey ended on one viewport (run-log.json and the completeness spec read these). */
export interface JourneyResult {
  persona: Persona;
  journey: string;
  kind: 'desktop' | 'mobile';
  status: JourneyStatus;
  durationMs: number;
  steps: Record<string, StepStatus>;
  error?: string;
}

export const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export const manifestFile = (root: string, persona: Persona, kind: ViewportKind): string => join(root, persona, `manifest.${kind}.json`);
export const resultsFile = (root: string, persona: Persona, kind: 'desktop' | 'mobile'): string => join(root, persona, `results.${kind}.json`);

/** Adds (or replaces, same persona/journey/step/kind) one entry. One worker writes a persona's files at a time (one shard per persona), so read-modify-write is safe. */
export function appendManifest(root: string, entry: ManifestEntry): void {
  const file = manifestFile(root, entry.persona, entry.kind);
  const all = readJson<ManifestEntry[]>(file, []).filter((e) => !(e.journey === entry.journey && e.step === entry.step));
  all.push(entry);
  all.sort((a, b) => a.number - b.number);
  writeJsonAtomic(file, all);
}

export function recordResult(root: string, result: JourneyResult): void {
  const file = resultsFile(root, result.persona, result.kind);
  const all = readJson<JourneyResult[]>(file, []).filter((r) => r.journey !== result.journey);
  all.push(result);
  writeJsonAtomic(file, all);
}

/** Forget what an earlier run left for these journeys, so a step that is no longer taken cannot pass on an old picture. Called before a journey starts. */
export function clearJourney(root: string, persona: Persona, journey: string, kind: 'desktop' | 'mobile'): void {
  const mFile = manifestFile(root, persona, kind);
  if (existsSync(mFile)) writeJsonAtomic(mFile, readJson<ManifestEntry[]>(mFile, []).filter((e) => e.journey !== journey));
  const rFile = resultsFile(root, persona, kind);
  if (existsSync(rFile)) writeJsonAtomic(rFile, readJson<JourneyResult[]>(rFile, []).filter((r) => r.journey !== journey));
}

export interface ReadManifests {
  entries: ManifestEntry[];
  results: JourneyResult[];
}

export function readManifests(root: string): ReadManifests {
  const entries: ManifestEntry[] = [];
  const results: JourneyResult[] = [];
  if (!existsSync(root)) return { entries, results };
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name))) {
      if (/^manifest\.(desktop|mobile|native)\.json$/.test(f)) entries.push(...readJson<ManifestEntry[]>(join(root, dir.name, f), []));
      else if (/^results\.(desktop|mobile)\.json$/.test(f)) results.push(...readJson<JourneyResult[]>(join(root, dir.name, f), []));
    }
  }
  return { entries, results };
}

/** Every `.png` below the journeys folder, as paths below it (the `native/` pictures belong to another tool and are left out). */
export function listPictures(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'native' || e.name.startsWith('_')) continue;
        walk(join(dir, e.name), `${prefix}${e.name}/`);
      } else if (e.name.endsWith('.png')) out.push(`${prefix}${e.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}
