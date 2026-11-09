// What Tariq's journeys share (PLAN P12-03): the stack variables that put the Hermes stand-in in, a Brain that may answer, and the Marketing bots made able to act. The Hermes behind
// Brain and the Content drafter is the stand-in of hermes-tariq.mjs: the platform runs, reads sources and posts for real, only the model is missing.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { monitorPage } from '../../harness/monitor.ts';
import type { Stack } from '../../../fixtures/stack.ts';
import { conversationStackEnv, useWorkspaceBrain } from '../../../conversations/support.ts';
import { applyGuarded, type StackApi } from '../../../support/stack-browser.ts';

const STAND_IN = fileURLToPath(new URL('./hermes-tariq.mjs', import.meta.url));

/** Computed once per process, so every journey of Tariq names the same value and shares one stack (the runtime folder is new at each call of `conversationStackEnv`). */
export const TARIQ_ENV: Readonly<Record<string, string>> = Object.freeze({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: STAND_IN });

export const TEAM = 'marketing';

/** Brain as these journeys need it: it answers a conversation and a mention, reads messages and memory, and finishes with an Answer. */
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
    '  native: [messages.search, memory.recall, messages.post, answer.post]',
    '---',
    '',
    '# Brain',
    '',
    'Answers questions from the team repo and its memory.',
    '',
  ].join('\n');

/** Makes the workspace Brain answer with Answers, and gives the `smart` alias a model so a conversation can start. Safe to call again. */
export async function arrangeBrain(stack: Stack, prompts: readonly string[]): Promise<void> {
  await useWorkspaceBrain(stack, brainMd(prompts));
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, 'smart', 'test-model' FROM app.workspaces ON CONFLICT DO NOTHING`);
}

/** The Content drafter as Marketing's lead would set it up to act: it answers a mention in #content and writes pages (no approval), as its template says. */
export const contentDrafterMd = (): string =>
  [
    '---',
    'schema: 1',
    'name: Content drafter',
    "role: Drafts posts, emails and pages in the team's voice",
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - { type: mention }',
    '  - { type: routine }',
    'capabilities:',
    '  native: [pages.write, messages.post, messages.search]',
    '---',
    '',
    '# Content drafter',
    '',
    'You draft posts, emails and pages in the team voice, from a brief. You write drafts; you never publish.',
    '',
  ].join('\n');

/**
 * A lead commits a new `bots/<slug>/BOT.md` for a seeded bot (the placeholder cannot act) and waits until the loader has made it live: the bot row carries the new definition.
 * Safe to call again with the same text.
 */
export async function arrangeBot(stack: Stack, admin: StackApi, team: string, slug: string, md: string): Promise<void> {
  const sha = (): Promise<string | undefined> =>
    stack
      .sql<{ sha: string }>(`SELECT b.definition_sha AS sha FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2 AND b.status = 'active'`, [team, slug])
      .then((rows) => rows[0]?.sha);
  const before = await sha();
  if (before === createHash('sha256').update(Buffer.from(md, 'utf8')).digest('hex')) return;
  const res = await applyGuarded(admin, `bots/${slug}/BOT.md`, md, `Let ${slug} act`, { team });
  if (res.status >= 300) throw new Error(`could not update ${slug}: ${res.status} ${res.text.slice(0, 300)}`);
  for (let i = 0; i < 150; i += 1) {
    const now = await sha();
    if (now && now !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the loader did not pick up the new definition of ${slug}`);
}

/**
 * Two answers of the product that the monitor would otherwise count as a failed request, both by design and both asked about on every bot message:
 *  - a new conversation's first read of its state answers 404 (the server's index of a conversation trails a new message by a moment, clients/web/src/screens/chat/useChatState.ts);
 *  - a bot's post asks `GET /api/runs/:id/origin` and "a 404 is an answer" when the run was not started by an app (clients/web/src/channels/RunOriginCard.tsx).
 * Call it in a journey's first step, before the first picture (the first monitor of a page is the one that stays).
 */
export function allowKnownNoise(page: Page): void {
  monitorPage(page, [{ url: /\/bots\/[^/]+\/conversations\/[^/]+\/state$/ }, { url: /\/api\/runs\/[^/]+\/origin$/ }]);
}
