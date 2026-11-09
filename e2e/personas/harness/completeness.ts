// The completeness check (PLAN P12-04 block C 1): the declared steps against the manifest and the files. Pure: the spec hands it what it read.
import { PERSONAS, resolvePersona, stepRelativePath, viewportsOf, type JourneyDeclaration, type Persona } from './journey.ts';
import type { JourneyResult, ManifestEntry } from './manifest.ts';
import { pictureProblem } from './png.ts';

export interface CompletenessInput {
  journeys: readonly JourneyDeclaration[];
  entries: readonly ManifestEntry[];
  results: readonly JourneyResult[];
  /** Every picture found on disk, as a path below the journeys folder. */
  files: readonly string[];
  /** The bytes of one picture (called only for files that exist and are declared). */
  read: (file: string) => Buffer;
  /** Only these personas (a shard run); default all that have a journey. */
  personas?: readonly Persona[];
}

export interface CompletenessReport {
  problems: string[];
  /** Counts for the run log and the spec's output. */
  declared: number;
  pending: number;
  checked: number;
  pendingList: string[];
}

export function checkCompleteness(input: CompletenessInput): CompletenessReport {
  const problems: string[] = [];
  const expectedFiles = new Set<string>();
  const pendingList: string[] = [];
  let declared = 0;
  let checked = 0;
  const personas = input.personas ?? PERSONAS.filter((p) => input.journeys.some((j) => j.persona === p));
  for (const persona of personas) {
    const resolved = resolvePersona(input.journeys, persona);
    for (const j of input.journeys.filter((x) => x.persona === persona)) {
      if (j.pending !== undefined) {
        pendingList.push(`${persona}/${j.id} (${j.pending})`);
        continue;
      }
      for (const s of j.steps) if (s.pending !== undefined) pendingList.push(`${persona}/${j.id}/${s.id} (${s.pending})`);
      for (const kind of viewportsOf(j)) {
        const result = input.results.find((r) => r.persona === persona && r.journey === j.id && r.kind === kind);
        if (!result) problems.push(`journey ${persona}/${j.id} (${kind}) has no result: it did not run`);
        else if (result.status !== 'passed') {
          const failed = Object.entries(result.steps).filter(([, st]) => st === 'failed').map(([id]) => id);
          problems.push(`journey ${persona}/${j.id} (${kind}) ${result.status}${failed.length ? ` at step ${failed.join(', ')}` : ''}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
        }
        for (const s of j.steps) {
          if (s.pending !== undefined) continue;
          declared += 1;
          const step = resolved.find((r) => r.journeyId === j.id && r.id === s.id)!;
          const file = stepRelativePath(step, kind);
          expectedFiles.add(file);
          const entry = input.entries.find((e) => e.persona === persona && e.journey === j.id && e.step === s.id && e.kind === kind);
          const label = `step ${persona}/${j.id}/${s.id} (${kind})`;
          if (!entry) problems.push(`missing screenshot: ${label} is not in the manifest (expected ${file})`);
          else if (entry.file !== file) problems.push(`${label} is in the manifest as ${entry.file}, expected ${file}`);
          if (!input.files.includes(file)) {
            problems.push(`missing screenshot: ${label} has no file ${file}`);
            continue;
          }
          checked += 1;
          const bad = pictureProblem(input.read(file));
          if (bad) problems.push(`${label}: ${file}: ${bad}`);
        }
      }
    }
  }
  // nothing the declarations do not account for
  for (const file of input.files) {
    const persona = file.split('/')[0] as Persona;
    if (!personas.includes(persona)) continue;
    if (!expectedFiles.has(file)) problems.push(`extra screenshot: ${file} belongs to no declared step`);
  }
  for (const e of input.entries) {
    if (!personas.includes(e.persona)) continue;
    const j = input.journeys.find((x) => x.persona === e.persona && x.id === e.journey);
    if (!j || !j.steps.some((s) => s.id === e.step && s.pending === undefined) || j.pending !== undefined) {
      problems.push(`the manifest has an entry for ${e.persona}/${e.journey}/${e.step} (${e.kind}) that is not a declared, built step`);
    }
  }
  return { problems, declared, pending: pendingList.length, checked, pendingList };
}
