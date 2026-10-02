import { type APIRequestContext } from '@playwright/test';
import { GetFilesTreeResponse } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes a page and uploads a file: its own server and database for this file (api/support/isolated.ts).
useIsolatedStack();

/**
 * The Files tree over HTTP (PLAN P4-06; criteria 6 and 9): repo entries and `channels/<name>/` attachments in one listing with identical rows; Lena (guest)
 * gets 403 on #dev attachments, Nadia 403 on Marketing's tree, a member sees bots/ and TEAM.md read-only "change by pull request" while a lead does not.
 */

const { omar, nadia, priya, lena, sameera } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const tree = (request: APIRequestContext, p: Persona | null, slug: string, path = '') =>
  request.get(`/api/teams/${slug}/files/tree?path=${encodeURIComponent(path)}`, { headers: p ? as(p) : {} });
const parsed = async (res: Awaited<ReturnType<typeof tree>>): Promise<GetFilesTreeResponse> => {
  expect(res.status(), await res.text()).toBe(200);
  return GetFilesTreeResponse.parse(await res.json());
};
const PDF = Buffer.from('%PDF-1.7\n% quarterly report\n');

test('one tree: a page under pages/ and an upload under channels/dev have identical rows, and the bytes of both are served by URL', async ({ request }) => {
  const made = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name: 'dev' } });
  expect(made.status(), await made.text()).toBe(201);
  const dev = ((await made.json()) as { channel: { id: string } }).channel;
  const up = await request.post(`/api/channels/${dev.id}/files`, { headers: { ...as(nadia), 'content-type': 'application/pdf', 'x-file-name': 'report.pdf' }, data: PDF });
  expect(up.status(), await up.text()).toBe(201);
  const commit = await request.post('/api/teams/engineering/repo/commit', {
    headers: as(nadia),
    data: { changes: [{ op: 'put', path: 'pages/notes.md', content: '# Notes\n' }, { op: 'put', path: 'pages/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }], message: 'Add notes' },
  });
  expect(commit.status(), await commit.text()).toBe(201);

  const root = await parsed(await tree(request, nadia, 'engineering'));
  expect(root.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['bots', 'channels', 'memory', 'pages', 'TEAM.md']));
  expect(new Set(root.entries.map((e) => Object.keys(e).sort().join(','))).size).toBe(1);
  expect(root.entries.find((e) => e.name === 'memory')).toMatchObject({ managedBy: 'team_memory' });
  const memory = await parsed(await tree(request, nadia, 'engineering', 'memory'));
  expect(memory.entries.map((e) => e.name)).toEqual(['facts', 'journal']);

  const pages = await parsed(await tree(request, nadia, 'engineering', 'pages'));
  const notes = pages.entries.find((e) => e.name === 'notes.md')!;
  expect(notes).toMatchObject({ kind: 'file', source: 'repo', mime: 'text/markdown', updatedBy: nadia.actorId, readOnly: false });
  const channels = await parsed(await tree(request, nadia, 'engineering', 'channels'));
  expect(channels.entries.map((e) => e.name)).toContain('dev');
  const files = await parsed(await tree(request, nadia, 'engineering', 'channels/dev'));
  const report = files.entries.find((e) => e.name === 'report.pdf')!;
  expect(report).toMatchObject({ kind: 'file', source: 'attachment', mime: 'application/pdf', size: PDF.length, updatedBy: nadia.actorId, readOnly: true });
  expect(Object.keys(report).sort()).toEqual(Object.keys(notes).sort());

  const pdf = await request.get(report.contentUrl!, { headers: as(nadia) });
  expect(pdf.status()).toBe(200);
  expect(Buffer.from(await pdf.body()).equals(PDF)).toBe(true);
  const svg = pages.entries.find((e) => e.name === 'logo.svg')!;
  const image = await request.get(svg.contentUrl!, { headers: as(nadia) });
  expect(image.headers()['content-type']).toBe('image/svg+xml');
  expect(image.headers()['content-security-policy']).toMatch(/sandbox/);
});

test('Lena gets 403 on #dev attachments, Nadia on Marketing’s tree, Sameera on Engineering’s; anonymous 401', async ({ request }) => {
  expect((await tree(request, lena, 'engineering', 'channels/dev')).status()).toBe(403);
  expect((await tree(request, lena, 'engineering')).status()).toBe(403);
  expect((await tree(request, nadia, 'marketing')).status()).toBe(403);
  expect((await tree(request, nadia, 'marketing', 'channels')).status()).toBe(403);
  expect((await tree(request, sameera, 'engineering')).status()).toBe(403);
  expect((await tree(request, null, 'engineering')).status()).toBe(401);
  // a channel that does not exist looks the same as one she cannot read
  expect((await tree(request, nadia, 'engineering', 'channels/no-such-channel')).status()).toBe(403);
});

test('Priya (member, not a lead) sees bots/ and TEAM.md read-only, change by pull request; her direct write is 403; Omar’s are editable', async ({ request }) => {
  const asPriya = await parsed(await tree(request, priya, 'engineering'));
  for (const name of ['bots', 'skills', 'routines', 'TEAM.md']) {
    expect(asPriya.entries.find((e) => e.name === name), name).toMatchObject({ readOnly: true, readOnlyReason: 'change_by_pull_request' });
  }
  expect(asPriya.entries.find((e) => e.name === 'pages')).toMatchObject({ readOnly: false, readOnlyReason: null });
  const asOmar = await parsed(await tree(request, omar, 'engineering'));
  expect(asOmar.entries.filter((e) => ['bots', 'skills', 'routines', 'TEAM.md'].includes(e.name)).every((e) => !e.readOnly)).toBe(true);
  const write = await request.post('/api/teams/engineering/repo/commit', { headers: as(priya), data: { changes: [{ op: 'put', path: 'TEAM.md', content: 'x' }], message: 'x' } });
  expect(write.status()).toBe(403);
});
