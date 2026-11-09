import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (tools/seed/src/../../..). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The test-utils files the recipes run (seed v2 to v4, v6, v15) and the people they create. */
const SEED_SOURCES = new Set([
  'seed.ts', 'seed-content.ts', 'seed-data.ts', 'seed-repo.ts', 'seed-repo-content.ts', 'seed-storage.ts', 'seed-work.ts', 'seed-meetings.ts', 'seed-assets.ts',
  'create-personas.ts', 'personas.ts', 'actors.ts',
]);

/**
 * What a snapshot is made from. A change to any of these makes the saved one stale, so it is rebuilt (never restored over new code):
 *  - every plugin's and the kernel's SQL migrations (the saved database must be the shape the server expects),
 *  - the seed code and the people/team data (test-utils seed*.ts, personas, create-personas),
 *  - the team templates (their bots and pages are what a team starts with),
 *  - the stack server and the meeting stand-in the builder runs, and the recipes themselves.
 * It does not cover server code that changes what a seed writes through a route (for example the repo writer): a snapshot built before such a change is
 * refreshed with `snapshot build <name> --force`.
 */
export function snapshotInputs(root: string = REPO_ROOT): string[] {
  const files: string[] = [];
  const addDir = (dir: string, keep: (name: string) => boolean): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) addDir(full, keep);
      else if (keep(entry.name)) files.push(full);
    }
  };
  for (const group of [join(root, 'packages'), join(root, 'packages', 'plugins')]) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory()) addDir(join(group, entry.name, 'migrations'), (n) => n.endsWith('.sql'));
    }
  }
  const testUtils = join(root, 'packages', 'test-utils', 'src');
  // only the seeds the recipes run: the opt-in ones (runners, connectors, polish, guard, manuals, inbox) must not make a snapshot stale
  addDir(testUtils, (n) => SEED_SOURCES.has(n));
  addDir(join(root, 'templates'), () => true);
  for (const file of ['e2e/fixtures/seed.ts', 'e2e/fixtures/stack-server.ts', 'e2e/fixtures/meeting-hermes.mjs', 'tools/seed/src/definitions.ts', 'tools/seed/src/build.ts']) {
    const full = join(root, file);
    if (existsSync(full) && statSync(full).isFile()) files.push(full);
  }
  return files.sort();
}

/** A short hash (10 hex characters) of {@link snapshotInputs}: file names and bytes, in a fixed order. */
export function computeSnapshotHash(root: string = REPO_ROOT): string {
  const h = createHash('sha256');
  for (const file of snapshotInputs(root)) {
    h.update(relative(root, file).split(sep).join('/'));
    h.update('\0');
    h.update(readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 10);
}
