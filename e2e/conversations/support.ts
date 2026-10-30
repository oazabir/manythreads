import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, applyGuarded, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the conversation specs (PLAN P5-16). Each spec file starts a stack seeded with `repo` (the seed's own commit has already made the
 * bot `coder`) whose Hermes runtime is the stand-in of ./fake-hermes.mjs: a person's message goes through the real router, a real run is
 * opened for them, and the bot's reply is posted into the thread by the platform — only the model is missing.
 */

const FAKE = fileURLToPath(new URL('./fake-hermes.mjs', import.meta.url));
const FAKE_ANSWER = fileURLToPath(new URL('./fake-hermes-answer.mjs', import.meta.url));

/** The environment the stack's server reads when the runtime registers. The path of the stand-in must not hold a space (the prefix is split on them). */
export function conversationStackEnv(): Record<string, string> {
  return {
    MANYTHREADS_STACK_SEED: 'repo',
    MANYTHREADS_HERMES_BIN: process.execPath,
    MANYTHREADS_HERMES_PREFIX: FAKE,
    MANYTHREADS_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'manythreads-e2e-hermes-')),
    MANYTHREADS_LITELLM_URL: 'http://litellm.invalid:4000',
  };
}

/** The same, with the stand-in that finishes a run with the `answer.post` tool (PLAN P5-18); see fake-hermes-answer.mjs. */
export function answerStackEnv(): Record<string, string> {
  return { ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: FAKE_ANSWER };
}

const ENGINEERING = '00000000-0000-7000-8000-0000000b0001';

/** A BOT.md that answers a conversation (and a mention), with the example questions the chips show. */
export const brainMd = (prompts: readonly string[]): string =>
  [
    '---',
    'schema: 1',
    'name: Brain',
    'role: Answers from what the team knows',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - { type: conversation }',
    '  - { type: mention }',
    'conversation:',
    '  prompts:',
    ...prompts.map((p) => `    - "${p}"`),
    'capabilities:',
    '  native: [messages.post]',
    '---',
    '',
    '# Brain',
    '',
    'Answers questions from the team repo and its memory.',
    '',
  ].join('\n');

/** Brain as the Answer specs need it: it may read, post and finish with `answer.post`. */
export const answeringBrainMd = (): string => brainMd(['What is blocking the release?']).replace('  native: [messages.post]', '  native: [messages.search, messages.post, answer.post]');

/**
 * A lead commits `bots/<slug>/BOT.md` (an admin may add a bot) and waits until the loader has made the bot: its row is active and its actor
 * exists, which is what a run needs.
 */
export async function addBot(stack: Stack, admin: StackApi, slug: string, md: string): Promise<{ botId: string }> {
  const res = await applyGuarded(admin, `bots/${slug}/BOT.md`, md, `Add ${slug}`);
  expect(res.status, `apply ${slug}: ${res.text}`).toBe(201);
  let botId = '';
  for (let i = 0; i < 150 && botId === ''; i += 1) {
    const row = (
      await stack.sql<{ id: string }>(
        `SELECT b.id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.team_id = $1 AND b.slug = $2 AND b.status = 'active'`,
        [ENGINEERING, slug],
      )
    )[0];
    if (row) botId = row.id;
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(botId, `the loader to make ${slug}`).not.toBe('');
  return { botId };
}

export async function openChat(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  path: string,
  mobile: boolean,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, path, mobile ? { viewport: PHONE, mobile: true } : {});
  return { page, close: () => context.close() };
}

/** The conversation channel of a person with a bot, as the database has it. */
export async function channelOf(stack: Stack, botId: string, who: PersonaKey): Promise<string> {
  const email = `${who}@kahf.example`;
  const row = (
    await stack.sql<{ id: string }>(
      `SELECT c.id FROM app.channels c JOIN app.actors a ON a.id = c.created_by JOIN app.people p ON p.id = a.ref_id
        WHERE c.kind = 'bot_conversation' AND c.bot_id = $1 AND p.primary_email = $2`,
      [botId, email],
    )
  )[0];
  expect(row, `${who}'s conversation channel`).toBeTruthy();
  return row!.id;
}

export { apiOn };
