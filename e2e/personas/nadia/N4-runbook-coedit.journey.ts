// N4 · Nadia edits the runbook page live while Brain writes a section into it, reads the history and restores the version before both (PLAN block B, marker B). Live pages are built (P6-09: the Yjs
// document on the server; the markdown text area with cursors is the editor, the owner dropped the Tiptap editor on 2026-11-05), so this journey is real. The Hermes behind Brain is the stand-in of
// support/hermes-persona.mjs: it asks the platform for `pages.write` (append) and the platform applies a bot's page write to the document Nadia has open.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBrain } from './support/brain.ts';

const PAGE = 'pages/runbook.md';
const OPEN = `/t/engineering/files?open=${encodeURIComponent(PAGE)}`;
const ASK = 'Add a section to the deploy runbook about what to do after a deploy.';
const NADIA_LINE = 'Nadia: the on-call engineer owns the check after the deploy.';
const SECTION = 'After the deploy';
const PROMPTS = ['What did we decide about the cache TTL?', 'What is blocking the release?'];

export default defineJourney({
  id: 'N4',
  persona: 'nadia',
  goal: 'Edit the runbook live while Brain writes a section into it, read the history, and restore the version from before.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'page-open',
      expect: TID.fileView,
      next: { testid: 'go-live', label: 'Live' },
      run: async ({ page, stack }) => {
        allowKnownNoise(page);
        await arrangeBrain(stack, PROMPTS, ['pages.write']);
        await page.goto(OPEN);
        await expect(page.getByTestId('viewer-markdown').locator('.md-prose h1')).toContainText('Production deploy runbook');
      },
    },
    {
      id: 'live-editing',
      expect: 'live-page',
      next: { testid: 'leave-live', label: 'Done' },
      run: async ({ page }) => {
        await page.getByTestId('go-live').click();
        await expect(page.getByTestId('live-status')).toHaveText('Live');
        await page.getByLabel('Page source, edited live').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(`\n${NADIA_LINE}\n`);
        await expect(page.getByLabel('Page source, edited live')).toHaveValue(new RegExp(NADIA_LINE));
      },
    },
    {
      id: 'brain-writes-section',
      expect: 'live-page',
      next: { testid: 'leave-live', label: 'Done' },
      run: async (ctx) => {
        // she asks Brain in a second window, so the live editor stays open in the first one
        const second = await ctx.also('nadia');
        await second.pages.brain.open('brain');
        await second.pages.brain.ask(ASK, { timeoutMs: 90_000 });
        const source = ctx.page.getByLabel('Page source, edited live');
        await expect(source).toHaveValue(new RegExp(SECTION), { timeout: 30_000 });
        // her own line is still there: the bot's section did not replace the document
        await expect(source).toHaveValue(new RegExp(NADIA_LINE));
        await expect(source).toHaveValue(/Production deploy runbook/);
      },
    },
    {
      id: 'saved-to-history',
      expect: 'viewer-markdown',
      run: async ({ page }) => {
        await page.getByTestId('leave-live').click();
        const prose = page.getByTestId('viewer-markdown').locator('.md-prose');
        await expect(prose).toContainText(SECTION);
        await expect(prose).toContainText(NADIA_LINE);
      },
    },
    {
      id: 'history',
      expect: 'history',
      next: { testid: 'restore-version', label: 'Restore this version' },
      run: async ({ page }) => {
        await page.getByTestId('open-history').click();
        const rows = page.getByTestId('commit-row');
        // the two commits of the seed and one for the live session, made by Nadia with Brain as co-author: Brain's section went into the document she had open, so there is no
        // second commit for the bot
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText('live with 2 editors');
        await expect(rows.first()).toContainText('with Brain');
        const old = rows.filter({ hasText: 'add the canary hold and the rollback' });
        await expect(old).toHaveCount(1);
        await old.locator('.commit-head').click();
        await expect(old).toHaveAttribute('data-selected', 'true');
      },
    },
    {
      id: 'restore',
      expect: 'history',
      run: async ({ page }) => {
        await page.getByTestId('restore-version').click();
        const dialog = page.getByTestId('dialog-restore');
        await expect(dialog.getByTestId('restore-question')).toContainText('A new commit will be made');
        await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
        await expect(page.getByText('Restored. A new commit was made.')).toBeVisible();
        // no reload: the viewer behind the History panel shows the restored page by itself (it used to keep the text from before the restore)
        const restored = page.getByTestId('viewer-markdown').locator('.md-prose');
        await expect(restored).toContainText('canary');
        await expect(restored).not.toContainText(SECTION);
        await expect(restored).not.toContainText(NADIA_LINE);
      },
    },
  ],
  outcome: async ({ api }) => {
    const nadia = await api('nadia');
    const blob = await nadia.get<{ content: string }>(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(PAGE)}`);
    expect(blob.content, 'the restored runbook has the canary hold of the version she chose').toContain('--canary 10');
    expect(blob.content, "Brain's section is gone with the restore").not.toContain(SECTION);
    expect(blob.content, 'and so is her line').not.toContain(NADIA_LINE);
    // nothing was lost: the restore is a new commit on top of the bot's write (which carries her line and names her as co-author)
    const history = await nadia.get<{ commits: Array<{ subject: string; authorName: string; coAuthorIds: string[] }> }>(`/api/teams/engineering/repo/history?path=${encodeURIComponent(PAGE)}`);
    expect(history.commits, 'two seed commits, the live session, the restore').toHaveLength(4);
    expect(history.commits[0]!.subject, 'the newest commit is the restore').toMatch(/^Restore runbook\.md/);
    expect(history.commits[1]!.subject, "the live session's commit (Brain's section and her line)").toBe('Edit pages/runbook.md live with 2 editors');
    expect(history.commits[1]!.authorName).toBe('Nadia');
    expect(history.commits[1]!.coAuthorIds, 'with Brain as co-author').toHaveLength(1);
  },
});
