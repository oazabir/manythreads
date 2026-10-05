import { expect, type Browser, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Bots specs (PLAN P5-05). Each spec starts a stack seeded with `repo`, so the real seed commits have already put
 * `bots/coder/BOT.md` in the team repo and the loader (the outbox consumer) has made the roster row. The definition is a file of the
 * team repo, so a commit through `repo/commit` is exactly how the loader and the editor both change it.
 */

export const BOTS_STACK_ENV = { MANYTHREADS_STACK_SEED: 'repo' } as const;
export const BOT_MD = 'bots/coder/BOT.md';

/** The definition as the repo holds it now: the text and the blob a save must base itself on. */
export async function definitionOf(api: StackApi, path = BOT_MD): Promise<{ content: string; blobSha: string }> {
  return api.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
}

/** A commit of the definition as the caller (a lead may write `bots/` directly); 201 or the test fails with the answer. */
export async function commitDefinition(api: StackApi, content: string, message: string, baseBlobSha: string | undefined): Promise<void> {
  const res = await api.ctx.post('/api/teams/engineering/repo/commit', {
    data: { changes: [{ op: 'put', path: BOT_MD, content, baseBlobSha }], message },
    headers: await api.headers(),
  });
  expect(res.status(), `commit ${message}: ${await res.text()}`).toBe(201);
}

export const rosterRow = (page: Page, slug: string): Locator => page.locator(`[data-testid="bot-row"][data-bot="${slug}"]`);

export async function openBot(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  slug: string,
  query = '',
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, `/t/engineering/bots/${slug}${query}`);
  await expect(page.getByTestId('bot-page')).toBeVisible();
  return { page, close: () => context.close() };
}

export { apiOn };
