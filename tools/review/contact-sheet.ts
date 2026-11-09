// Contact sheets (PLAN P13-03, decision E35): up to 12 thumbnails with their file names on one picture, titled "persona · viewport · sheet n of m".
// No ImageMagick: the grid is an HTML page that Playwright's Chromium (already on the devbox) photographs.
//   tsx tools/review/contact-sheet.ts --title "omar · 1440×900 · sheet 1 of 5" --out contact-sheet.png a.png b.png … (at most 12)
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { loadChromium, type BrowserLike } from './lib/e2e-require.ts';

export const MAX_CELLS = 12;

export interface SheetImage {
  /** Absolute or relative path of the full-size picture. */
  file: string;
  /** What the cell says under the thumbnail (default: the file name). */
  label?: string;
}

export interface SheetLayout {
  columns: number;
  /** Size of the box a thumbnail is fitted into. */
  cellWidth: number;
  thumbHeight: number;
}

const GAP = 16;
const PAD = 20;

/** Landscape pictures (desktop) go four across, three rows; portrait pictures (phone) six across, two rows. */
export function layoutFor(width: number, height: number): SheetLayout {
  return height > width ? { columns: 6, cellWidth: 250, thumbHeight: 540 } : { columns: 4, cellWidth: 380, thumbHeight: 238 };
}

/** Width and height from the PNG header (no decoder needed). */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface SheetCell {
  label: string;
  src: string;
}

/** The page that is photographed. Every cell is `<figure class="cell">` with a thumbnail and a `<figcaption>` that holds the position and the label. */
export function sheetHtml(title: string, cells: readonly SheetCell[], layout: SheetLayout): string {
  const width = PAD * 2 + layout.columns * layout.cellWidth + (layout.columns - 1) * GAP;
  const figures = cells
    .map(
      (c, i) =>
        `<figure class="cell" data-cell="${i + 1}"><div class="thumb"><img src="${c.src}" alt=""></div>` +
        `<figcaption><span class="n">${i + 1}</span><span class="label">${escapeHtml(c.label)}</span></figcaption></figure>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}
body{margin:0;width:${width}px;padding:${PAD}px;background:#fff;color:#1b2430;font:14px/1.35 system-ui,sans-serif}
h1{margin:0 0 14px;font-size:20px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(${layout.columns},${layout.cellWidth}px);gap:${GAP}px}
.cell{margin:0;width:${layout.cellWidth}px}
.thumb{height:${layout.thumbHeight}px;border:1px solid #c8ced6;background:#f3f4f6;display:flex;align-items:flex-start;justify-content:center}
.thumb img{max-width:100%;max-height:100%;display:block}
figcaption{display:flex;gap:6px;margin-top:4px;font:12px/1.3 ui-monospace,monospace;word-break:break-all}
.n{flex:none;min-width:18px;text-align:center;background:#1b2430;color:#fff;border-radius:3px;padding:0 3px}
</style></head><body><h1 data-sheet-title>${escapeHtml(title)}</h1><div class="grid">
${figures}
</div></body></html>`;
}

export interface SheetJob {
  title: string;
  images: readonly SheetImage[];
  /** Where the sheet picture is written. */
  out: string;
}

export interface SheetResult {
  out: string;
  title: string;
  cells: number;
  labels: string[];
  width: number;
  height: number;
}

/** Renders the sheets one after the other in one browser. A picture that does not load fails the sheet and names the file. */
export async function renderContactSheets(jobs: readonly SheetJob[], browser?: BrowserLike): Promise<SheetResult[]> {
  for (const job of jobs) {
    if (job.images.length === 0) throw new Error(`contact sheet "${job.title}": no pictures`);
    if (job.images.length > MAX_CELLS) throw new Error(`contact sheet "${job.title}": ${job.images.length} pictures; a sheet holds at most ${MAX_CELLS}`);
  }
  const own = browser === undefined;
  const b = browser ?? (await loadChromium().launch({ headless: true }));
  const results: SheetResult[] = [];
  try {
    for (const job of jobs) {
      const buffers = job.images.map((i) => readFileSync(i.file));
      const first = pngSize(buffers[0]!);
      const layout = layoutFor(first.width, first.height);
      const cells = job.images.map((img, i) => ({
        label: img.label ?? basename(img.file),
        src: `data:image/png;base64,${buffers[i]!.toString('base64')}`,
      }));
      const width = PAD * 2 + layout.columns * layout.cellWidth + (layout.columns - 1) * GAP;
      const page = await b.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(sheetHtml(job.title, cells, layout), { waitUntil: 'load' });
        const state = await page.evaluate<{ broken: number[]; labels: string[]; cells: number; height: number }>(
          `(async () => {
            const imgs = Array.from(document.images);
            await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
            return {
              broken: imgs.map((i, n) => (i.naturalWidth > 0 ? -1 : n)).filter((n) => n >= 0),
              labels: Array.from(document.querySelectorAll('.cell .label')).map((e) => e.textContent),
              cells: document.querySelectorAll('.cell').length,
              height: Math.ceil(document.body.offsetHeight),
            };
          })()`,
        );
        if (state.broken.length > 0) throw new Error(`contact sheet "${job.title}": could not draw ${state.broken.map((n) => job.images[n]!.file).join(', ')}`);
        await page.setViewportSize({ width, height: state.height });
        const png = await page.screenshot({ fullPage: true, type: 'png' });
        mkdirSync(dirname(resolve(job.out)), { recursive: true });
        writeFileSync(job.out, png);
        results.push({ out: job.out, title: job.title, cells: state.cells, labels: state.labels, width, height: state.height });
      } finally {
        await page.close();
      }
    }
  } finally {
    if (own) await b.close();
  }
  return results;
}

/** `persona · 1440×900 · sheet 1 of 5` */
export const sheetTitle = (persona: string, viewport: { width: number; height: number }, n: number, of: number): string =>
  `${persona} · ${viewport.width}×${viewport.height} · sheet ${n} of ${of}`;

async function main(argv: readonly string[]): Promise<number> {
  let title = '';
  let out = '';
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--title') title = argv[(i += 1)] ?? '';
    else if (a === '--out') out = argv[(i += 1)] ?? '';
    else files.push(a);
  }
  if (!title || !out || files.length === 0) {
    console.error('usage: contact-sheet.ts --title "<persona · viewport · sheet n of m>" --out <sheet.png> <picture.png>… (at most 12)');
    return 2;
  }
  const [r] = await renderContactSheets([{ title, out, images: files.map((file) => ({ file })) }]);
  console.log(`contact sheet: ${r!.out} (${r!.cells} cells, ${r!.width}x${r!.height})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`contact sheet: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
