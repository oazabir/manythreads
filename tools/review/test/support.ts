// Fixtures of the review-tool tests.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ManifestEntry } from '../../../e2e/personas/harness/manifest.ts';
import { makePng } from '../../../e2e/personas/harness/test/fixtures.ts';

export { blankPng, busyPng, makePng } from '../../../e2e/personas/harness/test/fixtures.ts';

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'mt-review-'));

/** A distinct busy picture: `seed` shifts the colours so two pictures differ. */
export const picture = (seed: number, width = 1440, height = 900): Buffer =>
  makePng(Math.min(width, 120), Math.min(height, 120), (x, y) => [(x * 5 + seed * 37) % 256, (y * 5 + seed * 11) % 256, (x * y + seed) % 256]);

export function manifestEntry(persona: ManifestEntry['persona'], kind: 'desktop' | 'mobile', number: number, journey = 'O1', step = `s${number}`): ManifestEntry {
  const name = `${String(number).padStart(2, '0')}-${journey}-${step}.png`;
  return {
    persona,
    journey,
    step,
    kind,
    viewport: kind === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    url: '/t/engineering',
    landmark: 'app-frame',
    number,
    file: `${persona}/${kind === 'mobile' ? 'mobile/' : ''}${name}`,
    sha256: 'x'.repeat(8),
    bytes: 1,
    time: '2026-11-09T00:00:00.000Z',
  };
}

/** Writes the pictures of `entries` below `root`. */
export function writePictures(root: string, entries: readonly ManifestEntry[]): void {
  entries.forEach((e, i) => {
    const file = join(root, e.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, picture(i, e.viewport.width, e.viewport.height));
  });
}
