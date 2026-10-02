import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes data (channels, messages, ...): its own server and database for this file (api/support/isolated.ts).
useIsolatedStack();

/**
 * Attachments through the HTTP API (PLAN criterion 7, spec e2e/files/attach.spec.ts, API part): a file is uploaded as a raw byte stream, the
 * channel's ACL decides every read (Lena without a grant and Sameera of another team get 403), an oversized upload is refused with 413
 * and the error envelope, names cannot traverse, and a message carries its attachments as cards.
 */

const { omar, nadia, rafi, sameera, lena } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const slug = (): string => `files-${randomUUID().slice(0, 8)}`;

async function makeChannel(request: APIRequestContext, name = slug(), isPrivate = false): Promise<string> {
  const res = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name, private: isPrivate } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { channel: { id: string } }).channel.id;
}
const upload = (request: APIRequestContext, p: Persona, channelId: string, body: Buffer, name: string, type: string) =>
  request.post(`/api/channels/${channelId}/files`, {
    headers: { ...as(p), 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    data: body,
  });
const PDF = Buffer.from('%PDF-1.7\n% quarterly report\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tiny image bytes')]);

test.describe('upload and download', () => {
  test('a PDF and a PNG upload, download as the same bytes, and the PNG shows inline', async ({ request }) => {
    const channelId = await makeChannel(request);
    const pdf = await upload(request, nadia, channelId, PDF, 'report.pdf', 'application/pdf');
    expect(pdf.status(), await pdf.text()).toBe(201);
    const pdfMeta = (await pdf.json()) as { id: string; name: string; size: number; mime: string; folderPath: string };
    expect(pdfMeta).toMatchObject({ name: 'report.pdf', size: PDF.length, mime: 'application/pdf' });
    expect(pdfMeta.folderPath).toMatch(/^channels\/files-[0-9a-f]{8}\/$/);

    const png = await upload(request, nadia, channelId, PNG, 'diagram.png', 'image/png');
    expect(png.status()).toBe(201);
    const pngMeta = (await png.json()) as { id: string };

    const got = await request.get(`/api/files/${pdfMeta.id}/content`, { headers: as(rafi) });
    expect(got.status()).toBe(200);
    expect(Buffer.from(await got.body()).equals(PDF)).toBe(true);
    expect(got.headers()['x-content-type-options']).toBe('nosniff');
    expect(got.headers()['content-disposition']).toMatch(/^attachment;/);

    const image = await request.get(`/api/files/${pngMeta.id}/content`, { headers: as(rafi) });
    expect(image.headers()['content-disposition']).toMatch(/^inline;/);
    expect(image.headers()['content-type']).toBe('image/png');

    const listed = (await (await request.get(`/api/channels/${channelId}/files`, { headers: as(rafi) })).json()) as { items: { name: string }[] };
    expect(listed.items.map((f) => f.name)).toEqual(['diagram.png', 'report.pdf']);
  });

  test('an upload over the 50 MB cap is refused with 413 and the error envelope; nothing is kept', async ({ request }) => {
    test.setTimeout(120_000);
    const channelId = await makeChannel(request);
    const big = Buffer.alloc(51 * 1024 * 1024, 0x41);
    const res = await upload(request, nadia, channelId, big, 'big.zip', 'application/zip');
    expect(res.status()).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toMatch(/limit/);
    const listed = (await (await request.get(`/api/channels/${channelId}/files`, { headers: as(nadia) })).json()) as { items: unknown[] };
    expect(listed.items).toEqual([]);
    // Exactly the cap is fine and the server still answers afterwards.
    const ok = await upload(request, nadia, channelId, Buffer.alloc(1024 * 1024, 0x42), 'one-mb.bin', 'application/octet-stream');
    expect(ok.status()).toBe(201);
  });

  test('file names cannot traverse or smuggle control characters', async ({ request }) => {
    const channelId = await makeChannel(request);
    for (const [given, expected] of [
      ['../../../etc/passwd', 'passwd'],
      ['..\\..\\windows\\win.ini', 'win.ini'],
      ['evil‮gpj.exe', 'evilgpj.exe'],
      ['..', 'file'],
    ] as const) {
      const res = await upload(request, nadia, channelId, Buffer.from('x'), given, 'text/plain');
      expect(res.status(), given).toBe(201);
      expect(((await res.json()) as { name: string }).name.replace(/ \(\d+\)$/, '')).toBe(expected);
    }
  });
});

test.describe('who may read a file (ACL checked on every read)', () => {
  test('Sameera (another team), an anonymous caller and Lena (a guest with no grant) are refused', async ({ request }) => {
    // Granting Lena access is covered by the vitest suite (packages/plugins/files/test): this server is shared by every api spec, so
    // no spec here changes what a persona can see.
    const channelId = await makeChannel(request);
    const res = await upload(request, nadia, channelId, PDF, 'plan.pdf', 'application/pdf');
    const { id } = (await res.json()) as { id: string };

    expect((await request.get(`/api/files/${id}/content`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/files/${id}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/files/${id}/content`)).status()).toBe(401);
    expect((await request.get(`/api/files/${id}/content`, { headers: as(lena) })).status()).toBe(403);
    expect((await request.get(`/api/files/${id}`, { headers: as(lena) })).status()).toBe(403);
    expect((await upload(request, sameera, channelId, PDF, 'x.pdf', 'application/pdf')).status()).toBe(403);
    expect((await upload(request, lena, channelId, PDF, 'x.pdf', 'application/pdf')).status()).toBe(403);
    expect((await request.get(`/api/channels/${channelId}/files`, { headers: as(lena) })).status()).toBe(403);
  });

  test('a file in a private channel is invisible to a team member who is not in it', async ({ request }) => {
    const channelId = await makeChannel(request, slug(), true);
    expect((await request.post(`/api/channels/${channelId}/members`, { headers: as(omar), data: { personId: rafi.personId } })).status()).toBe(200);
    const { id } = (await (await upload(request, rafi, channelId, PDF, 'hr.pdf', 'application/pdf')).json()) as { id: string };
    expect((await request.get(`/api/files/${id}/content`, { headers: as(rafi) })).status()).toBe(200);
    expect((await request.get(`/api/files/${id}/content`, { headers: as(nadia) })).status()).toBe(403);
    expect((await request.get(`/api/files/${id}`, { headers: as(nadia) })).status()).toBe(403);
  });
});

test.describe('attaching to a message', () => {
  test('the message carries the attachment ids and the cards; only the uploader attaches, only to the same channel', async ({ request }) => {
    const channelId = await makeChannel(request);
    const other = await makeChannel(request);
    const file = (await (await upload(request, nadia, channelId, PDF, 'notes.pdf', 'application/pdf')).json()) as { id: string };
    const foreign = (await (await upload(request, nadia, other, PDF, 'other.pdf', 'application/pdf')).json()) as { id: string };
    const rafis = (await (await upload(request, rafi, channelId, PDF, 'rafi.pdf', 'application/pdf')).json()) as { id: string };
    const post = (p: Persona, attachments: string[]) =>
      request.post(`/api/channels/${channelId}/messages`, { headers: as(p), data: { channelId, body: 'Notes from the incident review', threadRootId: null, attachments } });
    expect((await post(nadia, [foreign.id])).status()).toBe(400);
    expect((await post(nadia, [rafis.id])).status()).toBe(400);
    const posted = await post(nadia, [file.id]);
    expect(posted.status(), await posted.text()).toBe(201);
    const list = (await (await request.get(`/api/channels/${channelId}/messages`, { headers: as(rafi) })).json()) as {
      items: { attachments: { id: string; name: string; size: number; mime: string }[] }[];
    };
    expect(list.items[0]?.attachments).toEqual([{ id: file.id, name: 'notes.pdf', size: PDF.length, mime: 'application/pdf' }]);
  });

  test('the uploader deletes a file; the next read is 403 and the card disappears', async ({ request }) => {
    const channelId = await makeChannel(request);
    const { id } = (await (await upload(request, nadia, channelId, PDF, 'temp.pdf', 'application/pdf')).json()) as { id: string };
    expect((await request.delete(`/api/files/${id}`, { headers: as(rafi) })).status()).toBe(403);
    expect((await request.delete(`/api/files/${id}`, { headers: as(nadia) })).status()).toBe(200);
    expect((await request.get(`/api/files/${id}/content`, { headers: as(nadia) })).status()).toBe(403);
  });
});
