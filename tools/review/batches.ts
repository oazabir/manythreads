// Review batches (PLAN P13-03, P13-04): every picture of the manifests goes into exactly one batch of at most 12, per persona and viewport:
//   review/round-N/<persona>/<viewport>/batch-NN/   ≤ 12 full-size pictures · contact-sheet.png · CHECKLIST.md · tokens.txt
//   review/round-N/batch-map.json                   the map the check below reads
//   tsx tools/review/batches.ts --round 1 [--root docs/journeys] [--out review] [--size 12] [--no-sheets]
//   tsx tools/review/batches.ts --check --round 1   verifies the map (and the folders) against the manifests
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPictures, readManifests, type ManifestEntry } from '../../e2e/personas/harness/manifest.ts';
import { renderContactSheets, sheetTitle, type SheetJob } from './contact-sheet.ts';
import { REPO_ROOT } from './lib/e2e-require.ts';
import { generateTokensTxt } from './tokens.ts';

export const BATCH_SIZE = 12;
const HERE = dirname(fileURLToPath(import.meta.url));
export const CHECKLIST_FILE = join(HERE, 'CHECKLIST.md');

export type Viewport = 'desktop' | 'mobile';

export interface Batch {
  persona: string;
  viewport: Viewport;
  /** `1440×900` */
  size: { width: number; height: number };
  /** 1-based */
  batch: number;
  /** How many batches this persona and viewport have. */
  of: number;
  /** Folder below the round folder: `<persona>/<viewport>/batch-NN`. */
  dir: string;
  /** Picture paths below the journeys folder, as the manifest names them. */
  files: string[];
}

export interface BatchMap {
  round: number;
  size: number;
  batches: Batch[];
}

export const batchDirName = (n: number): string => `batch-${String(n).padStart(2, '0')}`;

/** Chunks the web pictures of the manifests (desktop and mobile; `native` ones belong to another tool) by persona and viewport, in step order. */
export function planBatches(entries: readonly ManifestEntry[], size = BATCH_SIZE): Batch[] {
  if (!Number.isInteger(size) || size < 1 || size > BATCH_SIZE) throw new Error(`batch size ${size}: must be 1 to ${BATCH_SIZE}`);
  const groups = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    if (e.kind !== 'desktop' && e.kind !== 'mobile') continue;
    const key = `${e.persona}\n${e.kind}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out: Batch[] = [];
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!.sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
    const [persona, viewport] = key.split('\n') as [string, Viewport];
    const of = Math.ceil(list.length / size);
    for (let n = 1; n <= of; n += 1) {
      const chunk = list.slice((n - 1) * size, n * size);
      out.push({
        persona,
        viewport,
        size: { width: chunk[0]!.viewport.width, height: chunk[0]!.viewport.height },
        batch: n,
        of,
        dir: `${persona}/${viewport}/${batchDirName(n)}`,
        files: chunk.map((e) => e.file),
      });
    }
  }
  return out;
}

/**
 * The script check of PLAN P13 acceptance 1: every picture is in exactly one batch, no batch holds more than `size`, a batch belongs to one persona and one
 * viewport, batch numbers run 1..of without gaps. `pictures` are the pictures that must be covered (the manifests' entries; the PNGs on disk when given).
 */
export function checkBatches(batches: readonly Batch[], pictures: readonly string[], size = BATCH_SIZE): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const dirs = new Set<string>();
  for (const b of batches) {
    if (dirs.has(b.dir)) problems.push(`${b.dir}: two batches share this folder`);
    dirs.add(b.dir);
    if (b.files.length === 0) problems.push(`${b.dir}: the batch is empty`);
    if (b.files.length > size) problems.push(`${b.dir}: ${b.files.length} pictures; the limit is ${size}`);
    for (const f of b.files) {
      const isMobile = f.startsWith(`${b.persona}/mobile/`);
      const mine = f.startsWith(`${b.persona}/`) && (b.viewport === 'mobile' ? isMobile : !isMobile);
      if (!mine) problems.push(`${b.dir}: ${f} does not belong to ${b.persona} · ${b.viewport}`);
      const first = seen.get(f);
      if (first !== undefined) problems.push(`${f}: in two batches (${first} and ${b.dir})`);
      else seen.set(f, b.dir);
    }
  }
  for (const p of pictures) if (!seen.has(p)) problems.push(`${p}: in no batch`);
  const wanted = new Set(pictures);
  for (const f of seen.keys()) if (!wanted.has(f)) problems.push(`${f}: in a batch but not in the manifest`);
  const byGroup = new Map<string, Batch[]>();
  for (const b of batches) byGroup.set(`${b.persona}/${b.viewport}`, [...(byGroup.get(`${b.persona}/${b.viewport}`) ?? []), b]);
  for (const [group, list] of byGroup) {
    const numbers = list.map((b) => b.batch).sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1)) problems.push(`${group}: batch numbers ${numbers.join(', ')} are not 1..${list.length}`);
    if (list.some((b) => b.of !== list.length)) problems.push(`${group}: a batch says "of" a number other than ${list.length}`);
  }
  return problems;
}

export interface WriteOptions {
  /** The journeys folder the pictures are read from. */
  journeysRoot: string;
  /** The review folder (`review/`). */
  outDir: string;
  round: number;
  size?: number;
  /** Draw `contact-sheet.png` (default true; needs Chromium). */
  sheets?: boolean;
}

export const roundDir = (outDir: string, round: number): string => join(outDir, `round-${round}`);

/** Copies the pictures into their batch folders with the checklist, the tokens and the contact sheet. Returns the map it wrote. */
export async function writeBatches(entries: readonly ManifestEntry[], options: WriteOptions): Promise<BatchMap> {
  const size = options.size ?? BATCH_SIZE;
  const batches = planBatches(entries, size);
  const problems = checkBatches(
    batches,
    entries.filter((e) => e.kind === 'desktop' || e.kind === 'mobile').map((e) => e.file),
    size,
  );
  if (problems.length > 0) throw new Error(`the batch plan is wrong:\n- ${problems.join('\n- ')}`);
  const base = roundDir(options.outDir, options.round);
  const checklist = readFileSync(CHECKLIST_FILE, 'utf8');
  const tokens = generateTokensTxt();
  const jobs: SheetJob[] = [];
  for (const b of batches) {
    const dir = join(base, b.dir);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of b.files) {
      const from = join(options.journeysRoot, f);
      if (!existsSync(from)) throw new Error(`${f}: the manifest lists it but ${from} is not there`);
      copyFileSync(from, join(dir, basename(f)));
    }
    writeFileSync(join(dir, 'CHECKLIST.md'), checklist);
    writeFileSync(join(dir, 'tokens.txt'), tokens);
    jobs.push({
      title: sheetTitle(b.persona, b.size, b.batch, b.of),
      images: b.files.map((f) => ({ file: join(dir, basename(f)) })),
      out: join(dir, 'contact-sheet.png'),
    });
  }
  if (options.sheets !== false && jobs.length > 0) await renderContactSheets(jobs);
  const map: BatchMap = { round: options.round, size, batches };
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'batch-map.json'), `${JSON.stringify(map, null, 2)}\n`);
  return map;
}

/** Re-reads a written round: the map against the manifests and the PNGs on disk, and the folders against the map. */
export function checkRound(entries: readonly ManifestEntry[], journeysRoot: string, outDir: string, round: number, expectSheets = true): string[] {
  const base = roundDir(outDir, round);
  let map: BatchMap;
  try {
    map = JSON.parse(readFileSync(join(base, 'batch-map.json'), 'utf8')) as BatchMap;
  } catch {
    return [`${base}/batch-map.json: missing or unreadable`];
  }
  const web = entries.filter((e) => e.kind === 'desktop' || e.kind === 'mobile').map((e) => e.file);
  const onDisk = listPictures(journeysRoot);
  const problems = checkBatches(map.batches, [...new Set([...web, ...onDisk])], map.size);
  for (const b of map.batches) {
    const dir = join(base, b.dir);
    const have = existsSync(dir) ? readdirSync(dir) : [];
    for (const f of b.files) if (!have.includes(basename(f))) problems.push(`${b.dir}: ${basename(f)} was not copied`);
    for (const extra of ['CHECKLIST.md', 'tokens.txt', ...(expectSheets ? ['contact-sheet.png'] : [])]) if (!have.includes(extra)) problems.push(`${b.dir}: ${extra} is missing`);
    const pictures = have.filter((n) => n.endsWith('.png') && n !== 'contact-sheet.png');
    if (pictures.length > map.size) problems.push(`${b.dir}: ${pictures.length} pictures in the folder`);
  }
  return problems;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const root = resolve(argValue(argv, '--root') ?? process.env['MANYTHREADS_JOURNEYS_OUT'] ?? join(REPO_ROOT, 'docs', 'journeys'));
  const outDir = resolve(argValue(argv, '--out') ?? join(REPO_ROOT, 'review'));
  const round = Number(argValue(argv, '--round') ?? '1');
  const size = Number(argValue(argv, '--size') ?? BATCH_SIZE);
  if (!Number.isInteger(round) || round < 1) {
    console.error('batches: --round must be a whole number from 1');
    return 2;
  }
  const { entries } = readManifests(root);
  if (entries.length === 0) {
    console.error(`batches: no manifest entries below ${root}`);
    return 1;
  }
  if (argv.includes('--check')) {
    const problems = checkRound(entries, root, outDir, round, !argv.includes('--no-sheets'));
    for (const p of problems) console.error(`batches: ${p}`);
    if (problems.length === 0) console.log(`batches: round ${round} covers every picture exactly once`);
    return problems.length > 0 ? 1 : 0;
  }
  const map = await writeBatches(entries, { journeysRoot: root, outDir, round, size, sheets: !argv.includes('--no-sheets') });
  const personas = new Set(map.batches.map((b) => b.persona));
  console.log(`batches: round ${round}: ${map.batches.length} batch(es) for ${personas.size} persona(s) in ${roundDir(outDir, round)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`batches: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
