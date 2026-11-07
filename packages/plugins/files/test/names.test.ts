import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, asciiFallback, decodeHeaderName, numberedName, sanitizeFileName } from '../src/names.ts';

// P20-T1: the file-name rules every upload and rename goes through (channel files and Personal files alike). No database.

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('sanitizeFileName', () => {
  it('keeps an ordinary name as it is, including spaces inside and non-Latin letters', () => {
    expect(sanitizeFileName('release notes.md')).toBe('release notes.md');
    expect(sanitizeFileName('ملاحظات.md')).toBe('ملاحظات.md');
  });

  it('keeps only the last segment of any path the client sent', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\nadia\\plan.txt')).toBe('plan.txt');
    expect(sanitizeFileName('Notes/2026/todo.md')).toBe('todo.md');
  });

  it('never returns an empty name, a dot name or a hidden-file trick', () => {
    for (const raw of ['', '   ', '..', '...', '/', '\\', undefined, null]) expect(sanitizeFileName(raw), String(raw)).toBe('file');
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('name.')).toBe('name');
    expect(sanitizeFileName('name. . ')).toBe('name');
  });

  it('replaces the characters Windows refuses and strips control, bidi and zero-width characters', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.md')).toBe('a_b_c_d_e_f_g_h.md');
    expect(sanitizeFileName('plan\u202Efdp.md')).toBe('planfdp.md');
    expect(sanitizeFileName('pl\u200Ban\u0000.md')).toBe('plan.md');
    expect(sanitizeFileName('a\tb\nc.md')).toBe('a b c.md');
  });

  it('normalises to NFC so the same letters are one name', () => {
    expect(sanitizeFileName('cafe\u0301.md')).toBe('caf\u00e9.md');
  });

  it('cuts a long name to 255 UTF-8 bytes without splitting a character and keeps the extension', () => {
    const long = sanitizeFileName(`${'ا'.repeat(300)}.pdf`);
    expect(bytes(long)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(long).not.toContain('\uFFFD');
    const ascii = sanitizeFileName(`${'a'.repeat(400)}.md`);
    expect(bytes(ascii)).toBe(MAX_NAME_BYTES);
    expect(ascii.endsWith('.md')).toBe(true);
  });

  it('drops a very long "extension" rather than keeping it whole', () => {
    const odd = sanitizeFileName(`a.${'x'.repeat(400)}`);
    expect(bytes(odd)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});

describe('numberedName', () => {
  it('leaves the first name alone and numbers the next ones before the extension', () => {
    expect(numberedName('report.pdf', 1)).toBe('report.pdf');
    expect(numberedName('report.pdf', 2)).toBe('report (2).pdf');
    expect(numberedName('report.pdf', 15)).toBe('report (15).pdf');
  });

  it('numbers a name without an extension, and a name that is only an extension, at the end', () => {
    expect(numberedName('README', 3)).toBe('README (3)');
    expect(numberedName('.env', 2)).toBe('.env (2)');
  });

  it('numbers before the last extension only', () => {
    expect(numberedName('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
  });

  it('keeps the result inside 255 bytes however long the stem is', () => {
    const name = `${'b'.repeat(255 - 3)}.md`;
    const out = numberedName(name, 100);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(out.endsWith(' (100).md')).toBe(true);
  });
});

describe('decodeHeaderName and asciiFallback', () => {
  it('decodes a percent-encoded UTF-8 header and passes a missing one through', () => {
    expect(decodeHeaderName(encodeURIComponent('خطة 2026.md'))).toBe('خطة 2026.md');
    expect(decodeHeaderName(undefined)).toBeUndefined();
  });

  it('falls back to the raw text when the escape is malformed', () => {
    expect(decodeHeaderName('100%.md')).toBe('100%.md');
  });

  it('makes a Content-Disposition fallback that is plain ASCII with no quote, backslash or percent', () => {
    expect(asciiFallback('خطة "final" 100%.md')).toBe('___ _final_ 100_.md');
    expect(asciiFallback('a\\b.md')).toBe('a_b.md');
    expect(/^[\x20-\x7e]*$/.test(asciiFallback('naïve — café.md'))).toBe(true);
  });
});
