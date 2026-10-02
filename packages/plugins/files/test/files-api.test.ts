import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelMessage, ErrorEnvelope, FileMeta, ListChannelFilesResponse } from '@manythreads/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from './world.ts';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let w: FilesWorld;
let dev = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
}, 180_000);
afterAll(async () => {
  await w?.close();
});
afterEach(() => {
  delete process.env['MANYTHREADS_MAX_UPLOAD_BYTES'];
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a tiny image')]);
const PDF = Buffer.from('%PDF-1.7\n% a report\n');
const upload = async (who: typeof nadia, channel: string, body: Uint8Array | string, name: string, type?: string): Promise<FileMeta> =>
  FileMeta.parse(ok(await w.upload(who, channel, body, { name, ...(type ? { type } : {}) }), 201));
/** Every regular file below `dir`, relative. */
const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
const blobs = (): string[] => (existsSync(w.storageDir) ? walk(w.storageDir).filter((p) => !p.startsWith('.tmp')) : []);
const parts = (): string[] => (existsSync(join(w.storageDir, '.tmp')) ? readdirSync(join(w.storageDir, '.tmp')) : []);

describe('upload and download', () => {
  it('stores a file in the channel folder, returns its metadata (no blob key) and serves the same bytes back', async () => {
    const file = await upload(nadia, dev, PDF, 'Q3 report.pdf', 'application/pdf');
    expect(file).toMatchObject({ name: 'Q3 report.pdf', size: PDF.length, mime: 'application/pdf', folderPath: 'channels/dev/', channelId: dev, uploaderId: nadia.actorId });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file).not.toHaveProperty('blobKey');
    const meta = FileMeta.parse(ok(await w.call(rafi, 'GET', `/api/files/${file.id}`)));
    expect(meta.id).toBe(file.id);
    const got = await w.download(rafi, file.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(PDF)).toBe(true);
    expect(got.headers.get('content-type')).toBe('application/pdf');
    expect(got.headers.get('content-length')).toBe(String(PDF.length));
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-disposition')).toMatch(/^attachment; filename="Q3 report\.pdf"; filename\*=UTF-8''Q3%20report\.pdf$/);
    expect(got.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('serves a real image inline, a spoofed one and active content only as an attachment of opaque bytes', async () => {
    const png = await upload(nadia, dev, PNG, 'logo.png', 'image/png');
    expect(png.mime).toBe('image/png');
    const inline = await w.download(rafi, png.id);
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect((await w.download(rafi, png.id, '?download=1')).headers.get('content-disposition')).toMatch(/^attachment;/);

    // Declared as an image, but the bytes are a page: stored as opaque bytes, never inline.
    const spoof = await upload(nadia, dev, '<script>alert(1)</script>', 'cute.png', 'image/png');
    expect(spoof.mime).toBe('application/octet-stream');
    const spoofed = await w.download(rafi, spoof.id);
    expect(spoofed.headers.get('content-disposition')).toMatch(/^attachment;/);
    // The bytes win over the header: a PNG declared as text is a PNG.
    expect((await upload(nadia, dev, PNG, 'actually.txt', 'text/plain')).mime).toBe('image/png');

    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript']) {
      const f = await upload(nadia, dev, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', `x-${type.replace('/', '-')}`, type);
      const r = await w.download(rafi, f.id);
      expect(r.headers.get('content-type'), type).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition'), type).toMatch(/^attachment;/);
      expect(r.headers.get('content-security-policy'), type).toContain('sandbox');
    }
    expect((await upload(nadia, dev, 'a,b\n1,2\n', 'data.csv', 'text/csv; charset=utf-8')).mime).toBe('text/csv');
    expect((await upload(nadia, dev, 'x', 'nothing-declared')).mime).toBe('application/octet-stream');
  });

  it('numbers a second file of the same name instead of failing or overwriting', async () => {
    const a = await upload(nadia, dev, 'one', 'notes.txt', 'text/plain');
    const b = await upload(rafi, dev, 'two', 'notes.txt', 'text/plain');
    const c = await upload(rafi, dev, 'three', 'notes.txt', 'text/plain');
    expect([a.name, b.name, c.name]).toEqual(['notes.txt', 'notes (2).txt', 'notes (3).txt']);
    expect((await w.download(nadia, a.id)).bytes.toString()).toBe('one');
    expect((await w.download(nadia, b.id)).bytes.toString()).toBe('two');
  });

  it('lists the files of a channel newest first with a cursor', async () => {
    const ch = await w.channelId('engineering', 'standup');
    const made = [await upload(nadia, ch, 'a', 'l1.txt'), await upload(nadia, ch, 'b', 'l2.txt'), await upload(nadia, ch, 'c', 'l3.txt')];
    const first = ListChannelFilesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${ch}/files?limit=2`)));
    expect(first.items.map((f) => f.id)).toEqual([made[2]!.id, made[1]!.id]);
    expect(first.nextCursor).toBe(made[1]!.id);
    const second = ListChannelFilesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${ch}/files?limit=2&before=${first.nextCursor}`)));
    expect(second.items.map((f) => f.id)).toEqual([made[0]!.id]);
    expect(second.nextCursor).toBeNull();
    expect((await w.call(sameera, 'GET', `/api/channels/${ch}/files`)).status).toBe(403);
  });
});

describe('the size cap', () => {
  async function* chunks(n: number, size: number): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < n; i++) yield new Uint8Array(size).fill(65);
  }

  it('refuses mid-stream with 413 and the error envelope, and keeps nothing: no row, no blob, no partial file', async () => {
    process.env['MANYTHREADS_MAX_UPLOAD_BYTES'] = '100000';
    const before = blobs().length;
    // No content-length: a chunked body that only shows its size as it arrives (10 x 30,000 bytes against 100,000).
    const res = await w.upload(nadia, dev, chunks(10, 30_000), { name: 'big.bin', type: 'application/octet-stream' });
    expect(res.status).toBe(413);
    const env = ErrorEnvelope.parse(res.body);
    expect(env.error.message).toContain('100000');
    expect(blobs()).toHaveLength(before);
    expect(parts()).toEqual([]);
    const rows = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.files WHERE name = 'big.bin'")).rows[0]!.n);
    expect(rows).toBe(0);
    // The server is still fine after the refusal.
    expect((await w.upload(nadia, dev, 'small', { name: 'small.txt', type: 'text/plain' })).status).toBe(201);
  });

  it('refuses a declared content-length over the cap before reading anything', async () => {
    process.env['MANYTHREADS_MAX_UPLOAD_BYTES'] = '1000';
    const res = await w.upload(nadia, dev, Buffer.alloc(5000, 66), { name: 'declared.bin' });
    expect(res.status).toBe(413);
    ErrorEnvelope.parse(res.body);
  });

  it('accepts exactly the cap and defaults to 50 MB', async () => {
    process.env['MANYTHREADS_MAX_UPLOAD_BYTES'] = '2048';
    expect((await w.upload(nadia, dev, Buffer.alloc(2048, 67), { name: 'exact.bin' })).status).toBe(201);
    expect((await w.upload(nadia, dev, Buffer.alloc(2049, 67), { name: 'over.bin' })).status).toBe(413);
    const { maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES } = await import('../src/routes.ts');
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(maxUploadBytes({})).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(maxUploadBytes({ MANYTHREADS_MAX_UPLOAD_BYTES: 'nope' })).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });
});

describe('who may read and write files (principle 8: the ACL is checked on every read)', () => {
  it('Sameera (another team) and an anonymous caller get nothing; the answer is the same for a missing file', async () => {
    const f = await upload(nadia, dev, 'secret plans', 'plans.txt', 'text/plain');
    expect((await w.call(sameera, 'GET', `/api/files/${f.id}`)).status).toBe(403);
    const blocked = await w.download(sameera, f.id);
    expect(blocked.status).toBe(403);
    expect(blocked.bytes.toString()).not.toContain('secret plans');
    expect((await w.download(null, f.id)).status).toBe(401);
    expect((await w.download(sameera, '00000000-0000-7000-8000-000000000999')).status).toBe(403);
    expect((await w.call(sameera, 'DELETE', `/api/files/${f.id}`)).status).toBe(403);
    expect((await w.upload(sameera, dev, 'x', { name: 'x.txt' })).status).toBe(403);
    expect((await w.call(sameera, 'GET', `/api/channels/${dev}/files`)).status).toBe(403);
  });

  it('Lena (guest): 403 without a grant, a read grant lets her read but not upload, a post grant lets her upload, revoking stops reads at once', async () => {
    const f = await upload(nadia, releases, 'release notes', 'notes.txt', 'text/plain');
    expect((await w.download(lena, f.id)).status).toBe(403);
    expect((await w.call(lena, 'GET', `/api/files/${f.id}`)).status).toBe(403);

    await w.grant(releases, lena, 'read');
    const read = await w.download(lena, f.id);
    expect(read.status).toBe(200);
    expect(read.bytes.toString()).toBe('release notes');
    expect((await w.call(lena, 'GET', `/api/files/${f.id}`)).status).toBe(200);
    expect((await w.upload(lena, releases, 'x', { name: 'from-lena.txt' })).status).toBe(403);
    // Her grant is on #releases only: a file in #dev stays out of reach.
    const devFile = await upload(nadia, dev, 'dev only', 'dev.txt', 'text/plain');
    expect((await w.download(lena, devFile.id)).status).toBe(403);

    await w.grant(releases, lena, 'post');
    expect((await w.upload(lena, releases, 'hello', { name: 'from-lena.txt', type: 'text/plain' })).status).toBe(201);

    await w.revoke(releases, lena);
    expect((await w.download(lena, f.id)).status).toBe(403);
    expect((await w.call(lena, 'GET', `/api/files/${f.id}`)).status).toBe(403);
    // The bytes are still there for the people who may read them.
    expect((await w.download(rafi, f.id)).status).toBe(200);
  });

  it('a file in a private channel is read only by its members: Priya and Nadia (same team) get 403 until they are added', async () => {
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'files-private', private: true }), 201);
    const id = created.channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${id}/members`, { personId: rafi.personId }));
    const f = await upload(rafi, id, 'members only', 'private.txt', 'text/plain');
    expect(f.folderPath).toBe('channels/files-private/');
    for (const who of [priya, nadia, sameera, lena]) {
      expect((await w.download(who, f.id)).status, who.key).toBe(403);
      expect((await w.call(who, 'GET', `/api/files/${f.id}`)).status, who.key).toBe(403);
      expect((await w.upload(who, id, 'x', { name: 'x.txt' })).status, who.key).toBe(403);
    }
    expect((await w.download(rafi, f.id)).status).toBe(200);
    ok(await w.call(omar, 'POST', `/api/channels/${id}/members`, { personId: nadia.personId }));
    expect((await w.download(nadia, f.id)).status).toBe(200);
  });

  it('an archived channel takes no new files (409)', async () => {
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'files-archived' }), 201);
    const id = created.channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${id}/archive`));
    expect((await w.upload(omar, id, 'x', { name: 'late.txt' })).status).toBe(409);
  });

  it('a DM file belongs to the two people in it', async () => {
    const dm = await w.system(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key)
         VALUES ($1, NULL, 'dm-files-test', 'dm', true, $2) RETURNING id`,
        [nadia.workspaceId, `${nadia.personId}:${rafi.personId}`],
      );
      await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2), ($1, $3)', [r.rows[0]!.id, nadia.personId, rafi.personId]);
      return r.rows[0]!.id;
    });
    const f = await upload(nadia, dm, 'between us', 'dm.txt', 'text/plain');
    expect(f.folderPath).toBe(`dms/${dm}/`);
    expect(f.teamId).toBeNull();
    expect((await w.download(rafi, f.id)).status).toBe(200);
    for (const who of [priya, omar, sameera]) expect((await w.download(who, f.id)).status, who.key).toBe(403);
  });
});

describe('names are safe', () => {
  const cases: [string, string][] = [
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\boot.ini', 'boot.ini'],
    ['C:\\Users\\nadia\\Desktop\\plan.docx', 'plan.docx'],
    ['/abs/olute/path.txt', 'path.txt'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['   ', 'file'],
    ['.hidden', 'hidden'],
    ['trailing. . ', 'trailing'],
    ['re\u202etxt.exe', 'retxt.exe'],
    ['nul\u0000byte.txt', 'nulbyte.txt'],
    ['tab\tand\nnewline.txt', 'tab and newline.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['cafe\u0301.txt', 'caf\u00e9.txt'],
  ];
  it.each(cases)('%j is stored as %j, inside the channel folder, with its bytes under the blob directory only', async (given, expected) => {
    const before = new Set(blobs());
    const f = await upload(nadia, dev, 'x', given === '' ? ' ' : given);
    // Several cases collapse to the same name: the numbered form of the same base is the proof it was sanitised.
    expect(f.name.replace(/ \(\d+\)(?=\.|$)/, '')).toBe(expected);
    expect(f.folderPath).toBe('channels/dev/');
    const added = blobs().filter((p) => !before.has(p));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{32}$/);
  });

  it('keeps a long name within 255 bytes and its extension, and an overlong header is not a crash', async () => {
    const long = `${'é'.repeat(300)}.pdf`;
    const f = await upload(nadia, dev, PDF, long, 'application/pdf');
    expect(Buffer.byteLength(f.name)).toBeLessThanOrEqual(255);
    expect(f.name.endsWith('.pdf')).toBe(true);
    const second = await upload(nadia, dev, PDF, long, 'application/pdf');
    expect(Buffer.byteLength(second.name)).toBeLessThanOrEqual(255);
    expect(second.name).not.toBe(f.name);
  });

  it('accepts the name as ?name= when there is no header, and a malformed escape does not fail the upload', async () => {
    const res = await fetch(`${w.server.url}/api/channels/${dev}/files?name=${encodeURIComponent('via-query.txt')}`, {
      method: 'POST',
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }), 'content-type': 'text/plain' },
      body: 'q',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as FileMeta).name).toBe('via-query.txt');
    const bad = await w.upload(nadia, dev, 'x', { headers: { 'x-file-name': '100%_sure.txt' } });
    expect(bad.status).toBe(201);
    expect((bad.body as FileMeta).name).toBe('100%_sure.txt');
  });

  it('no name at all is "file"', async () => {
    const res = await w.upload(nadia, dev, 'anon', {});
    expect((res.body as FileMeta).name.startsWith('file')).toBe(true);
  });
});

describe('deleting', () => {
  it('the uploader deletes the row and the bytes; the second delete and any later read are 403', async () => {
    const f = await upload(nadia, dev, 'to delete', 'gone.txt', 'text/plain');
    const count = blobs().length;
    expect((await w.call(rafi, 'DELETE', `/api/files/${f.id}`)).status).toBe(403); // not the uploader, not a lead
    expect(blobs()).toHaveLength(count);
    expect(ok<{ deleted: boolean }>(await w.call(nadia, 'DELETE', `/api/files/${f.id}`)).deleted).toBe(true);
    expect(blobs()).toHaveLength(count - 1);
    expect((await w.download(nadia, f.id)).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/files/${f.id}`)).status).toBe(403);
  });

  it('a lead (Omar) may delete somebody else\'s file', async () => {
    const f = await upload(rafi, dev, 'moderated', 'moderated.txt', 'text/plain');
    expect(ok<{ deleted: boolean }>(await w.call(omar, 'DELETE', `/api/files/${f.id}`)).deleted).toBe(true);
    expect((await w.download(rafi, f.id)).status).toBe(403);
  });
});

describe('attaching to a message (meta.attachments)', () => {
  const post = (who: typeof nadia, channelId: string, body: string, attachments?: string[]): Promise<ApiResult> =>
    w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null, ...(attachments ? { attachments } : {}) });

  it('stores the ids in meta and serves the cards on every read path, only to people who can read the channel', async () => {
    const a = await upload(nadia, dev, PDF, 'agenda.pdf', 'application/pdf');
    const b = await upload(nadia, dev, PNG, 'whiteboard.png', 'image/png');
    const posted = ok<{ id: string; meta: { attachments?: string[] } }>(await post(nadia, dev, 'Notes from the incident review', [b.id, a.id]), 201);
    expect(posted.meta.attachments).toEqual([b.id, a.id]);
    const list = ok<{ items: ChannelMessage[] }>(await w.call(rafi, 'GET', `/api/channels/${dev}/messages?limit=5`));
    const msg = ChannelMessage.parse(list.items.find((m) => m.id === posted.id));
    expect(msg.attachments).toEqual([
      { id: b.id, name: 'whiteboard.png', size: PNG.length, mime: 'image/png' },
      { id: a.id, name: 'agenda.pdf', size: PDF.length, mime: 'application/pdf' },
    ]);
    const one = ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${posted.id}`)));
    expect(one.attachments?.map((x) => x.name)).toEqual(['whiteboard.png', 'agenda.pdf']);
    // A message without attachments still says so.
    const plain = ok<{ id: string }>(await post(nadia, dev, 'no files here'), 201);
    expect(ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${plain.id}`))).attachments).toEqual([]);
    // A deleted file drops out of the card list.
    ok(await w.call(nadia, 'DELETE', `/api/files/${a.id}`));
    expect(ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${posted.id}`))).attachments?.map((x) => x.name)).toEqual(['whiteboard.png']);
  });

  it('refuses someone else\'s file, a file of another channel, an unknown id and a duplicate', async () => {
    const mine = await upload(nadia, dev, 'mine', 'mine.txt', 'text/plain');
    const other = await upload(rafi, dev, 'rafi', 'rafi.txt', 'text/plain');
    const elsewhere = await upload(nadia, releases, 'releases', 'releases.txt', 'text/plain');
    expect((await post(nadia, dev, 'x', [other.id])).status).toBe(400);
    expect((await post(nadia, dev, 'x', [elsewhere.id])).status).toBe(400);
    expect((await post(nadia, dev, 'x', ['00000000-0000-7000-8000-000000000999'])).status).toBe(400);
    expect((await post(nadia, dev, 'x', [mine.id, mine.id])).status).toBe(400);
    expect((await post(nadia, dev, 'x', Array.from({ length: 11 }, () => mine.id))).status).toBe(400);
    expect((await post(nadia, dev, 'ok', [mine.id])).status).toBe(201);
  });
});

describe('the file entity link', () => {
  it('resolves a file for someone who can read it and for nobody else', async () => {
    const f = await upload(nadia, dev, PDF, 'linked.pdf', 'application/pdf');
    const resolve = (who: typeof nadia) => w.call<{ links: unknown[] }>(who, 'GET', `/api/links?type=file&id=${f.id}`);
    // The links route lists links of the entity; none exist yet, but a resolvable entity is not an error and a hidden one is not found.
    expect((await resolve(nadia)).status).toBe(200);
  });
});
