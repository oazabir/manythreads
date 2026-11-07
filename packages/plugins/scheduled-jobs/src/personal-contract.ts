import { PersonalRoutinePath, RoutineOutputMode, RoutineSource, CronExpression } from '@manythreads/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// The contract of a personal routine: `Routines/<slug>/routine.yaml` in its owner's Personal files (PLAN P20-10). The person's own words, the prompt the bot is given, what it
// may look at and where the output goes. It is a plain file the person can read and edit; every save is a new version of it. The platform reads the prompt at each firing, so an
// edit takes effect at the next one. The schedule, the time zone and the output place are kept on the routine itself (the routine's screen changes them), and the file shows them.

export const PersonalContract = z.object({
  name: z.string().min(1).max(80),
  words: z.string().max(2000).default(''),
  schedule: CronExpression,
  timeZone: z.string().min(1).max(64),
  sources: z.array(RoutineSource).max(20).default([]),
  prompt: z.string().min(1).max(8000),
  output: z.object({ path: PersonalRoutinePath, mode: RoutineOutputMode.default('replace') }),
});
export type PersonalContract = z.infer<typeof PersonalContract>;

export const contractPathOf = (slug: string): string => `Routines/${slug}/routine.yaml`;
export const defaultOutputPathOf = (slug: string): string => `Routines/${slug}/output.md`;

const HEADER = '# A routine of yours. The prompt below is what the bot is asked at each run; change it any time (every save keeps the earlier version).\n';

export function buildContractText(contract: PersonalContract): string {
  return HEADER + stringifyYaml(contract, { lineWidth: 100 });
}

/** Read and check a contract; throws an Error whose message is a plain reason fit for the run's ledger line. */
export function parseContractText(text: string, path: string): PersonalContract {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error(`Your routine file ${path} is not valid YAML`);
  }
  const parsed = PersonalContract.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Your routine file ${path} has a problem: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/** A folder name for a routine from its name: lower case, words joined by dashes, starts with a letter, at most 40 characters; `taken` makes it unique. */
export function slugFor(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `routine-${base}`.replace(/-+$/g, '');
  if (base === '' || base === 'routine') base = 'routine';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}
