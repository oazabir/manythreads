// Finds the journey files (PLAN P12-01). A journey is `e2e/personas/<persona>/<id>-<slug>.journey.ts` with a default export from `defineJourney`.
// `MANYTHREADS_JOURNEY_SET=example` reads the harness's own example journeys (`e2e/personas/harness/example/`) and writes to `docs/journeys/_example`.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PERSONAS, validateJourney, type JourneyDeclaration, type Persona } from './journey.ts';

export const PERSONAS_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const EXAMPLE_DIR = join(PERSONAS_DIR, 'harness', 'example');

export type JourneySet = 'real' | 'example';
export const currentSet = (): JourneySet => (process.env['MANYTHREADS_JOURNEY_SET'] === 'example' ? 'example' : 'real');

/** The files of a set, sorted, as absolute paths. */
export function journeyFiles(set: JourneySet = currentSet()): string[] {
  const dirs = set === 'example' ? [EXAMPLE_DIR] : PERSONAS.map((p) => join(PERSONAS_DIR, p));
  const out: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.journey.ts')) out.push(join(dir, f));
  }
  return out;
}

export interface LoadedJourney {
  file: string;
  journey: JourneyDeclaration;
}

/** Imports every journey file. A file that does not default-export a journey, or sits in the wrong persona folder, throws with its path. */
export async function loadJourneys(set: JourneySet = currentSet()): Promise<LoadedJourney[]> {
  const out: LoadedJourney[] = [];
  for (const file of journeyFiles(set)) {
    const loaded = (await import(pathToFileURL(file).href)) as { default?: JourneyDeclaration };
    const journey = loaded.default;
    if (!journey || typeof journey !== 'object' || !Array.isArray(journey.steps)) throw new Error(`${file}: the file must default-export defineJourney({...})`);
    const problems = validateJourney(journey);
    if (problems.length > 0) throw new Error(`${file}:\n- ${problems.join('\n- ')}`);
    if (set === 'real') {
      const folder = file.slice(PERSONAS_DIR.length + 1).split('/')[0] as Persona;
      if (folder !== journey.persona) throw new Error(`${file}: the journey is for ${journey.persona} but sits in the ${folder} folder`);
    }
    out.push({ file, journey });
  }
  return out;
}

/** Only these personas (`MANYTHREADS_PERSONAS_ONLY=omar,rafi`), for a shard run of the completeness check. */
export function personasFromEnv(): Persona[] | undefined {
  const raw = process.env['MANYTHREADS_PERSONAS_ONLY'];
  if (!raw) return undefined;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((w) => !(PERSONAS as readonly string[]).includes(w));
  if (bad.length > 0) throw new Error(`MANYTHREADS_PERSONAS_ONLY: unknown persona ${bad.join(', ')}`);
  return wanted as Persona[];
}
