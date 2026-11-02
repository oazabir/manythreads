import { randomBytes } from 'node:crypto';
import { expectLinear } from '@manythreads/test-utils/linear';
import { DEFAULT_LIMITS, ExtractError, extract, extractDocx } from '@manythreads/sdk/extract/core';
import { describe, expect, it } from 'vitest';
import { buildZip, sampleDocx, sampleEml, samplePptx, sampleXlsx } from './zipkit.ts';

// P8-16: the Office and email readers behind the memory inbox. Honest files first, then the hostile block: every bad file must end in a plain
// refusal or a bounded result, never a hang, a crash or an out-of-memory.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Word documents', () => {
  it('reads headings, paragraphs, table rows and footnotes in order', async () => {
    const out = await extract(sampleDocx(), 'docx');
    expect(out.text).toContain('# Q3 planning');
    expect(out.text).toContain('# Goals');
    expect(out.text).toContain('Ship the inbox & the board by October.');
    expect(out.text).toContain('Owner | Task');
    expect(out.text).toContain('Sameera | Write the runbook');
    expect(out.text).toContain('A footnote about budgets');
    expect(out.text).not.toContain('PAGE');
    expect(out.text).toContain('after the field');
    expect(out.metadata.title).toBe('Q3 planning');
    expect(out.metadata.sections.map((s) => s.label)).toContain('Goals');
  });

  it('refuses an old binary .doc with a plain reason', async () => {
    await expect(extract(enc('\xD0\xCF\x11\xE0 not a zip'), 'docx')).rejects.toThrow(/not a .*docx|zip|older/i);
  });

  it('refuses a zip that is not a Word document', async () => {
    const e = await extract(buildZip([{ name: 'hello.txt', data: 'hi' }]), 'docx').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExtractError);
  });
});

describe('PowerPoint decks', () => {
  it('reads slides in numeric order with speaker notes', async () => {
    const out = await extract(samplePptx(), 'pptx');
    const kick = out.text.indexOf('Kickoff');
    const road = out.text.indexOf('Roadmap');
    expect(kick).toBeGreaterThanOrEqual(0);
    expect(road).toBeGreaterThan(kick);
    expect(out.text).toContain('Welcome everyone');
    expect(out.text).toContain('Mention the email door');
    expect(out.metadata.slides).toBe(2);
  });
});

describe('Excel workbooks', () => {
  it('reads each sheet as rows of "column: value", shared and inline strings, numbers and booleans', async () => {
    const out = await extract(sampleXlsx(), 'xlsx');
    expect(out.text).toContain('Budget');
    expect(out.text).toContain('Hiring & roles');
    expect(out.text).toContain('Item: Laptops');
    expect(out.text).toContain('Cost: 1200');
    expect(out.text).toContain('Designer');
    expect(out.metadata.sheets).toBe(2);
  });
});

describe('Email files', () => {
  it('reads the headers, prefers the plain text part, decodes the subject and lists attachments as children', async () => {
    const out = await extract(sampleEml(), 'eml');
    expect(out.text).toContain('Subject: Renewal – contract 42');
    expect(out.text).toContain('From: Éloise <eloise@example.com>');
    expect(out.text).toContain('The renewal is due on 1 December – please confirm.');
    expect(out.text).not.toContain('HTML copy of the renewal');
    expect(out.text).not.toContain('steal()');
    expect(out.metadata.title).toBe('Renewal – contract 42');
    expect(out.metadata.headers?.['authentication-results']).toContain('spf=pass');
    const names = (out.children ?? []).map((c) => c.name);
    expect(names).toContain('contract.pdf');
    expect(names.some((n) => n.endsWith('.eml'))).toBe(true);
    // the 1x1 tracking picture has no file name: dropped
    expect(out.children?.some((c) => c.mime === 'image/gif')).toBe(false);
  });

  it('falls back to the HTML part, with scripts removed, when there is no plain part', async () => {
    const eml = ['From: a@example.com', 'Subject: html only', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello <b>there</b></p><script>bad()</script>'].join('\r\n');
    const out = await extract(enc(eml), 'eml');
    expect(out.text).toContain('Hello');
    expect(out.text).not.toContain('bad()');
  });

  it('survives a message with no body and no headers at all', async () => {
    const out = await extract(enc(''), 'eml').catch((x: unknown) => x);
    expect(out instanceof ExtractError || typeof (out as { text?: string }).text === 'string').toBe(true);
  });
});

describe('hostile Office and email files', () => {
  it('refuses a zip entry that declares a size over the limit before inflating anything', async () => {
    const zip = buildZip([{ name: 'word/document.xml', data: randomBytes(1024), declaredSize: 900 * 1024 * 1024 }]);
    await expect(extract(zip, 'docx')).rejects.toBeInstanceOf(ExtractError);
  });

  it('refuses a zip bomb: a small part that unpacks hundreds of times larger', async () => {
    const body = `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${'a'.repeat(30 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
    const zip = buildZip([{ name: 'word/document.xml', data: body }]);
    expect(zip.length).toBeLessThan(200 * 1024);
    await expect(extract(zip, 'docx')).rejects.toBeInstanceOf(ExtractError);
  });

  it('refuses an encrypted part', async () => {
    const zip = buildZip([{ name: 'word/document.xml', data: '<w:document/>', encrypted: true }]);
    await expect(extract(zip, 'docx')).rejects.toBeInstanceOf(ExtractError);
  });

  it('refuses a file with a corrupt zip directory', async () => {
    const zip = sampleDocx();
    const cut = zip.slice(0, zip.length - 30);
    await expect(extract(cut, 'docx')).rejects.toBeInstanceOf(ExtractError);
  });

  it('reads XML nested fifty thousand levels deep without blowing the stack', async () => {
    const depth = 50_000;
    const xml = `<w:document xmlns:w="w"><w:body>${'<w:sdt>'.repeat(depth)}<w:p><w:r><w:t>deep</w:t></w:r></w:p>${'</w:sdt>'.repeat(depth)}</w:body></w:document>`;
    const out = await extract(buildZip([{ name: 'word/document.xml', data: xml }]), 'docx').catch((x: unknown) => x);
    expect(out instanceof ExtractError || typeof (out as { text?: string }).text === 'string').toBe(true);
  });

  it('does not expand entities: a billion-laughs document yields plain text, not memory use', async () => {
    const dtd = '<!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
    const xml = `${dtd}<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&c;&c;&c;</w:t></w:r></w:p></w:body></w:document>`;
    const out = await extract(buildZip([{ name: 'word/document.xml', data: xml }]), 'docx');
    expect(out.text.length).toBeLessThan(1000);
  });

  it.each([
    ['one huge paragraph', (n: number) => `<w:p><w:r><w:t>${'word '.repeat(n / 5)}</w:t></w:r></w:p>`],
    ['many tiny paragraphs', (n: number) => '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(n / 30)],
    ['many entities', (n: number) => `<w:p><w:r><w:t>${'&amp;&#65;'.repeat(n / 10)}</w:t></w:r></w:p>`],
    ['unclosed tags', (n: number) => `${'<w:p><w:r>'.repeat(n / 10)}<w:t>end</w:t>`],
  ])('costs the same per byte whatever the shape: %s', (label, body) => {
    expectLinear(
      (n) => buildZip([{ name: 'word/document.xml', data: `<w:document xmlns:w="w"><w:body>${body(n)}</w:body></w:document>` }]),
      (bytes) => extractDocx(bytes, DEFAULT_LIMITS),
      { n: 40_000, label: `docx ${label}` },
    );
  });

  it('keeps a spreadsheet with many thin rows bounded', async () => {
    const rows = Array.from({ length: 120_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const zip = buildZip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Big" sheetId="1"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rows}</sheetData></worksheet>` },
    ]);
    const out = await extract(zip, 'xlsx');
    expect(out.metadata.truncated).toBe(true);
  });

  it('keeps an email with thousands of nested multipart boundaries bounded', async () => {
    const parts: string[] = ['From: a@example.com', 'Subject: nest', 'Content-Type: multipart/mixed; boundary="b0"', ''];
    for (let i = 0; i < 300; i++) parts.push(`--b${i}`, `Content-Type: multipart/mixed; boundary="b${i + 1}"`, '');
    parts.push('--b300', 'Content-Type: text/plain', '', 'bottom');
    const out = await extract(enc(parts.join('\r\n')), 'eml').catch((x: unknown) => x);
    expect(out instanceof ExtractError || typeof (out as { text?: string }).text === 'string').toBe(true);
  });

  it('caps the attachments of an email at a fixed count', async () => {
    const parts = ['From: a@example.com', 'Subject: many', 'Content-Type: multipart/mixed; boundary="m"', ''];
    for (let i = 0; i < 60; i++) parts.push('--m', `Content-Type: text/plain; name="f${i}.txt"`, `Content-Disposition: attachment; filename="f${i}.txt"`, '', `file ${i}`);
    parts.push('--m--', '');
    const out = await extract(enc(parts.join('\r\n')), 'eml');
    expect((out.children ?? []).length).toBeLessThanOrEqual(20);
  });
});
