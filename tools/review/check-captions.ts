// Caption check (PLAN P12-05, decision E37). docs/journeys/captions.yaml holds one sentence per declared step of the persona journeys:
//   omar:            # persona
//     O1:            # journey id
//       open-dev: "Omar opens the dev channel and sees the latest posts."   # step id: caption
// This checks the form only (a fresh reviewer checks that the words match the picture): one caption for every declared step that is not pending, none for a step
// that is pending or does not exist, none twice, at most 25 words, one sentence, present tense (a heuristic).
//   tsx tools/review/check-captions.ts [--captions docs/journeys/captions.yaml] [--set real|example]
// The file uses a small YAML subset (three levels of mappings, string values, # comments): nothing else is read.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './lib/e2e-require.ts';

export const MAX_WORDS = 25;
export const CAPTIONS_FILE = join(REPO_ROOT, 'docs', 'journeys', 'captions.yaml');

export interface CaptionEntry {
  persona: string;
  journey: string;
  step: string;
  caption: string;
  line: number;
}

export interface ParsedCaptions {
  entries: CaptionEntry[];
  errors: string[];
}

function unquote(raw: string, line: number, errors: string[]): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(v);
    if (!m) {
      errors.push(`line ${line}: the quoted text is not closed`);
      return '';
    }
    return m[1]!.replace(/\\(["\\])/g, '$1');
  }
  if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(v);
    if (!m) {
      errors.push(`line ${line}: the quoted text is not closed`);
      return '';
    }
    return m[1]!.replace(/''/g, "'");
  }
  return v.replace(/\s+#.*$/, '').trim();
}

/** Reads the three-level mapping. Anything it does not understand is an error with its line number. */
export function parseCaptions(text: string): ParsedCaptions {
  const entries: CaptionEntry[] = [];
  const errors: string[] = [];
  let persona: string | undefined;
  let journey: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const n = i + 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.includes('\t')) {
      errors.push(`line ${n}: use spaces, not tabs`);
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/.exec(raw.trim());
    if (!m) {
      errors.push(`line ${n}: expected "name: …"`);
      continue;
    }
    const key = m[1]!;
    const rest = m[2]?.trim() ?? '';
    const level = indent === 0 ? 0 : indent === 2 ? 1 : indent === 4 ? 2 : -1;
    if (level < 0) {
      errors.push(`line ${n}: indent by 2 spaces per level (persona, journey, step)`);
      continue;
    }
    if (level < 2) {
      if (rest !== '' && !rest.startsWith('#')) errors.push(`line ${n}: "${key}" is a ${level === 0 ? 'persona' : 'journey'} and takes no text`);
      if (level === 0) {
        persona = key;
        journey = undefined;
      } else if (persona === undefined) errors.push(`line ${n}: journey "${key}" has no persona above it`);
      else journey = key;
      continue;
    }
    if (persona === undefined || journey === undefined) {
      errors.push(`line ${n}: step "${key}" has no persona and journey above it`);
      continue;
    }
    if (rest === '') {
      errors.push(`line ${n}: step "${key}" has no caption`);
      continue;
    }
    entries.push({ persona, journey, step: key, caption: unquote(rest, n, errors), line: n });
  }
  return { entries, errors };
}

export interface DeclaredStep {
  persona: string;
  journey: string;
  step: string;
  /** A PLAN task id when the step (or its journey) is not built yet. */
  pending?: string;
}

// Irregular past forms that are not also a plain word in a screen caption ("left" and "read" are, so they are not listed).
const IRREGULAR_PAST = new Set(
  'was were had did went saw made took got sent wrote came gave found said began ran chose held kept told felt thought brought bought became showed'.split(' '),
);
const FUTURE_OR_PERFECT = /\b(will|would|shall|going to|has been|have been|had been)\b/i;
const SUBJECT_THEN_PAST = /^(?:[A-Z][a-z]+|The [a-z]+|He|She|They|I|We|It)\s+([A-Za-z]+ed)\b/;

export function wordCount(caption: string): number {
  return caption.trim().split(/\s+/).filter(Boolean).length;
}

/** Why a caption is not acceptable, or an empty list. Present tense is a heuristic: it catches was/were/had/will and a "-ed" verb right after the subject. */
export function captionProblems(caption: string): string[] {
  const out: string[] = [];
  const text = caption.trim();
  if (text === '') return ['the caption is empty'];
  const words = wordCount(text);
  if (words > MAX_WORDS) out.push(`${words} words; the limit is ${MAX_WORDS}`);
  const withoutEnd = text.replace(/[.!?]+$/, '');
  if (/[.!?]\s+\S/.test(withoutEnd)) out.push('more than one sentence');
  if (!/^[A-Z0-9"“]/.test(text)) out.push('does not start with a capital letter');
  const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const irregular = tokens.filter((t) => IRREGULAR_PAST.has(t));
  if (irregular.length > 0) out.push(`not in the present tense (“${[...new Set(irregular)].join('”, “')}”)`);
  if (FUTURE_OR_PERFECT.test(text)) out.push('not in the present tense (will / would / has been)');
  const past = SUBJECT_THEN_PAST.exec(text);
  if (past) out.push(`not in the present tense (“${past[1]}”)`);
  return out;
}

const keyOf = (p: string, j: string, s: string): string => `${p}/${j}/${s}`;

/** The whole check. `declared` lists every step of the journey set, pending ones marked. */
export function checkCaptions(parsed: ParsedCaptions, declared: readonly DeclaredStep[]): string[] {
  const problems = [...parsed.errors];
  const byKey = new Map(declared.map((d) => [keyOf(d.persona, d.journey, d.step), d]));
  const seen = new Map<string, number>();
  for (const e of parsed.entries) {
    const key = keyOf(e.persona, e.journey, e.step);
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push(`${key}: captioned twice (lines ${first} and ${e.line})`);
      continue;
    }
    seen.set(key, e.line);
    const d = byKey.get(key);
    if (!d) problems.push(`${key} (line ${e.line}): no such step is declared`);
    else if (d.pending !== undefined) problems.push(`${key} (line ${e.line}): the step is pending (${d.pending}) and takes no picture, so it takes no caption`);
    for (const p of captionProblems(e.caption)) problems.push(`${key} (line ${e.line}): ${p}`);
  }
  for (const d of declared) {
    if (d.pending === undefined && !seen.has(keyOf(d.persona, d.journey, d.step))) problems.push(`${keyOf(d.persona, d.journey, d.step)}: no caption`);
  }
  return problems;
}

/** Loads the declared steps of the journey set (real, or the harness example with `--set example`). */
export async function declaredSteps(set: 'real' | 'example'): Promise<DeclaredStep[]> {
  const { loadJourneys } = await import('../../e2e/personas/harness/loader.ts');
  const loaded = await loadJourneys(set);
  return loaded.flatMap(({ journey }) =>
    journey.steps.map((s) => ({ persona: journey.persona, journey: journey.id, step: s.id, pending: journey.pending ?? s.pending })),
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf('--captions');
  const file = resolve(at >= 0 ? argv[at + 1]! : CAPTIONS_FILE);
  const setAt = argv.indexOf('--set');
  const set = setAt >= 0 ? (argv[setAt + 1] === 'example' ? 'example' : 'real') : process.env['MANYTHREADS_JOURNEY_SET'] === 'example' ? 'example' : 'real';
  if (!existsSync(file)) {
    console.error(`captions: ${file} does not exist`);
    return 1;
  }
  const declared = await declaredSteps(set);
  const problems = checkCaptions(parseCaptions(readFileSync(file, 'utf8')), declared);
  for (const p of problems) console.error(`captions: ${p}`);
  if (problems.length === 0) console.log(`captions: ${declared.filter((d) => d.pending === undefined).length} step(s) have one caption each`);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`captions: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
