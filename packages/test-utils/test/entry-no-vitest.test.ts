import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package's main entry is loaded at runtime by things that are not vitest: the e2e web server and the seed CLI (`pnpm e2e` fails to start its
// web server with "Vitest failed to access its internal state" when anything reachable from it imports `vitest`, which happened once with the
// timing helper). Test-only helpers that need the framework live behind a subpath export (`./blob-contract`, `./linear`); this keeps the main
// entry, and everything it reaches, free of it.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const VITEST = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]vitest(?:\/[^'"]*)?['"]/;
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every file reachable from `entry` through relative imports and re-exports (static and dynamic), as absolute paths. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(RELATIVE)) {
      const target = resolve(dirname(file), match[1] as string);
      stack.push(/\.[cm]?[jt]s$/.test(target) ? target : `${target}.ts`);
    }
  }
  return [...seen];
}

describe('the main entry of @manythreads/test-utils', () => {
  const files = reachable(resolve(SRC, 'index.ts'));

  it('reaches the helpers it is meant to (so this check is not vacuous)', () => {
    const names = files.map((f) => f.slice(SRC.length + 1));
    expect(names).toEqual(expect.arrayContaining(['index.ts', 'db.ts', 'server.ts', 'seed.ts']));
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports vitest nowhere, directly or through a re-export', () => {
    const offenders = files.filter((f) => VITEST.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length + 1));
    expect(offenders, 'a file reachable from src/index.ts imports vitest: move it behind a subpath export in package.json').toEqual([]);
  });

  it('keeps the vitest helpers out of the entry and behind their subpaths', () => {
    const names = files.map((f) => f.slice(SRC.length + 1));
    for (const helper of ['linear.ts', 'blob-contract.ts']) expect(names).not.toContain(helper);
    const exportsMap = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(exportsMap.exports['./linear']).toBe('./src/linear.ts');
    expect(exportsMap.exports['./blob-contract']).toBe('./src/blob-contract.ts');
    // and the pattern does catch what it is looking for
    expect(VITEST.test("import { expect } from 'vitest';")).toBe(true);
    expect(VITEST.test("const v = await import('vitest')")).toBe(true);
    expect(VITEST.test("// never by vitest")).toBe(false);
  });
});
