import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Files specs (PLAN P4-11). Each spec starts a stack of its own seeded with `repo` (seed v3 channels and seed v4 team repos and attachments),
 * because every one of them writes to the team repo or reads it as someone who would see another spec's writes.
 */

export const STACK_ENV = { MANYTHREADS_STACK_SEED: 'repo' } as const;

export const actorOf = (key: PersonaKey): string => personas[key].actorId;

export interface CommitRow {
  message: string;
  authorId: string | null;
  paths: string[];
}

/** The commits of a team's repo, newest first, straight from the history index. */
export async function commitsOf(stack: Stack, team = 'engineering'): Promise<CommitRow[]> {
  const rows = await stack.sql<{ message: string; author_id: string | null; paths: string[] }>(
    `SELECT c.message, c.author_id, c.paths FROM app.repo_commits c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = $1 ORDER BY c.committed_at DESC, c.seq DESC`,
    [team],
  );
  return rows.map((r) => ({ message: r.message, authorId: r.author_id, paths: r.paths }));
}

export async function blobOf(api: StackApi, path: string, team = 'engineering'): Promise<string> {
  const res = await api.get<{ content: string }>(`/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  return res.content;
}

/** The Files screen of the team, as the persona, on the stack. */
export async function openFiles(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  query = '',
  opts: { viewport?: { width: number; height: number }; mobile?: boolean; team?: string } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, `/t/${opts.team ?? 'engineering'}/files${query}`, opts);
  await expect(page.getByTestId('files-screen').or(page.getByTestId('files-denied'))).toBeVisible();
  return { page, close: () => context.close() };
}

export { apiOn };

export const tree = (page: Page, path: string) => page.locator(`[data-testid="tree-node"][data-path="${path}"]`);
export const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
