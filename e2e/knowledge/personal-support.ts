import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Personal memory, inbox and knowledge specs (P20-T2): the Memory screen at `/memory` (Personal first), direct calls to `/api/me/memory/*`,
 * `/api/me/inbox/*` and `/api/me/knowledge/*`. Every spec starts a stack of its own, so nothing here has to put the database back.
 */

export { apiOn };
export type { StackApi };

/** A fact a person can write to their own memory: the front matter the open memory format asks for, then a body. */
export const fact = (title: string, body: string): string => `---\ntype: Fact\ntitle: ${title}\n---\n${body}\n`;

export interface PersonalFileJson {
  file: { path: string; content: string; versionNo: number; sizeBytes: number };
  concept: { path: string; title: string; space: string; type: string };
}

export interface PersonalInboxItemJson {
  id: string;
  name: string;
  state: string;
  holdReason: string | null;
  reason: string | null;
  filedPaths: string[];
  originalKept: boolean;
  space: string;
}

/** Writes one file of the caller's own memory (what the Save button sends); `baseVersion` is what the editor opened. */
export async function putMemory(api: StackApi, path: string, content: string, baseVersion?: number): Promise<PersonalFileJson> {
  const res = await api.ctx.put('/api/me/memory/file', { data: { path, content, ...(baseVersion === undefined ? {} : { baseVersion }) }, headers: await api.headers() });
  expect(res.status(), `PUT ${path}: ${await res.text()}`).toBe(200);
  return (await res.json()) as PersonalFileJson;
}

/** The paths the caller's own memory lists. */
export async function memoryPaths(api: StackApi): Promise<string[]> {
  return (await api.get<{ items: Array<{ path: string }> }>('/api/me/memory/concepts')).items.map((c) => c.path);
}

/** The items of the caller's own inbox, newest first, optionally of one state. */
export async function inboxOf(api: StackApi, state?: string): Promise<PersonalInboxItemJson[]> {
  return (await api.get<{ items: PersonalInboxItemJson[] }>(`/api/me/inbox/items${state ? `?state=${state}` : ''}`)).items;
}

/** Drops a file in the caller's own inbox (what the drop zone sends). */
export async function dropFile(api: StackApi, name: string, body: string | Buffer, type = 'text/markdown'): Promise<PersonalInboxItemJson> {
  const res = await api.ctx.post(`/api/me/inbox/items?name=${encodeURIComponent(name)}`, {
    headers: { ...(await api.headers()), 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    data: typeof body === 'string' ? Buffer.from(body) : body,
  });
  expect([200, 201], `drop ${name}: ${await res.text()}`).toContain(res.status());
  return ((await res.json()) as { item: PersonalInboxItemJson }).item;
}

/** Waits for an inbox item to reach one of the states (the pipeline runs in a job, so it takes a moment). */
export async function settled(api: StackApi, itemId: string, states: readonly string[], timeoutMs = 60_000): Promise<PersonalInboxItemJson> {
  let last: PersonalInboxItemJson | undefined;
  await expect
    .poll(
      async () => {
        last = (await api.get<{ item: PersonalInboxItemJson }>(`/api/me/inbox/items/${itemId}`)).item;
        return last.state;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toMatch(new RegExp(`^(${states.join('|')})$`));
  return last as PersonalInboxItemJson;
}

/** The Memory screen as the persona: Personal at `/memory`, or a team's at `/t/<team>/memory`. */
export async function openMemory(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  path = '/memory',
  opts: { viewport?: { width: number; height: number }; mobile?: boolean } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, path, opts);
  return { page, close: () => context.close() };
}

/** Every route that reads or writes a person's own Personal space, as `[method, path]`. A guest has none of them. */
export const PERSONAL_ROUTES: ReadonlyArray<readonly ['GET' | 'POST', string]> = [
  ['GET', '/api/me/memory/concepts'],
  ['GET', '/api/me/memory/file?path=memory/facts/x.md'],
  ['GET', '/api/me/memory/versions?path=memory/facts/x.md'],
  ['GET', '/api/me/inbox/items'],
  ['GET', '/api/me/knowledge'],
  ['GET', '/api/me/knowledge/notes/search?q=anything'],
  ['GET', '/api/me/files/tree?path='],
  ['GET', '/api/me/bot-consents'],
];
