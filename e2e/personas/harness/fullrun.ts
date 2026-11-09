// Starting clean (PLAN P12-04): a step that is renumbered or renamed leaves its old picture behind, and the completeness spec then names it as "extra". At the
// start of a FULL run of a viewport project (no grep, no file or title filter) the harness removes that persona's own pictures, manifest and results for that
// viewport, so only what the run makes is there afterwards. A filtered run (`--grep @omar`, one journey) never removes anything: it is a piece of a run.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Persona } from './journey.ts';
import { manifestFile, resultsFile } from './manifest.ts';

/** Command-line options that take a value (so the value is not mistaken for a file or title filter). */
const WITH_VALUE = new Set([
  '--project', '-j', '--workers', '--reporter', '--grep', '-g', '--grep-invert', '--shard', '--timeout', '--retries', '--output', '-c', '--config', '--repeat-each',
  '--max-failures', '--tsconfig', '--trace', '--ui-host', '--ui-port', '--global-timeout',
]);
/** Options that choose a part of the tests instead of all of them. */
const NARROWING = ['--grep', '-g', '--grep-invert', '--shard', '--last-failed', '--only-changed', '--list', '--ui', '--debug'];

export interface FullRun {
  /** The viewport projects this command runs and no filter narrows. Empty: do not clear anything. */
  kinds: Array<'desktop' | 'mobile'>;
}

/** Reads `process.argv` of a `playwright test ...` command. Anything that picks only some tests, or any positional filter, means "not a full run". */
export function fullRunOf(argv: readonly string[]): FullRun {
  const at = argv.indexOf('test');
  const args = at >= 0 ? argv.slice(at + 1) : [];
  const projects: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const [name, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (NARROWING.includes(name)) return { kinds: [] };
    if (name === '--project') {
      const value = inline ?? args[i + 1];
      if (value) projects.push(value);
      if (inline === undefined) i += 1;
    } else if (WITH_VALUE.has(name)) {
      if (inline === undefined) i += 1;
    } else if (!a.startsWith('-')) return { kinds: [] }; // a file or title filter
  }
  const kinds: FullRun['kinds'] = [];
  if (projects.includes('personas-desktop')) kinds.push('desktop');
  if (projects.includes('personas-mobile-web')) kinds.push('mobile');
  return { kinds };
}

/** Removes one persona's pictures of one viewport (`<persona>/*.png`, or `<persona>/mobile/*.png`) with its manifest and results. Other viewports and personas stay. */
export function clearPersonaPictures(root: string, persona: Persona, kind: 'desktop' | 'mobile'): string[] {
  const dir = kind === 'desktop' ? join(root, persona) : join(root, persona, 'mobile');
  const removed: string[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.png')) {
        rmSync(join(dir, entry.name), { force: true });
        removed.push(`${kind === 'desktop' ? '' : 'mobile/'}${entry.name}`);
      }
    }
  }
  rmSync(manifestFile(root, persona, kind), { force: true });
  rmSync(resultsFile(root, persona, kind), { force: true });
  return removed;
}
