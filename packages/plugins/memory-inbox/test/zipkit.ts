import { crc32, deflateRawSync } from 'node:zlib';

// Builds small zip files by hand for the extractor tests: the Office files are zips of XML parts, and the hostile cases need entries whose declared size
// does not match what is inside (a bomb that lies about its size) or a size that is simply far too large.

export interface ZipPart {
  name: string;
  data: Uint8Array | string;
  /** Store without compressing. */
  stored?: boolean;
  /** Write this as the declared (uncompressed) size in both headers, whatever the data is. */
  declaredSize?: number;
  /** Set the "encrypted" flag. */
  encrypted?: boolean;
}

const bytesOf = (d: Uint8Array | string): Uint8Array => (typeof d === 'string' ? new TextEncoder().encode(d) : d);

export function buildZip(parts: ZipPart[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = bytesOf(part.data);
    const packed = part.stored ? Buffer.from(raw) : deflateRawSync(raw);
    const name = Buffer.from(part.name, 'utf8');
    const size = part.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const flags = part.encrypted ? 1 : 0;
    const method = part.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, dir, eocd]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx with a title, a heading, a paragraph, a table and a footnote. */
export function sampleDocx(): Uint8Array {
  const p = (text: string, style?: string): string =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text: string): string => `<w:tc>${p(text)}</w:tc>`;
  const body = [
    p('Q3 planning', 'Title'),
    p('Goals', 'Heading1'),
    p('Ship the inbox &amp; the board by <October>.'.replace('<October>', 'October')),
    `<w:tbl><w:tr>${cell('Owner')}${cell('Task')}</w:tr><w:tr>${cell('Sameera')}${cell('Write the runbook')}</w:tr></w:tbl>`,
    '<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>after the field</w:t></w:r></w:p>',
  ].join('');
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: 'word/footnotes.xml', data: `<w:footnotes ${W}><w:footnote>${p('A footnote about budgets')}</w:footnote></w:footnotes>` },
  ]);
}

/** A .pptx with two slides, the second with speaker notes. */
export function samplePptx(): Uint8Array {
  const p = (t: string): string => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const slide = (...lines: string[]): string => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>${lines.map(p).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return buildZip([
    { name: 'ppt/slides/slide2.xml', data: slide('Roadmap', 'Inbox first, sharing later') },
    { name: 'ppt/slides/slide1.xml', data: slide('Kickoff', 'Welcome everyone') },
    { name: 'ppt/notesSlides/notesSlide2.xml', data: `<p:notes xmlns:a="a" xmlns:p="p">${p('Mention the email door')}${p('2')}</p:notes>` },
  ]);
}

/** An .xlsx with two sheets: shared strings, an inline string, a number, a boolean and a skipped column. */
export function sampleXlsx(): Uint8Array {
  return buildZip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Budget" sheetId="1"/><sheet name="Hiring &amp; roles" sheetId="2"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Lap</t></r><r><t>tops</t></r></si><si><t>Role</t></si></sst>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Paid</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Designer</t></is></c></row></sheetData></worksheet>',
    },
  ]);
}

const CRLF = '\r\n';

/** A multipart/alternative email with an encoded subject, a base64 attachment, an inline tracking pixel and a forwarded message. */
export function sampleEml(): Uint8Array {
  const pdfLike = Buffer.from('%PDF-1.4 fake attachment bytes').toString('base64');
  const lines = [
    'From: =?UTF-8?B?w4lsb2lzZQ==?= <eloise@example.com>',
    'To: Support <support@example.com>',
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    'Subject: =?UTF-8?Q?Renewal_=E2=80=93_contract_42?=',
    'Message-ID: <abc@example.com>',
    'Authentication-Results: mx.example.com; spf=pass; dkim=pass',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello team,=0A=0AThe renewal is due on 1 December =E2=80=93 please confirm.',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><script>steal()</script><p>HTML copy of the renewal</p><img src="https://t.example/p.gif" width=1 height=1></body></html>',
    '--inner--',
    '--outer',
    'Content-Type: image/gif',
    'Content-ID: <pixel>',
    'Content-Transfer-Encoding: base64',
    '',
    'R0lGODlhAQABAAAAACw=',
    '--outer',
    'Content-Type: application/pdf; name="contract.pdf"',
    'Content-Disposition: attachment; filename="contract.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdfLike,
    '--outer',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment',
    '',
    'From: old@example.com',
    'Subject: Earlier thread',
    '',
    'Earlier text.',
    '--outer--',
    '',
  ];
  return new TextEncoder().encode(lines.join(CRLF));
}
