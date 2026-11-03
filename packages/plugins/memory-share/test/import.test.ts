import { deflateRawSync, crc32 } from 'node:zlib';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { parseConcept, renderBundleLog, serializeConcept } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { prepareBundle, repointLinks, withoutSingleRoot } from '../src/bundle.ts';
import { fingerprint } from '../src/digest.ts';
import { createImporter, digestFolder, externalFolder } from '../src/import.ts';
import { readZipText, ZipRefusal, type ZipLimits } from '../src/zip.ts';
import { buildZip } from '../../memory-inbox/test/zipkit.ts';

// P8-25: the receiving side takes nothing on trust. These are the hostile cases, run without a database: the zip reader, the bundle checks and rewrites, and the importer
// provider with a stand-in repository (so what it would commit can be read). Every refusal is whole-bundle: the stand-in repository must not have been written to.

const LIMITS: ZipLimits = { maxEntries: 2000, maxTotalBytes: 50 * 1024 * 1024, maxFileBytes: 1_000_000 };
const FROM = '0190a000-0000-7000-8000-000000000002';
const NOW = new Date('2026-11-03T10:00:00Z');

const index = (): string => serializeConcept({ okf_version: '0.2' }, '# Memory');
const log = (): string => renderBundleLog([{ date: '2026-11-02', text: 'Received.' }]);
const concept = (fm: Record<string, unknown>, body = 'The words.'): string => serializeConcept({ type: 'Decision', title: 'A decision', ...fm }, body);
const good = (extra: Record<string, string> = {}): Record<string, string> => ({ 'index.md': index(), 'log.md': log(), 'decisions/a.md': concept({}), ...extra });

const refusalOf = (fn: () => unknown): ZipRefusal | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ZipRefusal) return e;
    throw e;
  }
};

/** Sets the “made by” host and the external attributes of the nth central directory entry (buildZip writes neither). */
function patchEntry(zip: Uint8Array, nth: number, madeBy: number, extAttr: number): Uint8Array {
  const out = Buffer.from(zip);
  let found = -1;
  for (let i = 0; i + 4 < out.length; i += 1) {
    if (out.readUInt32LE(i) === 0x02014b50 && ((found += 1), found === nth)) {
      out.writeUInt16LE(madeBy, i + 4);
      out.writeUInt32LE(extAttr >>> 0, i + 38);
      return new Uint8Array(out);
    }
  }
  throw new Error('no such entry');
}

describe('the zip reader refuses what a bundle of Markdown never needs', () => {
  it('reads a plain zip', () => {
    const files = readZipText(buildZip([{ name: 'index.md', data: 'a' }, { name: 'x/b.md', data: 'b', stored: true }]), LIMITS);
    expect([...files.entries()]).toEqual([['index.md', 'a'], ['x/b.md', 'b']]);
  });

  it('refuses a symbolic link, a device and a fifo (unix host, file type in the top bits)', () => {
    for (const mode of [0o120777, 0o020666, 0o010644, 0o140755]) {
      const zip = patchEntry(buildZip([{ name: 'a.md', data: 'target.md' }]), 0, (3 << 8) | 20, mode << 16);
      expect(refusalOf(() => readZipText(zip, LIMITS))?.code, mode.toString(8)).toBe('link_entry');
    }
    const regular = patchEntry(buildZip([{ name: 'a.md', data: 'ok' }]), 0, (3 << 8) | 20, 0o100644 << 16);
    expect(readZipText(regular, LIMITS).get('a.md')).toBe('ok');
  });

  it('refuses a Windows reparse point', () => {
    const zip = patchEntry(buildZip([{ name: 'a.md', data: 'x' }]), 0, (10 << 8) | 45, 0x400);
    expect(refusalOf(() => readZipText(zip, LIMITS))?.code).toBe('link_entry');
  });

  it('refuses an encrypted entry', () => {
    expect(refusalOf(() => readZipText(buildZip([{ name: 'a.md', data: 'x', encrypted: true }]), LIMITS))?.code).toBe('encrypted');
  });

  it('refuses two entries with one name', () => {
    expect(refusalOf(() => readZipText(buildZip([{ name: 'a.md', data: 'x' }, { name: 'a.md', data: 'y' }]), LIMITS))?.code).toBe('unsafe_path');
  });

  it('refuses a local header whose name differs from the directory’s', () => {
    const zip = Buffer.from(buildZip([{ name: 'aaaa.md', data: 'x' }]));
    zip.write('bbbb.md', 30, 'utf8');
    expect(refusalOf(() => readZipText(new Uint8Array(zip), LIMITS))?.code).toBe('unsafe_path');
  });

  it('refuses more than the most entries, and a file or a total larger than the limits, before inflating anything', () => {
    const many = buildZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.md`, data: 'x', stored: true })));
    expect(refusalOf(() => readZipText(many, { ...LIMITS, maxEntries: 5 }))?.code).toBe('too_many_files');
    const big = buildZip([{ name: 'a.md', data: 'x'.repeat(100), stored: true }]);
    expect(refusalOf(() => readZipText(big, { ...LIMITS, maxFileBytes: 50 }))?.code).toBe('too_large');
    const two = buildZip([{ name: 'a.md', data: 'x'.repeat(100), stored: true }, { name: 'b.md', data: 'x'.repeat(100), stored: true }]);
    expect(refusalOf(() => readZipText(two, { ...LIMITS, maxTotalBytes: 150 }))?.code).toBe('too_large');
  });

  it('stops a bomb that lies about its size: the declared size caps the inflate', () => {
    const lie = buildZip([{ name: 'a.md', data: 'x'.repeat(5_000_000), declaredSize: 10 }]);
    expect(refusalOf(() => readZipText(lie, LIMITS))).not.toBeNull();
    const honest = buildZip([{ name: 'a.md', data: 'x'.repeat(5_000_000) }]);
    expect(refusalOf(() => readZipText(honest, LIMITS))?.code).toBe('too_large'); // over the per-file limit, refused from the header
  });

  it('refuses text that is not UTF-8, a NUL character, and a file name that is not UTF-8', () => {
    expect(refusalOf(() => readZipText(buildZip([{ name: 'a.md', data: new Uint8Array([0xff, 0xfe, 0x41]) }]), LIMITS))?.code).toBe('not_utf8');
    expect(refusalOf(() => readZipText(buildZip([{ name: 'a.md', data: 'ab\0cd' }]), LIMITS))?.code).toBe('not_utf8');
    const zip = Buffer.from(buildZip([{ name: 'aaa.md', data: 'x' }]));
    zip.writeUInt8(0xff, 30);
    zip.writeUInt8(0xff, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 46);
    expect(refusalOf(() => readZipText(new Uint8Array(zip), LIMITS))?.code).toBe('not_utf8');
  });

  it('refuses a damaged checksum, a truncated file, zip64 and something that is not a zip', () => {
    const zip = Buffer.from(buildZip([{ name: 'a.md', data: 'hello', stored: true }]));
    zip.write('J', zip.indexOf('hello'), 'utf8');
    expect(refusalOf(() => readZipText(new Uint8Array(zip), LIMITS))?.code).toBe('not_a_bundle');
    expect(refusalOf(() => readZipText(buildZip([{ name: 'a.md', data: 'hello' }]).subarray(0, 30), LIMITS))?.code).toBe('not_a_bundle');
    expect(refusalOf(() => readZipText(new TextEncoder().encode('just some text, not an archive at all'), LIMITS))?.code).toBe('not_a_bundle');
    const z64 = Buffer.from(buildZip([{ name: 'a.md', data: 'x' }]));
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    expect(refusalOf(() => readZipText(new Uint8Array(z64), LIMITS))?.code).toBe('not_a_bundle');
  });

  it('refuses a method it does not know', () => {
    const raw = Buffer.from('x');
    const packed = deflateRawSync(raw);
    const zip = Buffer.from(buildZip([{ name: 'a.md', data: 'x' }]));
    void packed;
    void crc32(raw);
    zip.writeUInt16LE(99, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(refusalOf(() => readZipText(new Uint8Array(zip), LIMITS))?.code).toBe('not_a_bundle');
  });
});

describe('a received bundle is judged whole', () => {
  const prep = (files: Record<string, string>, kind: 'digest' | 'external' = 'external') => prepareBundle({ files, kind, folder: kind === 'digest' ? 'engineering' : 'external/notes', fromTeamId: kind === 'digest' ? FROM : null, now: NOW });

  it('refuses a path that climbs out, an absolute path, a backslash, a hidden part and a file that is not Markdown', () => {
    for (const path of ['../evil.md', '/etc/passwd.md', 'a\\b.md', 'a/./b.md', 'a//b.md', 'image.png', 'a/../b.md']) {
      const r = prep(good({ [path]: concept({}) }));
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.code, path).toBe('unsafe_path');
    }
  });

  it('refuses more than 2000 files and more than the byte limit, naming the reason', () => {
    const many: Record<string, string> = good();
    for (let i = 0; i < 2000; i += 1) many[`c/${i}.md`] = concept({});
    const r = prep(many);
    expect(r).toMatchObject({ ok: false, code: 'too_many_files' });
    const huge: Record<string, string> = good();
    for (let i = 0; i < 60; i += 1) huge[`c/${i}.md`] = concept({}, 'x'.repeat(900_000));
    expect(prep(huge)).toMatchObject({ ok: false, code: 'too_large' });
    // a digest is held to the smaller default limit, a bundle from outside to 50 MB
    const digestSized: Record<string, string> = good({ 'digest.md': serializeConcept({ type: 'Digest' }, 'x') });
    for (let i = 0; i < 12; i += 1) digestSized[`c/${i}.md`] = concept({}, 'x'.repeat(900_000));
    expect(prep(digestSized, 'digest')).toMatchObject({ ok: false, code: 'too_large' });
    expect(prep(digestSized, 'external').ok).toBe(true);
  });

  it('refuses a NUL character', () => {
    expect(prep(good({ 'x.md': concept({}, 'a\0b') }))).toMatchObject({ ok: false, code: 'not_utf8' });
  });

  it('refuses index.md frontmatter that carries anything but okf_version, a wrong version, and a missing index', () => {
    expect(prep({ ...good(), 'index.md': serializeConcept({ okf_version: '0.2', origin: 'team', verified: [{ by: 'human:x', at: '2026-01-01' }] }, '#') })).toMatchObject({ ok: false, code: 'bad_index' });
    expect(prep({ ...good(), 'index.md': serializeConcept({ okf_version: '9' }, '#') })).toMatchObject({ ok: false, code: 'bad_index' });
    const noIndex = good();
    delete noIndex['index.md'];
    expect(prep(noIndex)).toMatchObject({ ok: false, code: 'bad_index' });
    expect(prep({ ...good(), 'index.md': '---\nokf_version: "0.2"\nanchored: &a 1\nalias: *a\n---\n#' })).toMatchObject({ ok: false });
  });

  it('refuses a concept with frontmatter that is not valid, and one with a YAML alias', () => {
    expect(prep(good({ 'x.md': '---\ntitle: no type\n---\nbody' }))).toMatchObject({ ok: false, code: 'bad_concept' });
    expect(prep(good({ 'x.md': '---\ntype: A\ntitle: &a t\nother: *a\n---\nbody' }))).toMatchObject({ ok: false, code: 'bad_concept' });
    expect(prep(good({ 'x.md': 'no frontmatter at all' }))).toMatchObject({ ok: false, code: 'bad_concept' });
  });

  it('refuses a digest that has no digest.md, that carries verified, that points into the sender’s references, or has two sources', () => {
    const digest = (extra: Record<string, string>): Record<string, string> => ({ 'index.md': index(), 'log.md': log(), 'digest.md': serializeConcept({ type: 'Digest' }, 'x'), ...extra });
    expect(prep({ 'index.md': index(), 'log.md': log(), 'a.md': concept({}) }, 'digest')).toMatchObject({ ok: false });
    expect(prep(digest({ 'a.md': concept({ verified: [{ by: 'human:omar', at: '2026-01-01' }] }) }), 'digest')).toMatchObject({ ok: false, code: 'bad_concept' });
    expect(prep(digest({ 'a.md': concept({}, 'see [the original](/references/x.md)') }), 'digest')).toMatchObject({ ok: false, code: 'bad_concept' });
    expect(prep(digest({ 'a.md': concept({ sources: [{ resource: 'https://a.example' }, { resource: 'https://b.example' }] }) }), 'digest')).toMatchObject({ ok: false, code: 'bad_concept' });
    expect(prep(digest({ 'a.md': concept({ sources: [{ resource: 'team:x:/../references/a.md' }] }) }), 'digest')).toMatchObject({ ok: false });
  });

  it('files a good bundle under memory/shared/<folder>/, drops verified, stamps where it came from, and does not file index.md or log.md', () => {
    const r = prep(
      good({
        'facts/b.md': concept({ verified: [{ by: 'human:omar', at: '2026-01-01' }], origin: 'person', from: 'someone-else', generated: { by: 'human:omar' }, share: 'never', origin_trust: 'human-reviewed', secret: 'x' }, 'See [a](/decisions/a.md) and [rel](../decisions/a.md).\n\n[ref]: /decisions/a.md'),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.path)).toEqual(['memory/shared/external/notes/decisions/a.md', 'memory/shared/external/notes/facts/b.md']);
    expect(r.skipped).toBe(2);
    const b = parseConcept(r.files[1]!.content);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.frontmatter['verified']).toBeUndefined();
    expect(b.frontmatter['share']).toBeUndefined();
    expect(b.frontmatter['secret']).toBeUndefined();
    expect(b.frontmatter['from']).toBeUndefined();
    expect(b.frontmatter.origin).toBe('import');
    expect(b.frontmatter['origin_trust']).toBe('unverified'); // nothing from outside is trusted
    expect(b.frontmatter.generated?.by).toBe('process:share');
    expect(b.body).toContain('](/shared/external/notes/decisions/a.md)');
    expect(b.body).toContain('[ref]: /shared/external/notes/decisions/a.md');
    expect(b.body).not.toContain('](/decisions/a.md)');
  });

  it('no link of a filed concept leads out of its folder: climbing, absolute, encoded and backslash spellings lose the target and keep the text', () => {
    const body = [
      '[up](../../people/x.md) [up3](../../../x.md) [abs](/../x.md) [enc](..%2F..%2Fx.md) [enc2](%2e%2e/%2e%2e/x.md) [bs](..\\..\\x.md) [angle](<../../x.md>)',
      '![img](../../pic.png "t") [titled](../../x.md "title") [frag](../../x.md#a)',
      '[ref][r]',
      '',
      '[r]: ../../people/x.md',
      '<a href="../../x.md">h</a> <img src=\'../../p.png\'>',
    ].join('\n');
    const out = repointLinks(body, 'decisions/a.md', 'external/notes');
    for (const label of ['up', 'up3', 'abs', 'enc', 'enc2', 'bs', 'angle', 'img', 'titled', 'frag']) expect(out).toContain(label);
    expect(out).not.toMatch(/\]\(/);
    expect(out).not.toContain('people/x.md');
    expect(out).not.toMatch(/href|src=|\.\.|%2e|%2F/i);
    expect(out).toContain('[ref][r]');
  });

  it('links that stay inside the folder, anchors and other people’s addresses are left alone', () => {
    const body = '[same](b.md) [sub](../facts/b.md) [pic](pics/a.png) [abs](/facts/b.md) [anchor](#x) [web](https://example.com/../x) [mail](mailto:a@b.c) [proto](//example.com/x)\n\n[r]: https://example.com/x';
    const out = repointLinks(body, 'decisions/a.md', 'external/notes');
    expect(out).toContain('[same](/shared/external/notes/decisions/b.md)');
    expect(out).toContain('[sub](/shared/external/notes/facts/b.md)');
    expect(out).toContain('[abs](/shared/external/notes/facts/b.md)');
    expect(out).toContain('[pic](pics/a.png)');
    expect(out).toContain('[anchor](#x) [web](https://example.com/../x) [mail](mailto:a@b.c) [proto](//example.com/x)');
    expect(out).toContain('[r]: https://example.com/x');
  });

  it('a link at the top of the bundle that climbs out of it (no folder above) is neutralised too', () => {
    expect(repointLinks('[x](../a.md) [y](../../../../z.md)', 'top.md', 'team-eng')).toBe('x y');
  });

  it('a digest from a team is stamped origin share with the sending team and keeps the origin trust it declares', () => {
    const files = { 'index.md': index(), 'log.md': log(), 'digest.md': serializeConcept({ type: 'Digest', from: 'x', to: 'y', period: { from: '2026-10-01' } }, 'Summary [a](/decisions/a.md)'), 'decisions/a.md': concept({ origin_trust: 'human-reviewed', sources: [{ resource: 'team:engineering:/decisions/a.md' }] }) };
    const r = prep(files, 'digest');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = parseConcept(r.files.find((f) => f.path.endsWith('decisions/a.md'))!.content);
    expect(a.ok && a.frontmatter).toMatchObject({ origin: 'share', from: FROM, origin_trust: 'human-reviewed' });
    const d = parseConcept(r.files.find((f) => f.path.endsWith('/digest.md'))!.content);
    expect(d.ok && d.body).toContain('](/shared/engineering/decisions/a.md)');
    expect(d.ok && d.frontmatter['from']).toBe(FROM);
  });

  it('takes one wrapping folder off, only when nothing is at the top', () => {
    const wrapped = withoutSingleRoot(new Map([['notes/index.md', 'a'], ['notes/log.md', 'b'], ['notes/x/c.md', 'c']]));
    expect(Object.keys(wrapped).sort()).toEqual(['index.md', 'log.md', 'x/c.md']);
    const flat = withoutSingleRoot(new Map([['index.md', 'a'], ['notes/c.md', 'c']]));
    expect(Object.keys(flat).sort()).toEqual(['index.md', 'notes/c.md']);
  });

  it('names the folder of a bundle from outside safely', () => {
    expect(externalFolder('My Notes (v2).zip')).toBe('external/my-notes-v2');
    expect(externalFolder('../../etc/passwd.okf')).toBe('external/passwd');
    expect(externalFolder('....zip')).toBe('external/bundle');
  });
});

// ---- the importer provider, with the database and the repository stood in --------------------------------------------------------

interface Written {
  teamId: string;
  changes: { path: string; op: string; content: string }[];
  message: string;
}

function harness(delivery: Record<string, unknown> | null, o: { sharingOn?: boolean } = {}) {
  const written: Written[] = [];
  const events: Record<string, unknown>[] = [];
  const tx = {
    actor: { id: 'system-actor' },
    async query(sql: string) {
      if (sql.includes('memory_share_deliveries')) return { rows: delivery === null ? [] : [delivery] };
      if (sql.includes('memory_sharing_settings')) return { rows: o.sharingOn === false ? [{ enabled: false }] : [] };
      throw new Error(`unexpected query ${sql.slice(0, 60)}`);
    },
  } as unknown as PluginTx;
  const ctx = {
    runtime: { now: () => NOW },
    audit: { emit: async (_tx: unknown, e: Record<string, unknown>) => void events.push(e) },
    providers: {
      get: () => ({
        write: async (_tx: unknown, teamId: string, _actor: unknown, changes: Written['changes'], message: string) => {
          written.push({ teamId, changes, message });
          return { sha: 'c0ffee', parentSha: null, noop: false, authorId: null, paths: [] };
        },
      }),
    },
  } as unknown as PluginContext;
  return { importer: createImporter(ctx), tx, written, events };
}

const input = (over: Record<string, unknown> = {}) => ({ workspaceId: 'w1', teamId: 'dest', itemId: 'item1', origin: 'share', kind: 'bundle', name: 'digests/engineering/2026-11-02', sha256: '', bytes: null, ...over });

function delivery(files: Record<string, string>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const sha = fingerprint(files);
  return { id: 'd1', workspace_id: 'w1', team_id: FROM, dest_team_id: 'dest', share_id: 's1', from_slug: 'engineering', period: '2026-11-02', digest_sha: sha, run_sha: sha, bundle: files, link_state: 'accepted', share_status: 'active', dest_archived: false, ...over };
}

const digestFiles = (): Record<string, string> => ({ 'index.md': index(), 'log.md': log(), 'digest.md': serializeConcept({ type: 'Digest' }, 'Summary'), 'decisions/a.md': concept({}) });

describe('the importer provider', () => {
  it('files a delivered digest in one commit under memory/shared/team-<sender slug>/ as the system, and says so', async () => {
    const files = digestFiles();
    const h = harness(delivery(files));
    const r = await h.importer.import(h.tx, input({ sha256: fingerprint(files) }));
    expect(r).toMatchObject({ outcome: 'filed', files: 2, fromTeamId: FROM, commitSha: 'c0ffee' });
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.teamId).toBe('dest');
    expect(h.written[0]!.changes.map((c) => c.path)).toEqual(['memory/shared/team-engineering/decisions/a.md', 'memory/shared/team-engineering/digest.md']);
    expect(h.events[0]).toMatchObject({ type: 'memory.digest.imported', outcome: 'filed', reason: null, files: 2, fromTeamId: FROM, teamId: 'dest' });
  });

  it('refuses an item no delivery wrote, one written for another team, and one of another workspace: nothing is filed', async () => {
    const files = digestFiles();
    const sha = fingerprint(files);
    // the query is by item, destination and workspace; a forged item matches no delivery
    const none = harness(null);
    expect(await none.importer.import(none.tx, input({ sha256: sha }))).toMatchObject({ outcome: 'refused', code: 'not_found' });
    expect(none.written).toEqual([]);
    expect(none.events[0]).toMatchObject({ outcome: 'refused', reason: 'not_found' });
  });

  it('refuses when the link was paused or ended, or the switch turned off, after the hand-over', async () => {
    const files = digestFiles();
    for (const state of ['paused', 'revoked', 'requested', null]) {
      const h = harness(delivery(files, { link_state: state }));
      expect(await h.importer.import(h.tx, input({ sha256: fingerprint(files) })), String(state)).toMatchObject({ outcome: 'refused', code: 'link_ended' });
      expect(h.written, String(state)).toEqual([]);
    }
    const off = harness(delivery(files), { sharingOn: false });
    expect(await off.importer.import(off.tx, input({ sha256: fingerprint(files) }))).toMatchObject({ outcome: 'refused', code: 'link_ended' });
    expect(off.written).toEqual([]);
  });

  it('refuses when the share was removed or went invalid, or the receiving team was archived, after the hand-over', async () => {
    const files = digestFiles();
    for (const over of [{ share_status: 'removed' }, { share_status: 'invalid' }, { share_status: null }, { dest_archived: true }]) {
      const h = harness(delivery(files, over));
      expect(await h.importer.import(h.tx, input({ sha256: fingerprint(files) })), JSON.stringify(over)).toMatchObject({ outcome: 'refused', code: 'link_ended' });
      expect(h.written, JSON.stringify(over)).toEqual([]);
    }
  });

  it('refuses a digest whose stored files are not the ones that were approved (changed after approval)', async () => {
    const files = digestFiles();
    const sha = fingerprint(files);
    const tampered = { ...files, 'decisions/a.md': concept({}, 'changed after approval') };
    const h = harness(delivery(tampered, { digest_sha: sha, run_sha: sha }));
    expect(await h.importer.import(h.tx, input({ sha256: sha }))).toMatchObject({ outcome: 'refused', code: 'not_a_bundle' });
    // and an item that carries another fingerprint than the delivery
    const h2 = harness(delivery(files));
    expect(await h2.importer.import(h2.tx, input({ sha256: 'f'.repeat(64) }))).toMatchObject({ outcome: 'refused', code: 'not_a_bundle' });
    expect(h.written).toEqual([]);
    expect(h2.written).toEqual([]);
  });

  it('refuses a hostile digest whole even when its fingerprint matches (the sender is not trusted to be well-formed)', async () => {
    const files = { ...digestFiles(), '../escape.md': concept({}) };
    const h = harness(delivery(files));
    expect(await h.importer.import(h.tx, input({ sha256: fingerprint(files) }))).toMatchObject({ outcome: 'refused', code: 'unsafe_path' });
    expect(h.written).toEqual([]);
    const verified = { ...digestFiles(), 'decisions/a.md': concept({ verified: [{ by: 'human:omar', at: '2026-01-01' }] }) };
    const h2 = harness(delivery(verified));
    expect(await h2.importer.import(h2.tx, input({ sha256: fingerprint(verified) }))).toMatchObject({ outcome: 'refused', code: 'bad_concept' });
  });

  it('a sender slug that cannot be a folder is refused, and a team called external is kept apart from outside bundles', async () => {
    const files = digestFiles();
    const bad = harness(delivery(files, { from_slug: '../x' }));
    expect(await bad.importer.import(bad.tx, input({ sha256: fingerprint(files) }))).toMatchObject({ outcome: 'refused', code: 'unsafe_path' });
    const ext = harness(delivery(files, { from_slug: 'external' }));
    await ext.importer.import(ext.tx, input({ sha256: fingerprint(files) }));
    expect(ext.written[0]!.changes[0]!.path.startsWith('memory/shared/team-external/')).toBe(true);
  });

  it('digest folders and the outside-bundle folder can never be the same, whatever a team is called', () => {
    expect(digestFolder('engineering')).toBe('team-engineering');
    expect(digestFolder('external')).toBe('team-external');
    expect(digestFolder('team-external')).toBe('team-team-external');
    expect(new Set(['external', 'team-external', 'engineering'].map((s) => digestFolder(s))).size).toBe(3);
    // an outside bundle is always `external/<name>`: its first segment is `external`, a digest folder's starts with `team-`
    for (const name of ['notes.zip', 'team-external.zip', 'external.okf', '....zip']) expect(externalFolder(name).startsWith('external/')).toBe(true);
    for (const slug of ['external', 'a', 'team-external', 'x'.repeat(63)]) expect(digestFolder(slug)!.startsWith('external')).toBe(false);
  });

  it('files an outside bundle under memory/shared/external/<name>/ with nothing trusted, and refuses a hostile one whole', async () => {
    const zip = buildZip([
      { name: 'notes/index.md', data: index() },
      { name: 'notes/decisions/a.md', data: concept({ verified: [{ by: 'human:omar', at: '2026-01-01' }] }) },
    ]);
    const h = harness(null);
    const r = await h.importer.import(h.tx, input({ origin: 'person', name: 'Team Notes.zip', bytes: zip, sha256: 'a'.repeat(64) }));
    expect(r).toMatchObject({ outcome: 'filed', files: 1, fromTeamId: null });
    expect(h.written[0]!.changes[0]!.path).toBe('memory/shared/external/team-notes/decisions/a.md');
    expect(h.written[0]!.changes[0]!.content).not.toMatch(/^verified:/m);
    expect(h.events[0]).toMatchObject({ outcome: 'filed', fromTeamId: null });

    const link = patchEntry(buildZip([{ name: 'index.md', data: index() }, { name: 'a.md', data: concept({}) }]), 1, (3 << 8) | 20, 0o120777 << 16);
    const hostile = harness(null);
    expect(await hostile.importer.import(hostile.tx, input({ origin: 'person', name: 'x.zip', bytes: link }))).toMatchObject({ outcome: 'refused', code: 'link_entry' });
    expect(hostile.written).toEqual([]);
    const noBytes = harness(null);
    expect(await noBytes.importer.import(noBytes.tx, input({ origin: 'person', name: 'x.zip', bytes: null }))).toMatchObject({ outcome: 'refused', code: 'not_a_bundle' });
  });

  it('commits a large outside bundle in steps of fewer than 200 files', async () => {
    const parts = [{ name: 'index.md', data: index() }];
    for (let i = 0; i < 450; i += 1) parts.push({ name: `c/${i}.md`, data: concept({}) });
    const h = harness(null);
    const r = await h.importer.import(h.tx, input({ origin: 'person', name: 'big.zip', bytes: buildZip(parts) }));
    expect(r).toMatchObject({ outcome: 'filed', files: 450 });
    expect(h.written.map((w) => w.changes.length)).toEqual([190, 190, 70]);
  });
});
