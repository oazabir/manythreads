// What the journeys of Omar, Rafi and Priya share (PLAN P12-03): the Hermes stand-in that plays the model for Brain and Coder, the stack variables that put it
// in, and the arrangements a journey makes through the real routes before the first picture (a bot that needs a model, a post by a colleague).
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { conversationStackEnv, useWorkspaceBrain } from '../../../conversations/support.ts';
import type { Stack } from '../../../fixtures/stack.ts';
import { postAs as postAsApi } from '../../../support/stack-browser.ts';
import type { JourneyContext, Persona } from '../../harness/journey.ts';
import { monitorPage, type IgnoreRule } from '../../harness/monitor.ts';

const PERSONA_HERMES = fileURLToPath(new URL('./persona-hermes.mjs', import.meta.url));

/**
 * The stack variables of a journey that talks to a bot: the stand-in for the model and a place for its profile folders. Made ONCE per process, because the journeys
 * of one persona share a stack only when their variables are equal, and the runtime folder is a new folder each time it is made.
 */
export const BOTS_ENV: Readonly<Record<string, string>> = Object.freeze({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: PERSONA_HERMES });

export const ENGINEERING = '00000000-0000-7000-8000-0000000b0001';

/** A bot needs a model to run: bind the two aliases the shipped bots ask for and wait until the workspace Brain exists. Safe to call twice. */
export async function readyForBots(stack: Stack): Promise<void> {
  await useWorkspaceBrain(stack);
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, a, 'test-model' FROM app.workspaces, unnest(ARRAY['smart', 'fast']) AS a ON CONFLICT DO NOTHING`);
}

/** Waits for the bot of a team to exist (the loader makes it from the repository a moment after the stack is up); answers the ids. */
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

/** Lets a bot ask a person before it writes a page: the grant the approvals specs use, so the stopped call can be decided in the inbox. */
export async function makePageWritesNeedApproval(stack: Stack, slug = 'coder'): Promise<void> {
  const bot = await waitForBot(stack, slug);
  await stack.sql(
    `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'pages.write', true, '{}')
     ON CONFLICT (actor_id, capability) DO UPDATE SET needs_approval = true`,
    [ENGINEERING, bot.actorId],
  );
}

/** Gives a bot the tools its shipped definition does not grant (the grants table is what the gateway checks at every call). */
export async function grantTools(stack: Stack, slug: string, tools: readonly string[], team = ENGINEERING): Promise<void> {
  const bot = await waitForBot(stack, slug, team);
  for (const tool of tools) {
    await stack.sql(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}') ON CONFLICT (actor_id, capability) DO NOTHING`,
      [team, bot.actorId, tool],
    );
  }
}

/** The id of a channel of a team by name, as the person's directory lists it. */
export async function channelId(ctx: JourneyContext, who: Persona, name: string, team = 'engineering'): Promise<string> {
  const api = await ctx.api(who);
  const dir = await api.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>(`/api/teams/${team}/channels`);
  const found = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === name);
  expect(found, `${who} sees the channel #${name}`).toBeTruthy();
  return found!.id;
}

/** Posts a message as a colleague through the API (the part of the story that happens in another window). */
export async function say(ctx: JourneyContext, who: Persona, channel: string, body: string, threadRootId: string | null = null): Promise<{ id: string }> {
  return postAsApi(await ctx.api(who), channel, body, threadRootId);
}

/**
 * KNOWN PRODUCT FINDING (reported with the journeys): the first message of a new Brain chat is followed by two `GET .../bots/<bot>/conversations/<id>/state` calls that
 * answer 404 until the conversation row exists (the rule lets that one address through whatever it answers, because the console line the browser writes has no status) (the row is made by a consumer a moment after the post). The chat recovers by itself and nothing is shown, but the page logs the
 * failure. The journeys that start a chat call this once on their window so that this race does not fail every Brain step; any other 404 still fails the step.
 */
export const CHAT_STATE_RACE: IgnoreRule = { url: /\/api\/teams\/[^/]+\/bots\/[^/]+\/conversations\/[0-9a-f-]{36}\/state$/ };

/**
 * KNOWN PRODUCT FINDING: a person who opens a thread holding a bot's reply that was made for SOMEBODY ELSE'S question (Priya reading Coder's answer to Nadia) makes the client ask
 * `GET /api/runs/<id>/origin`, which answers 404 because the run is not hers; the card stays out of sight and the thread reads fine, but the page logs the failure.
 */
export const RUN_ORIGIN_NOT_YOURS: IgnoreRule = { url: /\/api\/runs\/[0-9a-f-]{36}\/origin$/ };

/** Attaches the page monitor of the window with the two known harmless 404s allowed ({@link CHAT_STATE_RACE}, {@link RUN_ORIGIN_NOT_YOURS}). Call before the first picture of the window. */
export function allowChatStateRace(ctx: JourneyContext): void {
  monitorPage(ctx.page, [CHAT_STATE_RACE, RUN_ORIGIN_NOT_YOURS]);
}

/** The testids of screens that the shared page objects do not cover yet (they are in the web client: the harness's list, e2e/pages/testids.ts, is the lead's to extend). */
export const LOCAL = {
  welcomeCard: 'welcome-card',
  welcomeStep: 'welcome-step',
  bell: 'bell',
  bellCount: 'bell-count',
  notifications: 'notifications-popover',
  notification: 'notification',
  notificationOpen: 'notification-open',
  threadRow: 'thread-row',
  followState: 'follow-state',
  teamSwitch: 'team-switch',
} as const;

/**
 * A colleague asks Coder, in #dev, to write a page; the stand-in does what a model would (`pages.write`), the grant holds the call, and an approval appears for the people who
 * may decide. Answers the approval's id once the platform has raised it.
 */
export async function askCoderToWrite(ctx: JourneyContext, asker: Persona, path: string, words: string, onCall = false): Promise<string> {
  const dev = await channelId(ctx, asker, 'dev');
  await say(ctx, asker, dev, `@coder WRITE-PAGE ${path} ${words}`);
  let id = '';
  for (let i = 0; i < 200 && id === ''; i += 1) {
    id = (await ctx.stack.sql<{ id: string }>(`SELECT id FROM app.approvals WHERE summary LIKE $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [`%${path}%`]))[0]?.id ?? '';
    if (id === '') await new Promise((resolve) => setTimeout(resolve, 300));
  }
  expect(id, `an approval for ${path}`).not.toBe('');
  // The platform sends a bot's request to the team's leads; a team that keeps an on-call rota also lets the people on it decide (the arrangement Rafi's journeys need).
  if (onCall) await ctx.stack.sql(`UPDATE app.approvals SET approver_scope = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ roles: ['role:on-call'], people: [], leads: true })]);
  return id;
}

/** What a journey does before the first picture of a journey that has Coder ask for approval: a model for the bots, Coder's tools, a grant that holds page writes. */
export async function readyCoderToAsk(stack: Stack): Promise<void> {
  await readyForBots(stack);
  await grantTools(stack, 'coder', ['messages.search', 'messages.post', 'answer.post']);
  await makePageWritesNeedApproval(stack);
}

/**
 * The request a hand-made URL would send, from the page itself with the person's own cookies, so that the server's refusal is what the picture and the monitor see (the screens of
 * a channel that is not in the person's list show "You cannot see this channel" without asking the server at all). Answers the HTTP status.
 */
export async function askFromPage(page: import('@playwright/test').Page, method: 'GET' | 'POST', path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split('; ')
        .map((c) => c.split('='))
        .find(([k]) => k === 'manythreads_csrf' || k === '__Host-manythreads_csrf')?.[1];
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return res.status;
    },
    { method, path, body },
  );
}

/** Opens a channel's address and asks for its messages from the page: the screen says no, and so does the server (403). */
export async function openRefused(page: import('@playwright/test').Page, address: string, channelId: string): Promise<void> {
  await page.goto(address);
  await expect(page.getByTestId('no-access')).toBeVisible();
  expect(await askFromPage(page, 'GET', `/api/channels/${channelId}/messages`), 'the server refuses the same channel').toBe(403);
}

/**
 * A team the person is not on: its address shows "You do not have access" (the team is missing from her list, so the page asks nothing), and the same team's API answers 403.
 * `api` is any route of the team that needs the team to be visible.
 */
export async function openTeamRefused(page: import('@playwright/test').Page, address: string, api: string): Promise<void> {
  await page.goto(address);
  await expect(page.getByRole('heading', { name: /You do not have access/ })).toBeVisible();
  expect(await askFromPage(page, 'GET', api), 'the server refuses the same team').toBe(403);
}
