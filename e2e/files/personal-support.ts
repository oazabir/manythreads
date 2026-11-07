import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Personal-space specs (P20-T1): the Files screen at `/files` (Personal first, Teams after it), direct calls to `/api/me/files/*`, and the
 * selectors of the tree and the list. Every spec starts a stack of its own, so nothing here has to put the database back.
 */

export { apiOn };
export type { StackApi };

/** The key of the Personal space in a tree row's `data-space` (clients/web/src/screens/files/spaces.ts). */
export const ME = '~me';

export interface PersonalFileJson {
  id: string;
  name: string;
  folderPath: string;
  path: string;
  size: number;
  mime: string;
  versionCount: number;
  contentUrl: string;
  ownerPersonId: string;
}

export interface TreeEntryJson {
  kind: 'file' | 'folder';
  path: string;
  name: string;
  fileId: string | null;
  size: number | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  managedBy: string | null;
}

/** The Files screen as the persona, on the stack: Personal at `/files`, or the screen of a team at `/t/<team>/files`. */
export async function openPersonal(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  query = '',
  opts: { viewport?: { width: number; height: number }; mobile?: boolean; path?: string } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, `${opts.path ?? '/files'}${query}`, opts);
  await expect(page.getByTestId('files-screen').or(page.getByTestId('files-no-personal')).or(page.getByTestId('files-denied')).or(page.getByTestId('admin-view-closed'))).toBeVisible();
  return { page, close: () => context.close() };
}

/** Uploads a file into a folder of the caller's own Personal space (what the Upload button sends). */
export async function uploadAs(
  api: StackApi,
  folder: string,
  name: string,
  body: string | Buffer,
  opts: { type?: string; conflict?: 'rename' | 'version' } = {},
): Promise<PersonalFileJson> {
  const qs = new URLSearchParams({ folderPath: folder, conflict: opts.conflict ?? 'rename' });
  const res = await api.ctx.post(`/api/me/files?${qs}`, {
    headers: { ...(await api.headers()), 'content-type': opts.type ?? 'text/markdown', 'x-file-name': encodeURIComponent(name) },
    data: typeof body === 'string' ? Buffer.from(body) : body,
  });
  expect([200, 201], `upload ${folder}/${name}: ${await res.text()}`).toContain(res.status());
  return (await res.json()) as PersonalFileJson;
}

/** An admin opens another person's Personal space for an hour (what the Members dialog sends). Answers the status and the body. */
export async function openSpaceOf(api: StackApi, personId: string, reason: unknown): Promise<{ status: number; body: { accessId?: string; validUntil?: string; error?: { message?: string } } }> {
  const res = await api.ctx.post(`/api/people/${personId}/personal-space/open`, { data: { reason }, headers: await api.headers() });
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as { accessId?: string; validUntil?: string } };
}

/** One folder of the caller's own tree, as the API lists it. */
export async function treeOf(api: StackApi, path = ''): Promise<TreeEntryJson[]> {
  return (await api.get<{ entries: TreeEntryJson[] }>(`/api/me/files/tree?path=${encodeURIComponent(path)}`)).entries;
}

export async function usageOf(api: StackApi): Promise<{ usedBytes: number; quotaBytes: number; fileCount: number }> {
  return api.get('/api/me/files/usage');
}

/** The status of any request, for refusals. */
export async function statusOf(api: StackApi, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<number> {
  const res = await api.ctx.fetch(path, { method, ...(data !== undefined ? { data } : {}), headers: method === 'GET' ? {} : await api.headers() });
  return res.status();
}

/** A refusal that must look like "not yours": 403, or 404 for a thing that is hidden. */
export const REFUSED = [403, 404] as const;

/** The text of a file's bytes as the caller reads them. */
export async function textOf(api: StackApi, fileId: string): Promise<string> {
  const res = await api.ctx.get(`/api/files/${fileId}/content`);
  expect(res.status()).toBe(200);
  return res.text();
}

// ---- selectors ----------------------------------------------------------------------------------------------------------------------

/** The Personal root and the team roots of the tree. */
export const personalRoot = (page: Page) => page.locator('[data-testid="tree-root"][data-root="personal"]');
export const teamRoots = (page: Page) => page.locator('[data-testid="tree-root"][data-root="team"]');
/** A node of the Personal branch of the tree (a team's branch may hold a folder of the same name). */
export const meNode = (page: Page, path: string) => page.locator(`[data-testid="tree-node"][data-space="${ME}"][data-path="${path}"]`);
/** A row of the list by its path. */
export const rowAt = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
/** The paths of the rows in the order the list shows them. */
export const rowPaths = (page: Page): Promise<string[]> => page.locator('[data-testid="file-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));

/**
 * Chooses a file in the Upload input of the open folder. The screen ignores a file until the folder has been read (`Upload` is enabled then), so the
 * helper waits for that; without it a fast run picks the file before the folder is known and nothing happens.
 */
export async function pickFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await expect(page.getByTestId('upload')).toBeEnabled();
  await page.getByTestId('upload-input').setInputFiles(file);
}

/** Opens a row's menu (the row is hovered first, as the quick buttons and the menu appear then). */
export async function openRowMenu(page: Page, path: string): Promise<void> {
  const row = rowAt(page, path);
  await row.hover();
  await row.getByTestId('row-menu').click();
}

/** The sentence under the Members/Files admin banner has a clock time in it; the visual specs freeze it. */
export const BANNER_TIME = /Your access ends at \d{2}:\d{2}\./;
