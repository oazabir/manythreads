import { isApiError } from '../../api/client';
import type { BridgeProvider, BridgeStatus } from '@manythreads/shared';

/** The plain words of the chat-app pages, kept apart from the markup so they can be read, tested and changed in one place. */

export const PROVIDER_LABEL: Record<BridgeProvider, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

/** The services a page lists, in order. A service that is not built yet would go in LATER_PROVIDERS and be shown as coming later; none is waiting now. */
export const BUILT_PROVIDERS: readonly BridgeProvider[] = ['telegram', 'whatsapp', 'slack', 'teams'];
export const LATER_PROVIDERS: readonly BridgeProvider[] = [];

export const isBuilt = (p: BridgeProvider): boolean => BUILT_PROVIDERS.includes(p);

export const STATUS_WORDS: Record<BridgeStatus, string> = { off: 'Off', on: 'On', attention: 'Needs attention' };

export const whatItDoes = (p: BridgeProvider): string =>
  p === 'telegram'
    ? 'People link their Telegram account to talk to a bot from their phone, and a public channel can be joined to a Telegram group. Only linked people are heard.'
    : p === 'whatsapp'
      ? 'People link their WhatsApp number to talk to a bot from their phone. WhatsApp only lets the bot answer within 24 hours of the person’s last message; a later answer waits until they write again.'
      : p === 'slack'
        ? 'People link their Slack account to talk to a bot by direct message, and a public channel can be joined to a Slack channel. Only linked people are heard.'
        : 'People link their Teams account to talk to a bot in a private chat, and a public channel can be joined to a Teams channel. Only linked people are heard.';

/** What the admin does in the chat service's own console, per service: the address to paste and what to turn on. Undefined for a service that needs nothing pasted. */
export const consoleSteps = (p: BridgeProvider): { label: string; note: string } | null =>
  p === 'whatsapp'
    ? { label: 'Address to give Meta', note: 'Paste it as the webhook address in the Meta console, with the verify word you chose above, and subscribe to messages.' }
    : p === 'slack'
      ? { label: 'Address to give Slack', note: 'Paste it as the Request URL under Event Subscriptions in your Slack app, then subscribe to message events for public channels and direct messages (message.channels, message.im). Slack checks the address as soon as you paste it, so turn the app on here first.' }
      : p === 'teams'
        ? { label: 'Address to give Azure', note: 'Paste it as the messaging endpoint of your Azure bot, and add the Microsoft Teams channel to the bot. Then add the bot to a team or chat in Teams.' }
        : null;

/** The one credential label that differs: what the main secret is called in the chat service. */
export const tokenLabel = (p: BridgeProvider): string => (p === 'whatsapp' ? 'Access token' : p === 'teams' ? 'Client secret' : 'Bot token');

/** The id asked for when the app is first set up, if any. */
export const appIdLabel = (p: BridgeProvider): { label: string; hint: string; numeric: boolean } | null =>
  p === 'whatsapp'
    ? { label: 'Phone number id', hint: 'From the WhatsApp section of your Meta app. It is a long number, not the phone number itself.', numeric: true }
    : p === 'teams'
      ? { label: 'Application (client) id', hint: 'The long id with dashes that Azure shows for your bot.', numeric: false }
      : null;

/** The server's own sentence when it has one, else the fallback. */
export const failureWords = (e: unknown, fallback: string): string => (isApiError(e) ? e.message : e instanceof Error && e.message ? e.message : fallback);

/** `/settings/workspace/chat-apps` callback address, as the admin pastes it into the chat service's console. */
export const callbackUrl = (path: string, origin: string = typeof window === 'undefined' ? '' : window.location.origin): string => `${origin}${path}`;
