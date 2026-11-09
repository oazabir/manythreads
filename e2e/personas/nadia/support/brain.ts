// What the Nadia and Sameera journeys that talk to a bot arrange (PLAN P12-03): a stack whose Hermes is the stand-in of hermes-persona.mjs, and a Brain that may answer.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { monitorPage } from '../../harness/monitor.ts';
import type { Stack } from '../../../fixtures/stack.ts';
import { conversationStackEnv, useWorkspaceBrain } from '../../../conversations/support.ts';
import { applyGuarded, type StackApi } from '../../../support/stack-browser.ts';

const STAND_IN = fileURLToPath(new URL('./hermes-persona.mjs', import.meta.url));

/**
 * The stack variables of a journey that talks to a bot. Computed once per process, so every journey of a persona names the same value and shares one stack (the
 * harness gives a different `stackEnv` its own stack, and the runtime folder is made fresh by each call of `conversationStackEnv`).
 */
export const BOT_STACK_ENV: Readonly<Record<string, string>> = { ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: STAND_IN };

/** Brain as these journeys need it: it answers a conversation and a mention, reads messages and memory, and finishes with an Answer. */
export const brainMd = (prompts: readonly string[], moreNative: readonly string[] = []): string =>
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
    `  native: [${['messages.search', 'memory.recall', 'messages.post', 'answer.post', ...moreNative].join(', ')}]`,
    '---',
    '',
    '# Brain',
    '',
    'Answers questions from the team repo and its memory.',
    '',
  ].join('\n');

/** Makes the workspace Brain answer with Answers, and gives the `smart` alias a model so a conversation can start. Safe to call again. */
export async function arrangeBrain(stack: Stack, prompts: readonly string[], moreNative: readonly string[] = []): Promise<void> {
  await useWorkspaceBrain(stack, brainMd(prompts, moreNative));
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, 'smart', 'test-model' FROM app.workspaces ON CONFLICT DO NOTHING`);
}

/**
 * Two answers of the product that the monitor would otherwise count as a failed request, both by design and both asked about on every bot message:
 *  - a new conversation's first read of its state answers 404 ("the server's index of a conversation trails a new message by a moment, so a 404 for a conversation that was just started
 *    is asked again a few times", clients/web/src/screens/chat/useChatState.ts);
 *  - a bot's post asks `GET /api/runs/:id/origin` and "a 404 is an answer" when the run was not started by an app (clients/web/src/channels/RunOriginCard.tsx).
 * Only these two addresses are let through, whatever they answer. Call it in a journey's first step, before the first picture (the first monitor of a page is the one that stays).
 * Reported to the lead as a finding: the second one is a console error on every page that shows a bot's message.
 */
export function allowKnownNoise(page: Page): void {
  monitorPage(page, [{ url: /\/bots\/[^/]+\/conversations\/[^/]+\/state$/ }, { url: /\/api\/runs\/[^/]+\/origin$/ }]);
}

/** The tools a bot that answers by posting needs; the seed's placeholder definitions (`bots/<slug>/BOT.md`) carry none. */
export const talkingBotMd = (name: string, role: string, triggers: readonly string[], approval?: { tools: readonly string[]; approvers: readonly string[] }, moreTools: readonly string[] = []): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    `role: ${role}`,
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...triggers.map((t) => `  - { type: ${t} }`),
    'capabilities:',
    `  native: [${['messages.search', 'messages.post', ...moreTools].join(', ')}]`,
    ...(approval ? ['approvals:', `  needsApproval: [${approval.tools.join(', ')}]`, ...(approval.approvers.length > 0 ? [`  approvers: [${approval.approvers.join(', ')}]`] : [])] : []),
    '---',
    '',
    `# ${name}`,
    '',
    `${role}.`,
    '',
  ].join('\n');

/**
 * A lead commits a new `bots/<slug>/BOT.md` for a seeded bot (the placeholder cannot post) and waits until the loader has made it live: the bot row carries the new definition.
 * Safe to call again with the same text.
 */
export async function arrangeBot(stack: Stack, admin: StackApi, team: string, slug: string, md: string): Promise<void> {
  const before = (await stack.sql<{ sha: string }>(`SELECT b.definition_sha AS sha FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2`, [team, slug]))[0]?.sha;
  if (before === createHash('sha256').update(Buffer.from(md, 'utf8')).digest('hex')) return;
  const res = await applyGuarded(admin, `bots/${slug}/BOT.md`, md, `Let ${slug} answer`, { team });
  if (res.status >= 300) throw new Error(`could not update ${slug}: ${res.status} ${res.text.slice(0, 300)}`);
  for (let i = 0; i < 150; i += 1) {
    const now = (await stack.sql<{ sha: string }>(`SELECT b.definition_sha AS sha FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2 AND b.status = 'active'`, [team, slug]))[0]?.sha;
    if (now && now !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the loader did not pick up the new definition of ${slug}`);
}
