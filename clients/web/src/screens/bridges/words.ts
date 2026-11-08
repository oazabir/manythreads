import { isApiError } from '../../api/client';
import type { BridgeProvider, BridgeStatus } from '@manythreads/shared';

/** The plain words of the chat-app pages, kept apart from the markup so they can be read, tested and changed in one place. */

export const PROVIDER_LABEL: Record<BridgeProvider, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

/** The services built in this release, in the order a page lists them. The others are shown as coming later. */
export const BUILT_PROVIDERS: readonly BridgeProvider[] = ['telegram', 'whatsapp'];
export const LATER_PROVIDERS: readonly BridgeProvider[] = ['slack', 'teams'];

export const isBuilt = (p: BridgeProvider): boolean => BUILT_PROVIDERS.includes(p);

export const STATUS_WORDS: Record<BridgeStatus, string> = { off: 'Off', on: 'On', attention: 'Needs attention' };

export const whatItDoes = (p: BridgeProvider): string =>
  p === 'telegram'
    ? 'People link their Telegram account to talk to a bot from their phone, and a public channel can be joined to a Telegram group. Only linked people are heard.'
    : p === 'whatsapp'
      ? 'People link their WhatsApp number to talk to a bot from their phone. WhatsApp only lets the bot answer within 24 hours of the person’s last message; a later answer waits until they write again.'
      : 'Coming in a later release.';

/** The server's own sentence when it has one, else the fallback. */
export const failureWords = (e: unknown, fallback: string): string => (isApiError(e) ? e.message : e instanceof Error && e.message ? e.message : fallback);

/** `/settings/workspace/chat-apps` callback address, as the admin pastes it into the chat service's console. */
export const callbackUrl = (path: string, origin: string = typeof window === 'undefined' ? '' : window.location.origin): string => `${origin}${path}`;
