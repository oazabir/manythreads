import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pictureProblem } from '../../../e2e/personas/harness/png.ts';
import { layoutFor, MAX_CELLS, pngSize, renderContactSheets, sheetHtml, sheetTitle } from '../contact-sheet.ts';
import { picture, tempDir } from './support.ts';
import { writeFileSync } from 'node:fs';

function fixtures(n: number, dir: string, width = 1440, height = 900): string[] {
  return Array.from({ length: n }, (_, i) => {
    const file = join(dir, `${String(i + 1).padStart(2, '0')}-O1-step-${i + 1}.png`);
    writeFileSync(file, picture(i + 1, width, height));
    return file;
  });
}

describe('contact sheet', () => {
  it('draws 12 labelled cells under the title "persona · viewport · sheet n of m"', async () => {
    const dir = tempDir();
    const files = fixtures(12, dir);
    const title = sheetTitle('omar', { width: 1440, height: 900 }, 1, 5);
    expect(title).toBe('omar · 1440×900 · sheet 1 of 5');
    const [r] = await renderContactSheets([{ title, images: files.map((file) => ({ file })), out: join(dir, 'contact-sheet.png') }]);
    expect(r!.cells).toBe(12);
    expect(r!.labels).toEqual(files.map((f) => f.split('/').pop()));
    const png = readFileSync(join(dir, 'contact-sheet.png'));
    expect(pictureProblem(png)).toBeNull();
    expect(pngSize(png)).toEqual({ width: r!.width, height: r!.height });
    expect(r!.height).toBeGreaterThan(700); // three rows of thumbnails and the title
  }, 90_000);

  it('lays out phone pictures six across and desktop pictures four across', () => {
    expect(layoutFor(1440, 900).columns).toBe(4);
    expect(layoutFor(390, 844).columns).toBe(6);
  });

  it('writes the title and every label into the page, escaped', () => {
    const html = sheetHtml('a <b> · sheet 1 of 1', [{ label: 'x&y.png', src: 'data:,' }], layoutFor(1440, 900));
    expect(html).toContain('a &lt;b&gt; · sheet 1 of 1');
    expect(html).toContain('x&amp;y.png');
    expect((html.match(/class="cell"/g) ?? []).length).toBe(1);
  });

  it('refuses 13 pictures, none, and a file that is not a picture', async () => {
    const dir = tempDir();
    const files = fixtures(13, dir);
    await expect(renderContactSheets([{ title: 't', images: files.map((file) => ({ file })), out: join(dir, 'o.png') }])).rejects.toThrow(/at most 12/);
    await expect(renderContactSheets([{ title: 't', images: [], out: join(dir, 'o.png') }])).rejects.toThrow(/no pictures/);
    writeFileSync(join(dir, 'bad.png'), 'not a png at all, no, not even close to one');
    await expect(renderContactSheets([{ title: 't', images: [{ file: join(dir, 'bad.png') }], out: join(dir, 'o.png') }])).rejects.toThrow(/not a PNG/);
    expect(MAX_CELLS).toBe(12);
  }, 60_000);

  it('draws a phone sheet and a last sheet with fewer than 12 cells', async () => {
    const dir = tempDir();
    const files = fixtures(5, dir, 390, 844);
    const [r] = await renderContactSheets([{ title: 'omar · 390×844 · sheet 2 of 2', images: files.map((file) => ({ file })), out: join(dir, 'm.png') }]);
    expect(r!.cells).toBe(5);
  }, 60_000);
});
