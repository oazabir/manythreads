import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pictureProblem } from '../../../e2e/personas/harness/png.ts';
import { BATCH_SIZE, checkBatches, checkRound, CHECKLIST_FILE, planBatches, roundDir, writeBatches, type BatchMap } from '../batches.ts';
import { manifestEntry, tempDir, writePictures } from './support.ts';
import type { ManifestEntry } from '../../../e2e/personas/harness/manifest.ts';

function many(persona: ManifestEntry['persona'], kind: 'desktop' | 'mobile', n: number): ManifestEntry[] {
  return Array.from({ length: n }, (_, i) => manifestEntry(persona, kind, i + 1));
}

const all = (): ManifestEntry[] => [...many('omar', 'desktop', 30), ...many('omar', 'mobile', 30), ...many('nadia', 'desktop', 12), ...many('nadia', 'mobile', 13), ...many('lena', 'desktop', 1)];

describe('batch plan', () => {
  it('puts every picture in exactly one batch of at most 12, per persona and viewport', () => {
    const entries = all();
    const batches = planBatches(entries);
    expect(checkBatches(batches, entries.map((e) => e.file))).toEqual([]);
    expect(batches.every((b) => b.files.length <= 12)).toBe(true);
    expect(batches.filter((b) => b.persona === 'omar' && b.viewport === 'desktop').map((b) => b.files.length)).toEqual([12, 12, 6]);
    expect(batches.filter((b) => b.persona === 'nadia' && b.viewport === 'mobile').map((b) => b.files.length)).toEqual([12, 1]);
    expect(batches.filter((b) => b.persona === 'nadia' && b.viewport === 'desktop').map((b) => b.files.length)).toEqual([12]);
    expect(batches.flatMap((b) => b.files).sort()).toEqual(entries.map((e) => e.file).sort());
    const omar = batches.filter((b) => b.persona === 'omar' && b.viewport === 'mobile');
    expect(omar.map((b) => [b.batch, b.of, b.dir])).toEqual([
      [1, 3, 'omar/mobile/batch-01'],
      [2, 3, 'omar/mobile/batch-02'],
      [3, 3, 'omar/mobile/batch-03'],
    ]);
    expect(omar[0]!.size).toEqual({ width: 390, height: 844 });
  });

  it('keeps step order inside a batch', () => {
    const shuffled = many('omar', 'desktop', 20).reverse();
    const first = planBatches(shuffled)[0]!;
    expect(first.files[0]).toBe('omar/01-O1-s1.png');
    expect(first.files[11]).toBe('omar/12-O1-s12.png');
  });

  it('leaves out native pictures (another tool owns them) and refuses a size above 12', () => {
    const native = { ...manifestEntry('omar', 'desktop', 99), kind: 'native' as const };
    expect(planBatches([native])).toEqual([]);
    expect(() => planBatches(many('omar', 'desktop', 3), 13)).toThrow(/1 to 12/);
  });

  it('fails a picture that is in no batch, in two, a batch of 13, and a wrong-viewport file', () => {
    const entries = many('omar', 'desktop', 14);
    const files = entries.map((e) => e.file);
    const good = planBatches(entries);
    const missing = good.map((b) => ({ ...b, files: b.files.filter((f) => !f.includes('03-O1')) }));
    expect(checkBatches(missing, files)).toContain('omar/03-O1-s3.png: in no batch');
    const doubled = good.map((b, i) => (i === 1 ? { ...b, files: [...b.files, files[0]!] } : b));
    expect(checkBatches(doubled, files).some((p) => /in two batches/.test(p))).toBe(true);
    const big = [{ ...good[0]!, files, batch: 1, of: 1 }];
    expect(checkBatches(big, files).some((p) => /14 pictures; the limit is 12/.test(p))).toBe(true);
    const wrong = good.map((b, i) => (i === 0 ? { ...b, viewport: 'mobile' as const } : b));
    expect(checkBatches(wrong, files).some((p) => /does not belong/.test(p))).toBe(true);
    const gap = good.map((b) => ({ ...b, batch: b.batch + 1 }));
    expect(checkBatches(gap, files).some((p) => /not 1\.\./.test(p))).toBe(true);
    expect(BATCH_SIZE).toBe(12);
  });
});

describe('batch folders', () => {
  it('writes the folders with pictures, checklist, tokens and a contact sheet, and the check passes', async () => {
    const journeys = tempDir();
    const out = tempDir();
    const entries = [...many('omar', 'desktop', 14), ...many('omar', 'mobile', 3)];
    writePictures(journeys, entries);
    const map = await writeBatches(entries, { journeysRoot: journeys, outDir: out, round: 1 });
    expect(map.batches.map((b) => b.dir)).toEqual(['omar/desktop/batch-01', 'omar/desktop/batch-02', 'omar/mobile/batch-01']);
    const first = join(roundDir(out, 1), 'omar/desktop/batch-01');
    const names = readdirSync(first).sort();
    expect(names.filter((n) => /^\d\d-/.test(n))).toHaveLength(12);
    expect(names).toEqual(expect.arrayContaining(['CHECKLIST.md', 'contact-sheet.png', 'tokens.txt']));
    expect(readFileSync(join(first, 'CHECKLIST.md'), 'utf8')).toBe(readFileSync(CHECKLIST_FILE, 'utf8'));
    expect(pictureProblem(readFileSync(join(first, 'contact-sheet.png')))).toBeNull();
    expect(readFileSync(join(first, 'tokens.txt'), 'utf8')).toContain('--human: #2E5C8A');
    expect(readdirSync(join(roundDir(out, 1), 'omar/desktop/batch-02')).filter((n) => /^\d\d-/.test(n))).toHaveLength(2);
    expect(checkRound(entries, journeys, out, 1)).toEqual([]);
    const written = JSON.parse(readFileSync(join(roundDir(out, 1), 'batch-map.json'), 'utf8')) as BatchMap;
    expect(written.round).toBe(1);
  }, 120_000);

  it('the round check catches a picture dropped from the map, a stray picture on disk and a missing copy', async () => {
    const journeys = tempDir();
    const out = tempDir();
    const entries = many('omar', 'desktop', 4);
    writePictures(journeys, entries);
    await writeBatches(entries, { journeysRoot: journeys, outDir: out, round: 2, sheets: false });
    expect(checkRound(entries, journeys, out, 2, false)).toEqual([]);
    expect(checkRound(entries, journeys, out, 2, true)).toEqual(['omar/desktop/batch-01: contact-sheet.png is missing']);
    // a new picture appears on disk after the batches were made
    writePictures(journeys, [manifestEntry('omar', 'desktop', 5)]);
    expect(checkRound(entries, journeys, out, 2, false).join('\n')).toMatch(/omar\/05-O1-s5\.png: in no batch/);
    // a copy goes missing
    const file = join(roundDir(out, 2), 'omar/desktop/batch-01/02-O1-s2.png');
    expect(existsSync(file)).toBe(true);
    writeFileSync(join(roundDir(out, 2), 'batch-map.json'), '{ not json');
    expect(checkRound(entries, journeys, out, 2, false)[0]).toMatch(/batch-map\.json/);
  }, 60_000);

  it('refuses to write when a listed picture is missing on disk', async () => {
    const journeys = tempDir();
    await expect(writeBatches(many('omar', 'desktop', 2), { journeysRoot: journeys, outDir: tempDir(), round: 1, sheets: false })).rejects.toThrow(/is not there/);
  });
});
