import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadBotEval, runEvalSet, staticAnswerer, type EvalResult } from '@manythreads/shared';

// `pnpm test:evals -- --bot=<slug>` (PLAN P7-08): run a bot's scenario set from files on disk, in the free deterministic mode (no model, no database,
// no server), and exit non-zero when the score is below the BOT.md's `minScore`. The same loader and the same judge the server runs.
//
//   pnpm test:evals -- --bot=tester                 look in ./bots/tester, then in templates/*/bots/tester
//   pnpm test:evals -- --bot=brain --root=<folder>  a folder that holds bots/brain/BOT.md (a checkout of a team repo)
//
// Exit codes: 0 every bot at or above its minimum (or nothing could be judged: said plainly), 1 below the minimum, 2 the files could not be used.

export interface EvalCliIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

const USAGE = 'Usage: pnpm test:evals -- --bot=<slug> [--root=<folder>] [--verbose]';

/** Every folder that holds `bots/<slug>/BOT.md`: the root itself, or each template under `templates/` that has the bot. */
export async function findBotFolders(slug: string, cwd: string, root?: string): Promise<string[]> {
  const has = async (dir: string): Promise<boolean> => {
    try {
      await readFile(join(dir, 'bots', slug, 'BOT.md'));
      return true;
    } catch {
      return false;
    }
  };
  if (root !== undefined) return (await has(resolve(cwd, root))) ? [resolve(cwd, root)] : [];
  if (await has(cwd)) return [cwd];
  const found: string[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(join(cwd, 'templates'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const dir = join(cwd, 'templates', name);
    if (await has(dir)) found.push(dir);
  }
  return found;
}

function arg(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const sentence = (r: EvalResult): string => (r.judged ? (r.passed ? 'pass' : 'FAIL') : 'not checked');

export async function runEvalCli(argv: readonly string[], io: EvalCliIo): Promise<number> {
  const slug = arg(argv, 'bot');
  if (slug === undefined || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    io.err(slug === undefined ? 'Say which bot to run: --bot=<slug>.' : `"${slug}" is not a bot folder name (lowercase letters, digits, ".", "_" or "-").`);
    io.err(USAGE);
    return 2;
  }
  const verbose = argv.includes('--verbose');
  const folders = await findBotFolders(slug, io.cwd, arg(argv, 'root'));
  if (folders.length === 0) {
    io.err(`No bots/${slug}/BOT.md found${arg(argv, 'root') ? ` under ${arg(argv, 'root')}` : ' here or in templates/*'}.`);
    return 2;
  }
  let worst = 0;
  for (const folder of folders) {
    const read = async (path: string): Promise<string | null> => {
      try {
        return await readFile(join(folder, path), 'utf8');
      } catch {
        return null;
      }
    };
    const label = folder === io.cwd ? '.' : folder.startsWith(`${io.cwd}/`) ? folder.slice(io.cwd.length + 1) : folder;
    const loaded = await loadBotEval(slug, read);
    if (!loaded.ok) {
      if (loaded.kind === 'no_evals') {
        io.out(`${label}: ${slug} has no scenario set; nothing to run.`);
        continue;
      }
      io.err(`${label}: ${loaded.message}`);
      worst = Math.max(worst, 2);
      continue;
    }
    const { definition, set, minScore } = loaded.loaded;
    const { results, summary } = await runEvalSet(staticAnswerer, definition, set.cases, minScore);
    io.out(`${label}: set "${set.set}" · free mode (no model: it checks that the definition grants the calls each case requires) · ${summary.judged} of ${summary.total} cases can be checked`);
    for (const r of results) {
      if (verbose || (r.judged && !r.passed)) io.out(`  ${sentence(r).padEnd(11)} ${r.caseId}${r.reasons.length > 0 && r.judged ? ` - ${r.reasons.join(' ')}` : ''}`);
    }
    if (summary.score === null) {
      io.out(`${label}: no case could be checked without a model; run it from the bot's Evals tab with the model to judge the rest.`);
      continue;
    }
    const verdict = summary.ok ? 'OK' : 'BELOW THE MINIMUM';
    io.out(`${label}: ${summary.passed} of ${summary.judged} passed · score ${summary.score.toFixed(2)} · minimum ${minScore.toFixed(2)} · ${verdict}`);
    if (!summary.ok) worst = Math.max(worst, 1);
  }
  return worst;
}
