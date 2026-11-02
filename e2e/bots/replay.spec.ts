import { expect, test } from '@playwright/test';
import { personas } from '@manythreads/test-utils';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { addBot, conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, postAs } from '../support/stack-browser.ts';

/*
 * Replay of a bot's recorded decisions and the "check this again" notices, in the browser (PLAN P7-07). The server and the database are real; the model is a stand-in that counts its calls so the
 * free replay can prove it made none. The recorded decisions are written to the tables the way a run writes them. Both layouts. Runs on a stack of its own because it adds a bot and files notices.
 */
test.describe.configure({ mode: 'serial' });

let fake: FakeLlm;
let stack: Stack;
let modelCalls = 0;
let botId = '';
let runId = '';
const ROTATE = 'Please do the credential rotation today.';

const BOT_MD = [
  '---',
  'schema: 1',
  'name: Replayer',
  'role: Answers questions about the release checklist.',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post, messages.search, answer.post]',
  'guard:',
  "  gate: ['credential rotation']",
  '---',
  '',
  'RELEASE-HELPER-BODY: you answer questions about the release checklist. If you do not know, say so and ask a person.',
  '',
].join('\n');

test.beforeAll(async ({ playwright }) => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: () => {
      modelCalls += 1;
      return 'This is the replayed answer.';
    },
  });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    const headers = await api.headers();
    const created = await api.ctx.post('/api/workspace/llm/providers', { data: { name: 'OpenAI', kind: 'openai', apiKey: ['sk-e2e', 'replay-key-0001'].join('') }, headers });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const providerId = ((await created.json()) as { provider: { id: string } }).provider.id;
    const bound = await api.ctx.put('/api/workspace/llm/aliases/smart', { data: { providerId, model: 'gpt-4o', fallbacks: [] }, headers });
    expect(bound.status(), await bound.text()).toBe(200);
    await stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
    botId = (await addBot(stack, api, 'replayer', BOT_MD)).botId;

    // one earlier run of the bot, asked by Omar, with what its gate, guard and tool door decided then (the gate let a message through that today's list holds)
    const channels = await channelsOf(api);
    const message = await postAs(api, channels['dev'] as string, ROTATE);
    const team = (await stack.sql<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`))[0]!.id;
    const workspace = (await stack.sql<{ id: string }>(`SELECT id FROM app.workspaces LIMIT 1`))[0]!.id;
    runId = (
      await stack.sql<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'mention', $4, 'done') RETURNING id`,
        [workspace, botId, team, personas.omar.actorId],
      )
    )[0]!.id;
    const line = (seq: number, kind: string, subject: string, outcome: string, messageId: string | null, detail: object) =>
      stack.sql(`INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome, message_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [runId, seq, kind, subject, outcome, messageId, JSON.stringify(detail)]);
    await line(0, 'gate', 'gate', 'passed', message.id, { stage: 'none' });
    await line(1, 'guard', 'smart', 'redact', null, { reason: 'dlp', preset: 'standard' });
    await line(2, 'tool', 'email.send', 'needs_approval', null, { reason: 'destructive', tool: 'email.send' });
    await stack.sql(`INSERT INTO app.llm_spend (workspace_id, team_id, bot_id, run_id, alias, prompt_tokens, completion_tokens, cost_usd) VALUES ($1, $2, $3, $4, 'smart', 120, 30, 0.003)`, [workspace, team, botId, runId]);
    // two things the bot depends on changed
    for (const [reason, subject, headline] of [
      ['runner_revoked', 'office-box', 'The runner “office-box”, which this bot runs on, was taken away.'],
      ['knowledge_removed', 'manuals', 'The knowledge base “manuals”, which this bot reads, was removed.'],
    ] as const) {
      await stack.sql(`INSERT INTO app.bot_reassessments (workspace_id, team_id, bot_id, reason, subject, headline, checks) VALUES ($1, $2, $3, $4, $5, $6, '["Send the bot a test message."]')`, [workspace, team, botId, reason, subject, headline]);
    }
  } finally {
    await api.ctx.dispose();
  }
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
});

test('a lead sees the notices, replays the decisions for free, reads which would change, and asks the bot again only after seeing the cost', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(300_000);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/replayer/chat?view=workshop&mode=build', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- outside Live the notices are one line that says how many wait, with a way to Live
    await expect(page.getByTestId('ws-reassess-line')).toContainText('2 things to check again');
    await expect(page.getByTestId('ws-reassess-card')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('ws-reassess-open').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ws-mode-live')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ws-reassess-card')).toHaveCount(2);
    await expect(page.getByTestId('ws-reassess')).toContainText('Send the bot a test message.');
    await expect(page.getByTestId('ws-reassess')).toContainText('Send the bot a test message.');
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- a notice is closed by a button, and the list shrinks
    await page.getByTestId('ws-reassess-done').first().click();
    await expect(page.getByTestId('ws-reassess-card')).toHaveCount(1);
    await expect(page.getByTestId('ws-reassess')).toContainText('Marked as checked.');
    expect(await stack.sql(`SELECT 1 FROM app.bot_reassessments WHERE status = 'done'`)).toHaveLength(1);

    // ---- the free replay: by keyboard, no model, no write
    const spoken = modelCalls;
    const rows = async (sql: string) => Number((await stack.sql<{ n: string }>(sql))[0]!.n);
    const before = [await rows('SELECT count(*) AS n FROM app.messages'), await rows('SELECT count(*) AS n FROM app.run_decisions'), await rows('SELECT count(*) AS n FROM app.bot_runs'), await rows('SELECT count(*) AS n FROM app.workshop_sessions')];
    await page.getByTestId('ws-replay-run').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ws-replay-summary')).toContainText('Checked 3 decisions from 1 run.', { timeout: 30_000 });
    await expect(page.getByTestId('ws-replay-summary')).toContainText('2 would be stricter');
    await expect(page.getByTestId('ws-replay-change')).toHaveCount(2);
    await expect(page.locator('[data-testid="ws-replay-change"][data-verdict="tighter"]')).toHaveCount(2);
    await expect(page.getByTestId('ws-replay-changes')).toContainText('Then it went through. Now it would wait for a person.');
    await expect(page.getByTestId('ws-replay-changes')).toContainText('Then it waited for a person. Now it would be stopped.');
    // the result is read out and takes focus; the message text is nowhere on the page
    await expect(page.getByTestId('ws-replay-announce')).toContainText('Checked 3 decisions');
    await expect(page.getByTestId('ws-replay')).not.toContainText(ROTATE);
    await expect(page.getByTestId('ws-replay-notes')).toContainText('Nothing was sent to a model');
    expect(modelCalls).toBe(spoken);
    expect([await rows('SELECT count(*) AS n FROM app.messages'), await rows('SELECT count(*) AS n FROM app.run_decisions'), await rows('SELECT count(*) AS n FROM app.bot_runs'), await rows('SELECT count(*) AS n FROM app.workshop_sessions')]).toEqual(before);
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- a full replay: the cost first, a way out, then the same number confirms it
    await page.getByTestId('ws-full-ask').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ws-estimate')).toBeVisible();
    await expect(page.getByTestId('ws-estimate')).toContainText('about 150 tokens (120 read, 30 written)');
    await expect(page.getByTestId('ws-estimate')).toContainText('stops after 8 model calls');
    await expect(page.getByTestId('ws-full-confirm')).toContainText('Run it (about 150 tokens)');
    expect(await rows('SELECT count(*) AS n FROM app.workshop_sessions')).toBe(before[3]);
    expect(modelCalls).toBe(spoken);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('ws-full-cancel').click();
    await expect(page.getByTestId('ws-estimate')).toHaveCount(0);
    await expect(page.getByTestId('ws-full-ask').first()).toBeFocused();

    await page.getByTestId('ws-full-ask').first().click();
    await page.getByTestId('ws-full-confirm').click();
    // it opens as a rehearsal of the stored message, and the model answers once the person asked for it
    await expect(page.getByTestId('ws-mode-rehearse')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('ws-reply')).toContainText('This is the replayed answer.', { timeout: 90_000 });
    await expect(page.getByTestId('ws-reply')).toHaveAttribute('data-rehearsal', 'true');
    expect(modelCalls).toBeGreaterThan(spoken);
    const started = await stack.sql<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'workshop.replay.started'`);
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ runId, tokens: 150 });
    expect(JSON.stringify(started[0]!.payload)).not.toContain(ROTATE);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a plain member reads the notices and replays what they may see, and is told that only a lead asks the bot again', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(120_000);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/replayer/chat?view=workshop&mode=live', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.getByTestId('ws-reassess-card')).toHaveCount(1);
    // she cannot close it: no button, and the page says who can
    await expect(page.getByTestId('ws-reassess-done')).toHaveCount(0);
    await expect(page.getByTestId('ws-reassess')).toContainText('A team lead or an admin closes this notice.');
    await page.getByTestId('ws-replay-run').click();
    // the run was Omar's: Nadia replays only what she asked herself, which is nothing
    await expect(page.getByTestId('ws-replay-summary')).toContainText('There are no runs of this bot in the last 7 days that you can replay.', { timeout: 30_000 });
    await expect(page.getByTestId('ws-full-lead-only')).toContainText('Only a team lead or an admin');
    await expect(page.getByTestId('ws-full-ask')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    // the platform does not rely on the page: asked directly, it refuses in words
    const api = await apiOn(playwright, stack, 'nadia');
    try {
      const refused = await api.ctx.post(`/api/teams/engineering/bots/replayer/replay/runs/${runId}/full`, { data: {}, headers: await api.headers() });
      expect(refused.status()).toBe(403);
      expect(await refused.text()).toContain('Only a team lead or an admin');
    } finally {
      await api.ctx.dispose();
    }
  } finally {
    await context.close();
  }
});
