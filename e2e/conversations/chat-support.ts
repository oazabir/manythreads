import { fileURLToPath } from 'node:url';
import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { startStack } from '../fixtures/stack.ts';
import { PHONE, openOn, type StackApi } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';
import { brainMd, conversationStackEnv, useWorkspaceBrain } from './support.ts';

/*
 * Helpers of the Chat screen specs (PLAN P20-16, P20-T4): /t/:team/chat?bot=<slug>&c=<threadRootId>. The stack is the one of the conversation specs
 * with the stand-in of ./fake-hermes-chat.mjs (a SLOW and a STREAM prompt, and an echo whose tag differs every time, so variants can be told apart),
 * and a Brain whose menu has three models: Smart and Fast are bound to a model, Code is not (greyed).
 */

const FAKE_CHAT = fileURLToPath(new URL('./fake-hermes-chat.mjs', import.meta.url));

export const CHAT_PROMPTS = ['What is blocking the release?', 'Where are the 2.4 release notes?'] as const;
export const BOT = '/api/teams/engineering/bots/brain';
export const CHAT_URL = '/t/engineering/chat?bot=brain';

/** The stack environment: the conversation specs' one, answered by the Chat stand-in. */
export const chatStackEnv = (): Record<string, string> => ({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: FAKE_CHAT });

/** Brain with three models on its menu (the first is the default). */
export const chatBrainMd = (): string => brainMd(CHAT_PROMPTS).replace('aliases: [smart]', 'aliases: [smart, fast, code]');

/** A stack with the chat stand-in, the workspace Brain given the spec's definition (slug `brain`) and Smart and Fast bound to a model; Code is left unbound on purpose. */
export async function startChatStack(): Promise<{ stack: Stack; botId: string }> {
  const stack = await startStack(chatStackEnv());
  const { botId } = await useWorkspaceBrain(stack, chatBrainMd());
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, a, 'test-model' FROM app.workspaces, unnest(ARRAY['smart', 'fast']) AS a ON CONFLICT DO NOTHING`);
  await stack.sql(`DELETE FROM app.llm_aliases WHERE alias = 'code'`);
  return { stack, botId };
}

export async function openChatScreen(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey,
  mobile: boolean,
  path: string = CHAT_URL,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { page, context } = await openOn(browser, playwright, stack, who, path, mobile ? { viewport: PHONE, mobile: true } : {});
  return { page, close: () => context.close() };
}

// ---- the API, for what a spec sets up or checks without the screen ------------------------------------------------------------------------------

export interface Sent {
  messageId: string;
  channelId: string;
}
export interface TurnState {
  turnMessageId: string;
  variants: Array<{ messageId: string; variantNo: number; chosen: boolean; modelAlias: string | null; stopped: boolean; runId: string | null }>;
}
export interface ThreadState {
  title: string;
  pinned: boolean;
  modelAlias: string | null;
  turns: TurnState[];
  liveRunId: string | null;
}

/** A message into the person's conversation with Brain (`root` null starts a new one). */
export async function sendChat(api: StackApi, body: string, root: string | null = null, modelAlias?: string): Promise<Sent> {
  return api.post<Sent>(`${BOT}/conversations/send`, { body, threadRootId: root, attachments: [], ...(modelAlias ? { modelAlias } : {}) });
}

/** The state of one conversation; the index may be a moment behind the send, so a 404 right after it is retried. */
export async function stateOf(api: StackApi, root: string): Promise<ThreadState> {
  let last = 0;
  for (let i = 0; i < 60; i += 1) {
    const res = await api.ctx.get(`${BOT}/conversations/${root}/state`);
    last = res.status();
    if (last === 200) return (await res.json()) as ThreadState;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`state of ${root}: ${String(last)}`);
}

/** Waits until the conversation has `turns` turns answered with `variants` answers on the last one and no run is writing. */
export async function waitAnswered(api: StackApi, root: string, variants = 1, turns = 1): Promise<ThreadState> {
  let state: ThreadState | null = null;
  await expect
    .poll(
      async () => {
        const res = await api.ctx.get(`${BOT}/conversations/${root}/state`);
        if (res.status() !== 200) return false;
        state = (await res.json()) as ThreadState;
        return state.turns.length >= turns && (state.turns[turns - 1]?.variants.length ?? 0) >= variants && state.liveRunId === null;
      },
      { timeout: 60_000, message: 'the answer to arrive' },
    )
    .toBe(true);
  return state as unknown as ThreadState;
}

/** A request the StackApi helper does not carry (PATCH, DELETE, PUT): its status and body. */
export async function call(api: StackApi, method: 'PATCH' | 'DELETE' | 'PUT' | 'POST' | 'GET', path: string, data?: unknown): Promise<{ status: number; text: string }> {
  const res = await api.ctx.fetch(path, { method, ...(data !== undefined ? { data } : {}), headers: await api.headers() });
  return { status: res.status(), text: await res.text() };
}

/** The person's chats, as the rail lists them. */
export async function listChats(api: StackApi): Promise<Array<{ threadRootId: string; title: string; pinned: boolean }>> {
  const res = await api.get<{ items: Array<{ threadRootId: string; title: string; pinned: boolean }> }>(`${BOT}/conversations?limit=50`);
  return res.items;
}

/** Writes the message in the box of the main column and sends it with Enter. */
export async function typeAndSend(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** The rail row of a chat by the words in its title. */
export const rowOf = (page: Page, title: string) => page.getByTestId('chat-row').filter({ hasText: title });

/** The phone keeps the rail in a drawer; open it when it is closed (a no-op on a desktop, where the rail is always there). */
export async function openRail(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  const toggle = page.getByTestId('chat-rail-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('chat-rail')).toBeInViewport();
}
