import { expect } from '@playwright/test';
import { personas, SEED_CONNECTORS } from '@manythreads/test-utils';
import { startStack, type Stack } from '../fixtures/stack.ts';

/*
 * Helpers of the connector specs (PLAN Bundle D, P16-12). Every spec file starts a stack of its own with seed v16 (`MANYTHREADS_STACK_SEED=connectors`,
 * e2e/fixtures/stack-server.ts): seed v3 and v4, tools/fake-saas running in the stack, and packages/test-utils/src/seed-connectors.ts on top. The stand-ins are driven
 * over their control port (`stack.fakeSaas.control`): what they saw (`state`), a signed webhook from a work app, a Telegram update, a change to an account.
 *
 * Nothing here sleeps; every wait is on something the page, the control port or the database shows.
 */

export { personas, SEED_CONNECTORS };

/** What the `connectors` seed made, as the stack's ready line reports it. */
export interface Seeded {
  designChannelId: string;
  scheduledMeetingId: string;
  startsAt: string;
  zendeskEndpointId: string;
  supportChannelId: string;
  telegramAccountId: string;
  handbookBaseId: string;
  /** `provider:persona key` to the connection id. */
  connections: Record<string, string>;
}

export const seededOf = (stack: Stack): Seeded => {
  if (!stack.seeded) throw new Error('this stack was not started with MANYTHREADS_STACK_SEED=connectors');
  return stack.seeded as unknown as Seeded;
};

/** A stack with seed v16. `MANYTHREADS_STACK_MEETINGS: '1'` adds the voice-room stand-ins (a spec that opens a room needs them). */
export function connectorsStack(env: Record<string, string> = {}): Promise<Stack> {
  return startStack({ MANYTHREADS_STACK_SEED: 'connectors', ...env });
}

const control = (stack: Stack): string => {
  if (!stack.fakeSaas) throw new Error('this stack runs no tools/fake-saas');
  return stack.fakeSaas.control;
};

/** A call to the stand-ins' control port; the answer is the JSON body. */
export async function fake<T = Record<string, unknown>>(stack: Stack, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${control(stack)}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface FakeState {
  workspace: {
    consents: Array<{ provider: string; scopes: string[]; offline: boolean; hasChallenge: boolean }>;
    createdEvents: Array<{ provider: string; account: string; title: string; start: string; end: string; guests: string[] }>;
    createdEventDetails: Array<{ provider: string; account: string; eventId: string; description: string; location: string }>;
    updatedEvents: unknown[];
    deletedEvents: unknown[];
    revoked: unknown[];
  };
  telegram: { sent: Array<{ messageId: number; chatId: string; text: string }>; calls: unknown[]; webhooks: Array<{ url: string; hasSecret: boolean }> };
  webhooksSent: Array<{ provider: string; kind: string; tamper: string; statuses: number[] }>;
}

export const stateOf = (stack: Stack): Promise<FakeState> => fake<FakeState>(stack, 'GET', '/__fake/state');

export interface SentWebhook {
  responses: Array<{ status: number; body?: string }>;
}

/** The sender signs the way the app's documentation says and posts to `url` (our door); the answer lists what the door answered. */
export function sendWebhook(stack: Stack, input: { provider: string; url: string; secret: string; kind: string; tamper?: string; title?: string; deliveryId?: string; padBytes?: number; now?: string }): Promise<SentWebhook> {
  return fake<SentWebhook>(stack, 'POST', '/__fake/send-webhook', input);
}

export interface TelegramSent {
  updateId: number;
  delivered: boolean;
  queued: boolean;
  responses: Array<{ status: number | null; body: string }>;
}

/** An update from Telegram to our bridge door, through the stand-in (it signs with the secret word the server gave it). */
export function telegramSend(
  stack: Stack,
  input: { fromUserId: number; text: string; chatId?: number | string; chatType?: 'private' | 'group' | 'supergroup'; chatTitle?: string; username?: string; firstName?: string; updateId?: number; secretHeader?: 'wrong' | 'missing'; repeat?: number },
): Promise<TelegramSent> {
  return fake<TelegramSent>(stack, 'POST', '/__fake/telegram/send', input);
}

/** `value` fields only: the owner connection's rows as plain objects, for the assertions that read the database. */
export async function rows<T extends Record<string, unknown>>(stack: Stack, text: string, params: readonly unknown[] = []): Promise<T[]> {
  return stack.sql<T>(text, params);
}

/** The address of the work-app door for an endpoint. */
export const doorUrl = (stack: Stack, endpointId: string): string => `${stack.origin}/hooks/apps/${endpointId}`;

/** The address a bridge account listens on. */
export const bridgeUrl = (stack: Stack, provider: string, accountId: string): string => `${stack.origin}/hooks/bridges/${provider}/${accountId}`;

/** Local date and time as the Schedule a room dialog takes them (`YYYY-MM-DD`, `HH:MM`), for an instant. */
export function dialogDateTime(at: Date): { date: string; time: string } {
  const two = (n: number): string => String(n).padStart(2, '0');
  return { date: `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`, time: `${two(at.getHours())}:${two(at.getMinutes())}` };
}
