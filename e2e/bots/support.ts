import { expect, type Browser, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, applyGuarded, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Bots specs (PLAN P5-05). Each spec starts a stack seeded with `repo`, so the real seed commits have already put
 * `bots/coder/BOT.md` in the team repo and the loader (the outbox consumer) has made the roster row. The definition is a file of the
 * team repo, so a proposal applied at once is how the editor changes it, and the loader reads it from the commit.
 */

export const BOTS_STACK_ENV = { MANYTHREADS_STACK_SEED: 'repo' } as const;
export const BOT_MD = 'bots/coder/BOT.md';

/** The definition as the repo holds it now: the text and the blob a save must base itself on. */
export async function definitionOf(api: StackApi, path = BOT_MD): Promise<{ content: string; blobSha: string }> {
  return api.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
}

/** A change of the definition as the caller (a lead proposes and applies it at once; P7-01); 201 or the test fails with the answer. */
export async function commitDefinition(api: StackApi, content: string, message: string, baseBlobSha: string | undefined): Promise<void> {
  const res = await applyGuarded(api, BOT_MD, content, message, baseBlobSha === undefined ? {} : { baseBlobSha });
  expect(res.status, `apply ${message}: ${res.text}`).toBe(201);
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
