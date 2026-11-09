// O5 (B): Nadia asks Brain a question; Omar, the workspace admin, finds what happened in the Audit console and exports it. Then the three things an admin may NOT do:
// read Nadia's private conversation, read a provider key back, open a channel he is not in. Every refusal is tried and photographed.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { BOTS_ENV, allowChatStateRace, askFromPage, openRefused, readyForBots } from './support/index.ts';

const NADIA_QUESTION = 'What do we do when the search index falls behind?';
const KEY = ['sk-journey', 'omar-secret-0042'].join('');

export default defineJourney({
  id: 'O5',
  persona: 'omar',
  goal: 'See what the workspace recorded when Nadia shared a Brain answer, export it for an auditor, and see that I still cannot read her chat or a stored key.',
  markers: ['B'],
  start: 'week-2',
  stackEnv: BOTS_ENV,
  steps: [
    {
      id: 'audit-opened',
      expect: TID.auditTable,
      next: { testid: TID.auditExport, label: 'Export' },
      run: async (ctx) => {
        allowChatStateRace(ctx);
        await readyForBots(ctx.stack);
        // Nadia asks Brain in her own window: this is what the audit rows are about
        const nadia = await ctx.also('nadia');
        await nadia.pages.brain.open();
        const answer = await nadia.pages.brain.ask(NADIA_QUESTION, { timeoutMs: 90_000 });
        await expect(answer.getByTestId(TID.answerCitation).first()).toBeVisible();
        // she shares the answer to #dev: that is the act the audit log records (a plain question leaves no row, a share does)
        await nadia.page.getByTestId('answer-share-open').click();
        await nadia.page.getByTestId('answer-share-target').selectOption({ label: '# dev · Engineering' });
        await nadia.page.getByTestId('answer-share-confirm').click();
        await expect(nadia.page.getByTestId('answer-share-dialog')).toBeHidden({ timeout: 30_000 });
        await ctx.pages.audit.open();
      },
    },
    {
      id: 'filtered-to-nadia',
      expect: TID.auditTable,
      next: { testid: TID.auditExport, label: 'Export' },
      run: async ({ page }) => {
        const who = page.getByRole('group', { name: 'Who' }).getByRole('button', { name: 'Nadia', exact: true });
        // the audit rows reach the log through the event outbox a moment after the share: read the page again until Nadia is in it
        await expect
          .poll(async () => {
            await page.reload();
            await expect(page.getByTestId(TID.auditTable)).toBeVisible();
            return who.count();
          }, { timeout: 60_000, intervals: [2_000, 3_000] })
          .toBeGreaterThan(0);
        await who.click();
        await expect(who).toHaveAttribute('aria-pressed', 'true');
        // the table is read again after the chip is pressed: wait until every row is Nadia's
        await expect
          .poll(async () => [...new Set(await page.locator('[data-testid="audit-table"] tbody tr .audit-who').allTextContents())], { timeout: 30_000 })
          .toEqual(['Nadia']);
        await expect(page.getByTestId(TID.auditTable)).toContainText('Shared an answer');
      },
    },
    {
      id: 'exported',
      expect: 'audit-export-done',
      run: async ({ page }) => {
        const download = page.waitForEvent('download');
        await page.getByTestId(TID.auditExport).click();
        expect((await download).suggestedFilename()).toMatch(/\.ndjson$/);
      },
    },
    {
      id: 'key-never-shown',
      expect: TID.llmProviders,
      next: { testid: TID.llmAliases, label: 'Aliases' },
      run: async ({ api, page, pages }) => {
        const omar = await api('omar');
        const made = await omar.status('POST', '/api/workspace/llm/providers', { name: 'Journey OpenAI', kind: 'openai', apiKey: KEY });
        expect(made, 'a provider with a key is stored').toBeLessThan(300);
        await pages.llm.open();
        const row = page.locator('[data-provider="Journey OpenAI"]');
        await expect(row).toContainText('stored');
        await expect(page.locator('body')).not.toContainText(KEY);
        // the key is write-only: neither the list nor a read of the row gives it back
        const list = JSON.stringify(await omar.get('/api/workspace/llm/providers'));
        expect(list).not.toContain(KEY);
      },
    },
    {
      id: 'key-read-refused',
      expect: TID.llmProviders,
      expectDenied: 404,
      run: async ({ api, page, stack, pages }) => {
        // PLAN: "reading a stored provider secret ... (expectDenied)". The key is write-only: no route gives a provider back with its key, so a hand-made read of the row answers 404
        // (an unknown route is not found, and the list above shows `hasSecret` only). And a person who is not an admin does not even get the list: the server answers 403 (the comment in
        // packages/shared/src/api/llm/providers.ts says 404; the answer is what the journey pins).
        await pages.llm.open();
        const id = (await stack.sql<{ id: string }>(`SELECT id FROM app.llm_providers WHERE name = 'Journey OpenAI'`))[0]?.id;
        expect(id, 'the provider stored by the step before').toBeTruthy();
        expect(await askFromPage(page, 'GET', `/api/workspace/llm/providers/${id!}`), 'a read of the provider row').toBe(404);
        const nadia = await api('nadia');
        expect(await nadia.status('GET', '/api/workspace/llm/providers'), "a member's read of the provider list").toBe(403);
        expect(await nadia.status('GET', `/api/workspace/llm/providers/${id!}`), "a member's read of the provider row").toBe(404);
      },
    },
    {
      id: 'conversation-refused',
      expect: TID.noAccess,
      expectDenied: 403,
      run: async ({ stack, page }) => {
        const rows = await stack.sql<{ channel_id: string }>(`SELECT m.channel_id FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.meta ? 'answer' AND c.kind <> 'channel' ORDER BY m.created_at DESC LIMIT 1`);
        const channel = rows[0]?.channel_id;
        expect(channel, "Nadia's Brain chat has a channel").toBeTruthy();
        await openRefused(page, `/t/engineering/dm/${channel!}`, channel!);
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const omar = await api('omar');
    const rows = await stack.sql<{ channel_id: string }>(`SELECT m.channel_id FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.meta ? 'answer' AND c.kind <> 'channel' ORDER BY m.created_at DESC LIMIT 1`);
    expect(await omar.status('GET', `/api/channels/${rows[0]!.channel_id}/messages`), "the admin cannot read Nadia's chat").toBe(403);
    const audit = await omar.get<{ entries: Array<{ action: string }> }>('/api/admin/audit?action=audit.exported');
    expect(audit.entries.length, 'the export is itself an audit row').toBeGreaterThan(0);
  },
});
