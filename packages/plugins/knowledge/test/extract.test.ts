import { deflateSync } from 'node:zlib';
import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, ExtractError, extract, extractCsv, extractMarkdown } from '../src/extract/core.ts';
import { extractText } from '../src/extract/index.ts';

// P8-32: the extractor. One interface, bounded in size and time, off the request path. The hostile-input block is the point: a huge file, deep
// nesting, a malformed PDF and a file that never finishes must each end in a plain refusal or a bounded result, never a hang or a crash.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A one-page PDF with the given text, built by hand (header, catalog, pages, page, content stream, font, cross-reference table). */
export function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

describe('the extractor, on honest files', () => {
  it('reads Markdown: the text as it is, headings as nested sections, code fences ignored', async () => {
    const md = '# Handbook\n\nIntro.\n\n## Refunds\n\nPaid in 14 days.\n\n```\n# not a heading\n```\n\n## Shipping\n\nTwo days.\n';
    const out = await extract(enc(md), 'markdown');
    expect(out.text).toBe(md);
    expect(out.metadata.title).toBe('Handbook');
    expect(out.metadata.sections.map((s) => s.label)).toEqual(['Handbook', 'Handbook > Refunds', 'Handbook > Shipping']);
    expect(md.slice(out.metadata.sections[1]!.start).startsWith('## Refunds')).toBe(true);
  });

  it('reads text with a byte order mark and Windows line breaks', async () => {
    const out = await extract(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('one\r\ntwo\r\n')]), 'text');
    expect(out.text).toBe('one\ntwo\n');
    expect(out.metadata.sections).toEqual([]);
  });

  it('reads CSV as one line per row with the column names, quotes and a semicolon separator included', async () => {
    const csv = 'name;plan;note\nAcme;"Pro; annual";"says ""hi""\nsecond line"\nGlobex;Free;\n';
    const out = await extract(enc(csv), 'csv');
    expect(out.text).toBe('name: Acme; plan: Pro; annual; note: says "hi" second line\nname: Globex; plan: Free');
    expect(out.metadata.rows).toBe(2);
    expect(out.metadata.sections[0]?.label).toBe('Rows 1 to 2');
  });

  it('reads the text of a PDF page by page', async () => {
    const out = await extract(minimalPdf('Refunds are paid within 14 days.'), 'pdf');
    expect(out.text).toContain('Refunds are paid within 14 days.');
    expect(out.metadata.pages).toBe(1);
    expect(out.metadata.sections.map((s) => s.label)).toEqual(['Page 1']);
  });

  it('runs in a worker thread through the host and returns the same thing', async () => {
    const out = await extractText(enc('# Title\n\nBody.'), 'markdown');
    expect(out.text).toBe('# Title\n\nBody.');
    const pdf = await extractText(minimalPdf('Hello from a PDF.'), 'pdf');
    expect(pdf.text).toContain('Hello from a PDF.');
  });
});

describe('the extractor, on hostile files', () => {
  it('refuses a file over the byte limit before reading any of it', async () => {
    await expect(extractText(new Uint8Array(2048), 'text', { maxBytes: 1024 })).rejects.toThrow(/larger than/);
  });

  it('keeps only the start of a huge text and says so', async () => {
    const big = enc('word '.repeat(300_000));
    const out = await extract(big, 'text');
    expect(out.text.length).toBe(DEFAULT_LIMITS.maxChars);
    expect(out.metadata.truncated).toBe(true);
  });

  it('refuses a binary file given as text', async () => {
    await expect(extract(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 1, 2]), 'text')).rejects.toThrow(/binary/);
  });

  it('refuses an empty file and a CSV with no rows, in plain words', async () => {
    await expect(extract(enc('   \n'), 'markdown')).rejects.toThrow(/No text/);
    await expect(extract(enc('a,b,c\n'), 'csv')).rejects.toThrow(/no rows/);
  });

  it('reads deeply nested Markdown and CSV quoting without recursion', async () => {
    const nested = `${'> '.repeat(50_000)}deep\n${'['.repeat(50_000)}${']'.repeat(50_000)}\n${'#'.repeat(5_000)} not a heading\n`;
    const out = await extract(enc(nested), 'markdown');
    expect(out.text.length).toBeGreaterThan(100_000);
    const quoted = `a,b\n${'"'.repeat(60_001)},x\n`;
    await expect(extract(enc(quoted), 'csv')).resolves.toBeTruthy();
  });

  it('bounds a CSV with huge cells and thousands of columns', async () => {
    const wide = `${Array.from({ length: 5_000 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 5_000 }, () => 'v'.repeat(5_000)).join(',')}\n`;
    const out = extractCsv(enc(wide), DEFAULT_LIMITS);
    expect(out.metadata.truncated).toBe(true);
    expect(out.text.split('; ').length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxColumns);
    expect(out.text.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxColumns * (DEFAULT_LIMITS.maxCellChars + 20));
  });

  it('reads a PDF that claims a huge page count within the page limit and the time limit, or refuses it plainly', async () => {
    const lying = enc(new TextDecoder().decode(minimalPdf('Text')).replace('/Count 1', '/Count 99999999'));
    const out = await extractText(lying, 'pdf', { timeoutMs: 15_000 }).then(
      (r) => r,
      (e: unknown) => e,
    );
    if (out instanceof ExtractError) expect(out.message).toMatch(/PDF|text|read/i);
    else expect((out as { metadata: { pages?: number } }).metadata.pages).toBeGreaterThan(0);
  });

  it('refuses a malformed PDF with a plain reason, whatever is wrong with it', async () => {
    const good = minimalPdf('Text');
    const cases: Array<[string, Uint8Array]> = [
      ['random bytes after the header', new Uint8Array([...enc('%PDF-1.7\n'), ...Array.from({ length: 4000 }, (_, i) => (i * 37 + 11) % 256)])],
      ['cut in half', good.subarray(0, good.length / 2)],
      ['header only', enc('%PDF-1.4\n')],
      ['not a PDF at all', enc('<html>hello</html>')],
      ['a catalog that points at itself', enc('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 1 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')],
    ];
    for (const [label, bytes] of cases) {
      const err = await extractText(bytes, 'pdf', { timeoutMs: 15_000 }).then(() => null, (e: unknown) => e);
      expect(err, label).toBeInstanceOf(ExtractError);
      expect((err as ExtractError).message, label).toMatch(/PDF|text|read/i);
    }
  });

  it('refuses a PDF with no text layer and says it may be a scan', async () => {
    const empty = minimalPdf('').subarray(0);
    const err = await extractText(empty, 'pdf').then(() => null, (e: unknown) => e);
    expect((err as ExtractError).message).toMatch(/No text was found/);
  });

  it('stops a PDF whose small compressed stream unpacks into hundreds of megabytes, before the process runs out of memory', async () => {
    const packed = deflateSync(Buffer.alloc(300 * 1024 * 1024, 0x20), { level: 9 });
    const parts = [
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>\nendobj\n',
      `4 0 obj\n<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`,
    ];
    const bomb = Buffer.concat([Buffer.from(parts.join('')), packed, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const err = await extractText(bomb, 'pdf', { maxGrowthBytes: 60 * 1024 * 1024, timeoutMs: 60_000 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as ExtractError).message).toMatch(/too much memory/);
  });

  it('stops a file that never finishes, at the time limit, and the next file is read as usual', async () => {
    const started = Date.now();
    const err = await extractText(enc('x'), 'text', { timeoutMs: 400, workerUrl: new URL('./hang-worker.ts', import.meta.url) }).then(() => null, (e: unknown) => e);
    expect((err as ExtractError).message).toMatch(/took too long/);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(extractText(enc('still fine'), 'text')).resolves.toMatchObject({ text: 'still fine' });
  });

  it.each([
    ['markdown with many headings', (n: number) => enc('# h\n'.repeat(n / 4))],
    ['one very long markdown line', (n: number) => enc(`# ${'a'.repeat(n)}`)],
    ['csv with many short rows', (n: number) => enc(`a,b\n${'1,2\n'.repeat(n / 4)}`)],
    ['csv with one very long quoted cell', (n: number) => enc(`a\n"${'q'.repeat(n)}"\n`)],
    ['text with many fences', (n: number) => enc('```\n'.repeat(n / 4))],
  ])('costs the same per byte whatever the shape: %s', (label, build) => {
    expectLinear(build, (bytes) => (label.startsWith('csv') ? extractCsv(bytes, DEFAULT_LIMITS) : extractMarkdown(bytes, DEFAULT_LIMITS, true)), { n: 40_000, label });
  });
});
