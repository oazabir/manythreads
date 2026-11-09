// What Lena's journeys share (PLAN P12-03): the stack variables that put the Hermes stand-in in, and the arrangements made through the real routes before she looks.
// She only ever reads: a Coder release post and a Brain answer Nadia shared into #releases.
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { conversationStackEnv, useWorkspaceBrain } from '../../../conversations/support.ts';
import type { Stack } from '../../../fixtures/stack.ts';
import { postAs as postAsApi } from '../../../support/stack-browser.ts';
import type { JourneyContext, Persona } from '../../harness/journey.ts';
import { monitorPage, type IgnoreRule } from '../../harness/monitor.ts';

const STAND_IN = fileURLToPath(new URL('./hermes-lena.mjs', import.meta.url));

/** Made once per process: every journey of Lena names the same value, so they share one stack (the runtime folder is new at each call of `conversationStackEnv`). */
export const LENA_ENV: Readonly<Record<string, string>> = Object.freeze({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: STAND_IN, MANYTHREADS_STACK_MEETINGS: '1' });

const ENGINEERING = '00000000-0000-7000-8000-0000000b0001';

/** A bot needs a model to run: bind the aliases the shipped bots ask for and wait until the workspace Brain exists. Safe to call twice. */
export async function readyForBots(stack: Stack): Promise<void> {
  await useWorkspaceBrain(stack);
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, a, 'test-model' FROM app.workspaces, unnest(ARRAY['smart', 'fast']) AS a ON CONFLICT DO NOTHING`);
}

/** Waits for the bot of a team to exist (the loader makes it from the repository a moment after the stack is up). */
export async function waitForBot(stack: Stack, slug: string, team = ENGINEERING): Promise<{ id: string; actorId: string }> {
  let found: { id: string; actor_id: string } | undefined;
  for (let i = 0; i < 150 && !found; i += 1) {
    found = (
      await stack.sql<{ id: string; actor_id: string }>(
        `SELECT b.id, a.id AS actor_id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.team_id = $1 AND b.slug = $2 AND b.status = 'active'`,
        [team, slug],
      )
    )[0];
    if (!found) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(found, `the bot ${slug} to be made`).toBeTruthy();
  return { id: found!.id, actorId: found!.actor_id };
}

/** Gives a bot the tools its shipped definition does not grant (the grants table is what the gateway checks at every call). */
export async function grantTools(stack: Stack, slug: string, tools: readonly string[]): Promise<void> {
  const bot = await waitForBot(stack, slug);
  for (const tool of tools) {
    await stack.sql(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}') ON CONFLICT (actor_id, capability) DO NOTHING`,
      [ENGINEERING, bot.actorId, tool],
    );
  }
}

/** The id of a channel of the Engineering team by name, as that person's directory lists it. */
export async function channelId(ctx: JourneyContext, who: Persona, name: string): Promise<string> {
  const api = await ctx.api(who);
  const dir = await api.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels');
  const found = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === name);
  expect(found, `${who} sees the channel #${name}`).toBeTruthy();
  return found!.id;
}

/** Posts a message as a colleague through the API (the part of the story that happens in another window). */
export async function say(ctx: JourneyContext, who: Persona, channel: string, body: string, threadRootId: string | null = null): Promise<{ id: string }> {
  return postAsApi(await ctx.api(who), channel, body, threadRootId);
}

/** The id of the message with this text, written by anybody (the journeys arrange their own sentences, so the text is unique). */
export async function messageWith(stack: Stack, like: string): Promise<string> {
  const rows = await stack.sql<{ id: string }>('SELECT id FROM app.messages WHERE body LIKE $1 ORDER BY created_at LIMIT 1', [like]);
  expect(rows[0], `a message like ${like}`).toBeTruthy();
  return rows[0]!.id;
}

/**
 * KNOWN PRODUCT FINDING: a person who opens a bot's post made for somebody else's question makes the client ask `GET /api/runs/<id>/origin`, which answers 404 (or 403)
 * because the run is not hers; the card stays out of sight and the post reads fine, but the page logs the failure. Any status of that one address is let through.
 */
export const RUN_ORIGIN_NOT_YOURS: IgnoreRule = { url: /\/api\/runs\/[0-9a-f-]{36}\/origin$/ };

/**
 * KNOWN PRODUCT FINDING: the shell of a guest asks `GET /api/teams/<slug>/projects` for the team it is looking at, and the server (rightly) answers 403, so every channel
 * screen of a guest logs a failed request. The screen reads fine. The one address is let through (the browser's console line carries no status).
 */
export const GUEST_SHELL_PROJECTS: IgnoreRule = { url: /\/api\/teams\/[^/]+\/projects$/ };

/** Attaches the page monitor of the window with the known harmless answer allowed. Call before the first picture of the window. */
export function allowKnownNoise(page: import('@playwright/test').Page): void {
  monitorPage(page, [RUN_ORIGIN_NOT_YOURS, GUEST_SHELL_PROJECTS]);
}

/** The id of a channel of Engineering by its name (the screens of a guest answer from her own directory, so a refusal of the server is asked for by id). */
export async function engineeringChannelId(stack: Stack, name: string): Promise<string> {
  const rows = await stack.sql<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND kind = 'channel' AND replace(name, '#', '') = $2`, [ENGINEERING, name]);
  expect(rows, `Engineering has the channel ${name}`).toHaveLength(1);
  return rows[0]!.id;
}
