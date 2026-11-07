import { describe, expect, it } from 'vitest';
import { needsZip64, zipStream, type ZipEntry } from '../src/zip.ts';
import { readZip } from './zip-reader.ts';

// P20-13: the streaming zip writer, read back by a reader that checks every checksum.

const collect = async (entries: ZipEntry[]): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of zipStream(entries, new Date('2026-11-01T10:00:00Z'))) chunks.push(c);
  return Buffer.concat(chunks);
};
const bytes = (text: string, parts = 1): ZipEntry['open'] => async () =>
  (async function* () {
    const b = Buffer.from(text);
    const step = Math.max(1, Math.ceil(b.length / parts));
    for (let i = 0; i < b.length; i += step) yield b.subarray(i, i + step);
  })();

describe('zipStream', () => {
  it('writes folders, files (also from several chunks), empty files and UTF-8 names that read back exactly', async () => {
    const zip = await collect([
      { name: 'Notes/', size: 0 },
      { name: 'Notes/plan.md', size: 9, open: bytes('# the plan', 3) },
      { name: 'Meetings/empty.txt', size: 0, open: bytes('') },
      { name: 'Inbox/اجتماع 1.md', size: 4, open: bytes('نص') },
    ]);
    const read = readZip(zip);
    expect(read.map((e) => e.name)).toEqual(['Notes/', 'Notes/plan.md', 'Meetings/empty.txt', 'Inbox/اجتماع 1.md']);
    expect(read[1]!.data.toString()).toBe('# the plan');
    expect(read[2]!.data.length).toBe(0);
    expect(read[3]!.data.toString()).toBe('نص');
  });

  it('an archive with no entries is a valid, empty zip', async () => {
    expect(readZip(await collect([]))).toEqual([]);
  });

  it('the bytes are the real bytes: a large binary file survives', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const zip = await collect([{ name: 'a/big.bin', size: big.length, open: async () => (async function* () { yield big.subarray(0, 1_000_003); yield big.subarray(1_000_003); })() }]);
    expect(readZip(zip)[0]!.data.equals(big)).toBe(true);
  });

  it('chooses the zip64 form for an archive that could pass the old limits, and reads back the same', async () => {
    expect(needsZip64([{ name: 'x', size: 10 }])).toBe(false);
    expect(needsZip64([{ name: 'big', size: 5 * 1024 ** 3 }])).toBe(true);
    const many: ZipEntry[] = [];
    for (let i = 0; i < 65_600; i++) many.push({ name: `d/${i}/`, size: 0 });
    many.push({ name: 'd/file.txt', size: 3, open: bytes('abc') });
    expect(needsZip64(many)).toBe(true);
    const read = readZip(await collect(many));
    expect(read).toHaveLength(65_601);
    expect(read.at(-1)).toMatchObject({ name: 'd/file.txt' });
    expect(read.at(-1)!.data.toString()).toBe('abc');
  });
});
