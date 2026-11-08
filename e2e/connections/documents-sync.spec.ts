import { expect, test } from '@playwright/test';
import { apiOn, openOn } from '../support/stack-browser.ts';
import type { Stack } from '../fixtures/stack.ts';
import { SEED_CONNECTORS, connectorsStack, fake, personas, seededOf } from './support.ts';

/*
 * Documents from a connected app into a knowledge base (PLAN P16-07, decisions D13 and D14), on seed v16: Omar's Drive folder "Engineering handbook" is a source of the Engineering base
 * `handbook`, with one document anyone can open (read in) and one shared with Nadia alone (left out under the team rule, and counted). Covered: the Sources list says so; a person outside the
 * two cannot find the left-out text by search; the owner of the file making it public at the app brings it in on the next read; a Personal base takes everything its owner can open and no one
 * else sees it; and the Add from a connected app dialog adds a folder end to end.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const H = SEED_CONNECTORS.handbook;
const TEAM = H.team;
let stack: Stack;

interface BaseDetail {
  documents: Array<{ name: string; status?: string }>;
  sources: Array<{ kind: string; status?: string; skippedLimited?: number; documentCount?: number }>;
}

test.beforeAll(async () => {
  stack = await connectorsStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the Sources list says what was read, how many documents, and that one was left out because not everyone on the team can open it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${TEAM}/knowledge?base=${H.base}`);
  try {
    const source = page.getByTestId('connector-source');
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('data-status', 'ready');
    await expect(source).toContainText(`Google Drive: ${H.folderName}`);
    await expect(page.getByTestId('connector-source-state')).toContainText('1 document');
    await expect(page.getByTestId('connector-source-skipped')).toContainText('1 document not added');
    await expect(page.getByTestId('knowledge-doc').filter({ hasText: H.shared.name })).toHaveCount(1);
    await expect(page.getByTestId('knowledge-doc').filter({ hasText: H.limited.name })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a teammate finds the shared document by search, and no search of the team finds the text of the one that was left out', async ({ playwright }) => {
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    const found = JSON.stringify(await priya.get(`/api/teams/${TEAM}/knowledge/${H.base}/search?q=${encodeURIComponent('pager hand-over')}`));
    expect(found).toContain(H.shared.name);
    const left = JSON.stringify(await priya.get(`/api/teams/${TEAM}/knowledge/${H.base}/search?q=${encodeURIComponent('open questions on the icon set')}`));
    expect(left).not.toContain(H.limited.name);
    expect(left).not.toContain('open questions');
  } finally {
    await priya.ctx.dispose();
  }
  // the database agrees: only the shared document has passages
  const docs = await stack.sql<{ name: string }>(`SELECT name FROM app.knowledge_documents WHERE base_id = $1`, [seededOf(stack).handbookBaseId]);
  expect(docs.map((d) => d.name)).toEqual([H.shared.name]);
});

test('the owner of the file makes it public at the app, and the next read brings it in with nothing left out', async ({ playwright }) => {
  await fake(stack, 'PUT', `/__fake/drive/${H.limited.id}/permissions`, { account: personas.omar.email, permissions: [{ type: 'anyone' }] });
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post(`/api/teams/${TEAM}/knowledge/${H.base}/resync`, {});
    await expect
      .poll(
        async () => {
          const detail = await omar.get<BaseDetail>(`/api/teams/${TEAM}/knowledge/${H.base}`);
          const source = detail.sources.find((s) => s.kind === 'connector');
          return `${String(detail.documents.length)}:${String(source?.skippedLimited ?? 0)}:${source?.status ?? ''}`;
        },
        { timeout: 90_000, intervals: [1_000, 3_000], message: 'the second document to come in' },
      )
      .toBe('2:0:ready');
  } finally {
    await omar.ctx.dispose();
  }
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    expect(JSON.stringify(await priya.get(`/api/teams/${TEAM}/knowledge/${H.base}/search?q=${encodeURIComponent('open questions on the icon set')}`))).toContain(H.limited.name);
  } finally {
    await priya.ctx.dispose();
  }
});

test('a Personal base takes every document its owner can open, a teammate sees neither the base nor the text', async ({ playwright }) => {
  const nadiaEmail = personas.nadia.email;
  // Nadia's own folder with a document shared with Omar alone: two people can open it, which a team base would leave out
  await fake(stack, 'PATCH', `/__fake/accounts/${encodeURIComponent(nadiaEmail)}`, {
    files: [
      { id: 'folder-nadia-notes', name: 'Nadia notes', mimeType: 'application/vnd.google-apps.folder', modified: new Date().toISOString(), text: '' },
      {
        id: 'doc-nadia-kestrel',
        name: 'Kestrel plan',
        mimeType: 'text/plain',
        modified: new Date().toISOString(),
        parentId: 'folder-nadia-notes',
        permissions: [{ type: 'user', email: personas.omar.email }],
        text: 'The kestrel migration moves the icon files in three steps, starting with the dark theme.\n',
      },
    ],
  });
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    await nadia.post('/api/me/knowledge', { slug: 'notes', name: 'Notes' });
    await nadia.post('/api/me/knowledge/notes/connector-sources', { provider: 'google_drive', root: 'folder-nadia-notes', label: 'Nadia notes' });
    await expect
      .poll(async () => (await nadia.get<BaseDetail>('/api/me/knowledge/notes')).documents.map((d) => d.name), { timeout: 90_000, intervals: [1_000, 3_000], message: 'the personal folder to be read' })
      .toEqual(['Kestrel plan']);
    const own = JSON.stringify(await nadia.get('/api/me/knowledge/notes/search?q=kestrel'));
    expect(own).toContain('Kestrel plan');
  } finally {
    await nadia.ctx.dispose();
  }
  const priya = await apiOn(playwright, stack, 'priya');
  try {
    expect((await priya.get<{ bases: unknown[] }>('/api/me/knowledge')).bases).toEqual([]);
    expect([403, 404]).toContain(await priya.status('GET', '/api/me/knowledge/notes'));
    expect(JSON.stringify(await priya.get(`/api/teams/${TEAM}/knowledge/${H.base}/search?q=kestrel`))).not.toContain('Kestrel');
  } finally {
    await priya.ctx.dispose();
  }
});

test('Add from a connected app: a lead picks Google Drive and a folder, ticks the team rule, and the folder is read into the base', async ({ browser, playwright }) => {
  test.setTimeout(180_000); // the folder is read by a job; the last wait below is 90 s
  const omarEmail = personas.omar.email;
  await fake(stack, 'PATCH', `/__fake/accounts/${encodeURIComponent(omarEmail)}`, {
    files: [
      { id: 'folder-ui-added', name: 'Release notes folder', mimeType: 'application/vnd.google-apps.folder', modified: new Date().toISOString(), text: '' },
      { id: 'doc-ui-added', name: 'Release checklist', mimeType: 'text/plain', modified: new Date().toISOString(), parentId: 'folder-ui-added', permissions: [{ type: 'anyone' }], text: 'Tag the build, run the smoke tests, then announce in #dev.\n' },
    ],
  });
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post(`/api/teams/${TEAM}/knowledge`, { slug: 'releases', name: 'Releases' });
  } finally {
    await omar.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/${TEAM}/knowledge?base=releases`);
  try {
    await page.getByTestId('connector-add').click();
    await expect(page.getByTestId('connector-add-dialog')).toBeVisible();
    await page.getByTestId('connector-provider').selectOption('google_drive');
    // by the provider's id of the folder (the option's text carries a parent prefix when the app reports one)
    await page.getByTestId('connector-root').selectOption('folder-ui-added');
    // the team rule must be agreed before the button works
    await expect(page.getByTestId('connector-submit')).toBeDisabled();
    await page.getByTestId('connector-consent').check();
    await page.getByTestId('connector-submit').click();
    await expect(page.getByTestId('connector-add-dialog')).toHaveCount(0);
    await expect(page.getByTestId('connector-source')).toContainText('Release notes folder');
    await expect(page.getByTestId('knowledge-doc').filter({ hasText: 'Release checklist' })).toBeVisible({ timeout: 90_000 });
  } finally {
    await context.close();
  }
});

test('Lena signs in with Microsoft only: the apps the dialog offers her do not include Google Drive', async ({ browser, playwright }) => {
  // Lena signs in with Microsoft only; a Personal base is open to her wherever she works
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    await lena.post('/api/me/knowledge', { slug: 'lena-notes', name: 'Lena notes' });
  } finally {
    await lena.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/knowledge');
  try {
    await expect(page.getByTestId('knowledge-screen')).toBeVisible();
    // the dialog lists only the apps she has connected
    const providers = await page.evaluate(async () => {
      const res = await fetch('/api/me/knowledge-providers');
      return ((await res.json()) as { providers: string[] }).providers;
    });
    expect(providers).not.toContain('google_drive');
    // she did connect Microsoft with the files permission, so the dialog is not empty for her
    expect(providers).toContain('onedrive');
  } finally {
    await context.close();
  }
});
