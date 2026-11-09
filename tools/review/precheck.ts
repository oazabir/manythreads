// Pre-checks on every screenshot (PLAN P13-02, decision E36).
//   - The picture is a valid PNG with more than 200 distinct colours: a failure, always.
//   - axe-core on the live page at the same step (contrast, labels) and the computed-style probe against the tokens: REPORTED to review/precheck-report.json.
//     They fail a run only with --strict (or MANYTHREADS_PRECHECK_STRICT=1); P13-10 turns that on in CI later.
// The live parts run in the screenshot hook (hook.ts, registered through MANYTHREADS_PERSONAS_ONSHOT). This file is also a command:
//   tsx tools/review/precheck.ts [--root docs/journeys] [--report review/precheck-report.json] [--strict]
// which checks every picture of the manifests again and, with --strict, the report.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspectPng, pictureProblem } from '../../e2e/personas/harness/png.ts';
import { readManifests, type ManifestEntry } from '../../e2e/personas/harness/manifest.ts';
import { REPO_ROOT } from './lib/e2e-require.ts';
import type { AxeSummary } from './lib/axe.ts';
import { countFindings, type Findings } from './lib/probe.ts';

export const REPORT_VERSION = 1;

/** The review folder: `review/` (`review/_example/` for the harness's own example set); `MANYTHREADS_REVIEW_DIR` moves it. */
export function reviewDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['MANYTHREADS_REVIEW_DIR'] ?? join(REPO_ROOT, 'review');
  return env['MANYTHREADS_JOURNEY_SET'] === 'example' ? join(base, '_example') : base;
}

export const reportPath = (env: NodeJS.ProcessEnv = process.env): string => join(reviewDir(env), 'precheck-report.json');

export const isStrict = (argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean =>
  argv.includes('--strict') || env['MANYTHREADS_PRECHECK_STRICT'] === '1';

export interface PictureCheck {
  valid: boolean;
  width: number;
  height: number;
  distinctColours: number;
  /** Set when the picture is not acceptable (invalid, empty or blank). */
  problem?: string;
}

/** Valid PNG and more than 200 distinct colours. */
export function checkPicture(png: Buffer): PictureCheck {
  const info = inspectPng(png);
  const problem = pictureProblem(png);
  return {
    valid: info.valid,
    width: info.width,
    height: info.height,
    distinctColours: info.distinctColours,
    ...(problem ? { problem } : {}),
  };
}

export interface ReportEntry {
  persona: string;
  journey: string;
  step: string;
  kind: string;
  picture: PictureCheck;
  axe?: AxeSummary;
  axeError?: string;
  tokens?: Findings;
  tokensError?: string;
  /** Number of elements the probe looked at. */
  elements?: number;
}

export interface Report {
  version: number;
  entries: Record<string, ReportEntry>;
}

export function readReport(file = reportPath()): Report {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Report;
    if (parsed.version === REPORT_VERSION && parsed.entries) return parsed;
  } catch {
    /* no report yet */
  }
  return { version: REPORT_VERSION, entries: {} };
}

/** Adds or replaces the entry of one picture. One worker writes at a time (the persona projects run one worker). */
export function writeReportEntry(file: string, key: string, entry: ReportEntry): void {
  const report = readReport(file);
  report.entries[key] = entry;
  const sorted = Object.fromEntries(Object.entries(report.entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: REPORT_VERSION, entries: sorted }, null, 2)}\n`);
  renameSync(tmp, file);
}

export interface ReportSummary {
  pictures: number;
  pictureProblems: number;
  contrastViolations: number;
  labelViolations: number;
  offTokenColours: number;
  offTokenRadii: number;
  offTokenFonts: number;
}

export function summariseReport(report: Report): ReportSummary {
  const s: ReportSummary = { pictures: 0, pictureProblems: 0, contrastViolations: 0, labelViolations: 0, offTokenColours: 0, offTokenRadii: 0, offTokenFonts: 0 };
  for (const e of Object.values(report.entries)) {
    s.pictures += 1;
    if (e.picture.problem) s.pictureProblems += 1;
    s.contrastViolations += e.axe?.contrast ?? 0;
    s.labelViolations += e.axe?.labels ?? 0;
    s.offTokenColours += e.tokens?.colours.length ?? 0;
    s.offTokenRadii += e.tokens?.radii.length ?? 0;
    s.offTokenFonts += e.tokens?.fonts.length ?? 0;
  }
  return s;
}

/** What `--strict` refuses for one picture: contrast and label violations, anything off the tokens, a live check that could not run. */
export function strictProblems(key: string, e: ReportEntry): string[] {
  const out: string[] = [];
  if (e.axe && e.axe.contrast > 0) out.push(`${key}: ${e.axe.contrast} element(s) below WCAG AA contrast`);
  if (e.axe && e.axe.labels > 0) out.push(`${key}: ${e.axe.labels} control(s) without a name or label`);
  if (e.tokens) {
    for (const c of e.tokens.colours) out.push(`${key}: colour ${c.value} (${c.property ?? 'colour'}) is not a token, on ${c.samples.join(', ')}`);
    for (const r of e.tokens.radii) out.push(`${key}: radius ${r.value} is not a token, on ${r.samples.join(', ')}`);
    for (const f of e.tokens.fonts) out.push(`${key}: font "${f.value}" is not a token, on ${f.samples.join(', ')}`);
  }
  if (e.axeError) out.push(`${key}: axe-core could not run: ${e.axeError}`);
  if (e.tokensError) out.push(`${key}: the style probe could not run: ${e.tokensError}`);
  return out;
}

export function strictReportProblems(report: Report): string[] {
  return Object.entries(report.entries).flatMap(([key, e]) => strictProblems(key, e));
}

export interface FileCheckResult {
  checked: number;
  problems: string[];
}

/** Opens every picture the manifests name and applies the picture check (not blank, valid). A listed picture that is not on disk is a problem too. */
export function checkManifestPictures(root: string, entries: readonly ManifestEntry[]): FileCheckResult {
  const problems: string[] = [];
  let checked = 0;
  for (const e of entries) {
    if (e.kind === 'native') continue;
    const file = join(root, e.file);
    if (!existsSync(file)) {
      problems.push(`${e.file}: the manifest lists it but the file is not there`);
      continue;
    }
    checked += 1;
    const check = checkPicture(readFileSync(file));
    if (check.problem) problems.push(`${e.file}: ${check.problem}`);
  }
  return { checked, problems };
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const root = resolve(argValue(argv, '--root') ?? process.env['MANYTHREADS_JOURNEYS_OUT'] ?? join(REPO_ROOT, 'docs', 'journeys'));
  const report = readReport(resolve(argValue(argv, '--report') ?? reportPath()));
  const { entries } = readManifests(root);
  const strict = isStrict(argv);
  const files = checkManifestPictures(root, entries);
  const problems = [...files.problems];
  if (strict) problems.push(...strictReportProblems(report));
  const s = summariseReport(report);
  console.log(
    `precheck: ${files.checked} picture(s) read; report has ${s.pictures}: ${s.contrastViolations} contrast, ${s.labelViolations} label, ` +
      `${s.offTokenColours} off-token colour, ${s.offTokenRadii} radius, ${s.offTokenFonts} font finding(s)${strict ? ' (strict)' : ' (report only)'}`,
  );
  for (const p of problems) console.error(`precheck: ${p}`);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());

export { countFindings };
