import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type ArchiveLimits } from '../src/limits.ts';
import { ZipArchive, ZipRefused, isSafeEntryName, type ZipRefusal } from '../src/zip.ts';
import { slackExport } from './fixtures.ts';
import { buildZip, type ZipItem, type ZipOptions } from './zip-builder.ts';

// The zip reader against archives built to hurt it. Nothing here touches the database or the network, and nothing is ever extracted: a case passes when
// the reader refuses (or reads exactly what it declared) without using more memory or time than the limits allow.

let dir = '';
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-zip-test-'));
});
afterAll(async () => {
  await Promise.all(opened.map((z) => z.close().catch(() => undefined)));
  await rm(dir, { recursive: true, force: true });
});
const opened: ZipArchive[] = [];

const small: ArchiveLimits = { ...DEFAULT_LIMITS, maxEntryBytes: 1024 * 1024, ratioFloorBytes: 64 * 1024, maxEntries: 50 };

async function open(items: readonly ZipItem[], options: ZipOptions = {}, limits: ArchiveLimits = small): Promise<ZipArchive> {
  const path = join(dir, `a${(n += 1)}.zip`);
  await writeFile(path, buildZip(items, options));
  const zip = await ZipArchive.open(path, limits);
  opened.push(zip);
  return zip;
}
async function openBytes(bytes: Buffer, limits: ArchiveLimits = small): Promise<ZipArchive> {
  const path = join(dir, `b${(n += 1)}.zip`);
  await writeFile(path, bytes);
  const zip = await ZipArchive.open(path, limits);
  opened.push(zip);
  return zip;
}
const refusal = async (p: Promise<unknown>): Promise<ZipRefusal> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ZipRefused) return err.code;
    throw err;
  }
  throw new Error('expected the archive to be refused');
};
const reasonsOf = (zip: ZipArchive): ZipRefusal[] => zip.refused.map((r) => r.reason);

describe('reading an honest archive', () => {
  it('lists and reads the entries of the Slack fixture', async () => {
    const zip = await openBytes(slackExport(), DEFAULT_LIMITS);
    expect(zip.refused).toEqual([]);
    const users = zip.find('users.json')!;
    expect(JSON.parse((await zip.read(users)).toString('utf8'))).toHaveLength(7);
    expect(zip.entries.some((e) => e.name === 'general/2024-03-04.json')).toBe(true);
    await zip.close();
  });

  it('reads stored and deflated entries and an empty entry', async () => {
    const zip = await open([
      { name: 'a.txt', data: 'stored text', method: 0 },
      { name: 'b.txt', data: 'deflated text '.repeat(50) },
      { name: 'empty.txt', data: '', method: 0 },
    ]);
    expect((await zip.read(zip.find('a.txt')!)).toString()).toBe('stored text');
    expect((await zip.read(zip.find('b.txt')!)).toString()).toBe('deflated text '.repeat(50));
    expect((await zip.read(zip.find('empty.txt')!)).length).toBe(0);
    await zip.close();
  });

  it('reads an archive with a zip64 tail and one with the end-record signature inside its comment', async () => {
    const z64 = await open([{ name: 'x.json', data: '[1]' }], { zip64: true });
    expect((await z64.read(z64.find('x.json')!)).toString()).toBe('[1]');
    const tricky = await open([{ name: 'x.json', data: '[2]' }], { comment: 'PK\u0005\u0006 not the end of the archive' });
    expect((await tricky.read(tricky.find('x.json')!)).toString()).toBe('[2]');
  });

  it('skips the folders and files a Mac adds without calling them refused', async () => {
    const zip = await open([{ name: 'ok.json', data: '[]' }, { name: '__MACOSX/._ok.json', data: 'x' }, { name: 'dir/' }, { name: 'dir/.DS_Store', data: 'x' }]);
    expect(zip.entries.map((e) => e.name)).toEqual(['ok.json']);
    expect(zip.refused).toEqual([]);
  });
});

describe('names that leave the archive', () => {
  const bad = ['../evil.json', 'a/../../evil.json', '/etc/passwd', 'C:\\Windows\\x.json', 'C:/x.json', 'a\\b.json', 'a//b.json', './x.json', 'a/./b.json', 'nul\u0000.json', 'tab\t.json', '..', ' ..', 'a/ ../b', '...'];
  it.each(bad)('refuses %j', async (name) => {
    const zip = await open([{ name: 'ok.json', data: '[]' }, { name, data: 'x' }]);
    expect(zip.entries.map((e) => e.name)).toEqual(['ok.json']);
    expect(reasonsOf(zip)).toEqual(['unsafe_name']);
  });

  it('accepts ordinary nested names and refuses ones nested absurdly deep or long', () => {
    expect(isSafeEntryName('general/2024-03-04.json')).toBe(true);
    expect(isSafeEntryName('__uploads/F01/plan.pdf')).toBe(true);
    expect(isSafeEntryName(Array.from({ length: 40 }, () => 'd').join('/') + '/x')).toBe(false);
    expect(isSafeEntryName('x'.repeat(600))).toBe(false);
    expect(isSafeEntryName('')).toBe(false);
  });

  it('never reports a refused entry under its raw name (control characters are replaced)', async () => {
    const zip = await open([{ name: 'bad\u0007name/../x', data: 'x' }]);
    // eslint-disable-next-line no-control-regex
    expect(zip.refused[0]!.name).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('entries that are not plain files', () => {
  it('refuses a symbolic link, a device and a named pipe, and reads the file beside them', async () => {
    const zip = await open([
      { name: 'ok.json', data: '[]' },
      { name: 'link.json', data: '/etc/passwd', mode: 0o120777 },
      { name: 'dev', data: '', mode: 0o020666 },
      { name: 'pipe', data: '', mode: 0o010644 },
    ]);
    expect(zip.entries.map((e) => e.name)).toEqual(['ok.json']);
    expect(reasonsOf(zip)).toEqual(['symlink', 'special_file', 'special_file']);
  });

  it('refuses an encrypted entry and a method it does not know', async () => {
    const zip = await open([{ name: 'secret.json', data: 'x', flags: 0x801 }, { name: 'bz.json', data: 'x', method: 12 }, { name: 'ok.json', data: '[]' }]);
    expect(reasonsOf(zip)).toEqual(['encrypted', 'unsupported_method']);
    expect(zip.entries.map((e) => e.name)).toEqual(['ok.json']);
  });

  it('refuses every copy of a name that appears twice', async () => {
    const zip = await open([{ name: 'users.json', data: '[1]' }, { name: 'users.json', data: '[2]' }, { name: 'ok.json', data: '[]' }]);
    expect(reasonsOf(zip)).toEqual(['duplicate_name', 'duplicate_name']);
    expect(zip.find('users.json')).toBeUndefined();
  });

  it('refuses entries whose stored bytes overlap', async () => {
    const first = buildZip([{ name: 'a.json', data: 'x'.repeat(500), method: 0 }]);
    expect(first.length).toBeGreaterThan(0);
    const zip = await open([{ name: 'a.json', data: 'x'.repeat(500), method: 0 }, { name: 'b.json', data: 'y'.repeat(500), method: 0, offset: 10 }]);
    expect(reasonsOf(zip)).toEqual(['overlapping_data', 'overlapping_data']);
    expect(zip.entries).toHaveLength(0);
  });
});

describe('sizes that lie, and bombs', () => {
  it('refuses at once an entry that declares 2 GB out of a few bytes', async () => {
    const zip = await open([{ name: 'big.json', data: 'tiny', declaredSize: 2 * 1024 ** 3 }, { name: 'ok.json', data: '[]' }]);
    expect(reasonsOf(zip)).toEqual(['compression_ratio']);
    expect(zip.entries.map((e) => e.name)).toEqual(['ok.json']);
  });

  it('refuses a bomb that tells the truth by its ratio, without inflating it', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const zip = await open([{ name: 'zeros.json', data: zeros }]);
    expect(reasonsOf(zip)).toEqual(['compression_ratio']);
  });

  it('stops a bomb that lies about its size at the size it declared', async () => {
    const zeros = Buffer.alloc(32 * 1024 * 1024);
    const zip = await open([{ name: 'liar.json', data: zeros, declaredSize: 100 }]);
    expect(zip.entries).toHaveLength(1);
    let seen = 0;
    const code = await refusal(
      (async () => {
        for await (const chunk of zip.stream(zip.find('liar.json')!)) seen += chunk.length;
      })(),
    );
    expect(code).toBe('size_mismatch');
    expect(seen).toBeLessThanOrEqual(100);
  });

  it('refuses an entry shorter than it declared, and one with a size over the per-entry limit', async () => {
    const zip = await open([{ name: 'short.json', data: 'abc', declaredSize: 50 }, { name: 'large.json', data: randomBytes(1024 * 1024).toString('hex'), method: 8 }]);
    expect(await refusal(zip.read(zip.find('short.json')!))).toBe('size_mismatch');
    expect(await refusal(zip.read(zip.find('large.json')!))).toBe('entry_too_large');
  });

  it('refuses a stored entry whose two sizes differ', async () => {
    const zip = await open([{ name: 'odd.json', data: 'abcdef', method: 0, declaredSize: 3 }]);
    expect(reasonsOf(zip)).toEqual(['size_mismatch']);
  });

  it('refuses a local header that names another file than the directory does', async () => {
    const zip = await open([{ name: 'a.json', data: '[1]', localName: 'b.json' }]);
    expect(await refusal(zip.read(zip.find('a.json')!))).toBe('corrupt');
  });

  it('refuses an archive that holds more once unpacked than the total limit', async () => {
    const items = Array.from({ length: 5 }, (_v, i) => ({ name: `f${i}.json`, data: 'x'.repeat(2000) }));
    expect(await refusal(open(items, {}, { ...small, maxTotalBytes: 5000 }))).toBe('total_too_large');
  });

  it('inflates a deflate stream in linear time and bounded chunks', async () => {
    const text = JSON.stringify(Array.from({ length: 20_000 }, (_v, i) => ({ ts: i, text: `message ${i}` })));
    const big: ArchiveLimits = { ...small, maxEntryBytes: 8 * 1024 * 1024 };
    const zip = await open([{ name: 'day.json', data: text }], {}, big);
    const started = Date.now();
    expect((await zip.read(zip.find('day.json')!)).toString()).toBe(text);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('archives that are not archives', () => {
  it('refuses text, an empty file, a truncated zip and a zip with its end cut off', async () => {
    expect(await refusal(openBytes(Buffer.from('this is not a zip file at all, just some text')))).toBe('not_a_zip');
    expect(await refusal(openBytes(Buffer.alloc(0)))).toBe('not_a_zip');
    const whole = buildZip([{ name: 'a.json', data: '[]' }]);
    expect(await refusal(openBytes(whole.subarray(0, whole.length - 10)))).toBe('not_a_zip');
    expect(await refusal(openBytes(whole.subarray(0, 20)))).toBe('not_a_zip');
  });

  it('refuses more entries than the limit, whatever the end record claims', async () => {
    const items = Array.from({ length: 60 }, (_v, i) => ({ name: `f${i}.json`, data: '[]' }));
    expect(await refusal(open(items))).toBe('too_many_entries');
    expect(await refusal(open([{ name: 'a.json', data: '[]' }], { claimEntries: 60_000 }))).toBe('too_many_entries');
  });

  it('refuses a directory whose entry count does not match what is in it', async () => {
    expect(await refusal(open([{ name: 'a.json', data: '[]' }], { claimEntries: 5 }))).toBe('corrupt');
  });

  it('refuses a name that is not text when the entry says it is, and reads an old Latin-1 name', async () => {
    expect(await refusal(open([{ name: 'x', rawName: Buffer.from([0x61, 0xff, 0xfe, 0x2e, 0x6a]), data: 'x' }]))).toBe('corrupt');
    const zip = await open([{ name: 'x', rawName: Buffer.from([0x61, 0xe9, 0x2e, 0x6a, 0x73, 0x6f, 0x6e]), data: 'x', flags: 0 }]);
    expect(zip.entries).toHaveLength(1);
  });

  it('refuses a raw deflate stream that is garbage', async () => {
    const garbage = deflateRawSync(Buffer.from('hello hello hello hello')).subarray(0, 5);
    expect(garbage.length).toBe(5);
    const zip = await open([{ name: 'bad.json', data: 'x'.repeat(30), declaredCompressed: 5 }]);
    expect(zip.entries.length + zip.refused.length).toBe(1);
  });
});
