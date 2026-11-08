import type { BridgeProvider } from '@manythreads/shared';
import type { BridgeAdapter } from '../adapter.ts';
import { slackAdapter } from './slack.ts';
import { teamsAdapter } from './teams.ts';
import { telegramAdapter } from './telegram.ts';
import { whatsappAdapter } from './whatsapp.ts';

/** One adapter per service. */
export const BRIDGE_ADAPTERS: Readonly<Record<BridgeProvider, BridgeAdapter>> = {
  telegram: telegramAdapter,
  whatsapp: whatsappAdapter,
  slack: slackAdapter,
  teams: teamsAdapter,
};
