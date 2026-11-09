// O3: Omar connects a model provider, binds the `smart` alias to a model, caps the month's spend, and reads what has been spent (Settings, Workspace, LLM).
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';

const KEY = ['sk-journey', 'omar-o3-0001'].join('');

export default defineJourney({
  id: 'O3',
  persona: 'omar',
  goal: 'Connect a model provider, bind an alias, set a monthly budget and read the spend.',
  markers: [],
  start: 'week-2',
  steps: [
    {
      id: 'llm-settings',
      expect: TID.llmAliases,
      next: { testid: 'llm-add-provider', label: 'Add a provider' },
      run: async ({ pages }) => {
        await pages.llm.open();
      },
    },
    {
      id: 'provider-added',
      expect: TID.llmProviders,
      next: { testid: TID.llmAliases, label: 'Aliases' },
      run: async ({ page }) => {
        const form = page.getByTestId('llm-add-provider');
        await form.getByLabel('Name').fill('Journey OpenAI');
        await form.getByLabel('API key').fill(KEY);
        await form.getByRole('button', { name: 'Add provider' }).click();
        const row = page.locator('[data-provider="Journey OpenAI"]');
        await expect(row).toBeVisible();
        await expect(row).toContainText('stored');
        await expect(page.locator('body')).not.toContainText(KEY);
      },
    },
    {
      id: 'alias-bound',
      expect: TID.llmAliases,
      next: { testid: 'llm-set-limit', label: 'Set a limit' },
      run: async ({ page }) => {
        await page.getByLabel('smart model').fill('gpt-4o');
        await page.getByLabel('smart provider').selectOption({ label: 'Journey OpenAI' });
        await page.locator('[data-alias="smart"]').getByRole('button', { name: 'Save' }).click();
        await expect(page.getByText('The smart alias is bound to gpt-4o.')).toBeVisible();
      },
    },
    {
      id: 'budget-set',
      expect: TID.llmLimits,
      next: { testid: 'llm-spend-total', label: 'Spend' },
      run: async ({ page }) => {
        const form = page.getByTestId('llm-set-limit');
        await form.getByLabel('Budget (USD)').fill('50');
        await form.getByRole('button', { name: 'Set limit' }).click();
        await expect(page.getByText('The workspace limit is saved.')).toBeVisible();
        await expect(page.getByTestId(TID.llmLimits)).toContainText('$50.00');
      },
    },
    {
      id: 'spend-read',
      expect: 'llm-spend-total',
      run: async ({ page }) => {
        await page.getByTestId('llm-spend-total').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('llm-spend-total-usd')).toBeVisible();
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const omar = await api('omar');
    const aliases = await stack.sql<{ model: string }>(`SELECT model FROM app.llm_aliases WHERE alias = 'smart'`);
    expect(aliases[0]?.model).toBe('gpt-4o');
    const limits = await omar.get<{ limits: Array<{ scope: string; limitUsd: number | null }> }>('/api/workspace/llm/limits');
    expect(limits.limits.find((l) => l.scope === 'workspace')?.limitUsd).toBe(50);
    const providers = JSON.stringify(await omar.get('/api/workspace/llm/providers'));
    expect(providers, 'the key is never given back').not.toContain(KEY);
  },
});
