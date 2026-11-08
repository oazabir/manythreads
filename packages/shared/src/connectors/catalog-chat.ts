import type { ConnectorEntry } from './catalog.ts';
import { planned, trig } from './catalog-helpers.ts';

// The catalog entries of the chat connectors (PLAN Bundle D, P16-09): Slack, Telegram, WhatsApp Business and Microsoft Teams. Owned by the package that builds them
// (WP-B), which flips the statuses and services here and nowhere else. All four are built (P16-09).

const built = { status: 'available', reason: null, phase: 'P16-09' } as const;

export const CHAT_PLANNED_ENTRIES: ConnectorEntry[] = [
  planned({
    id: 'slack',
    label: 'Slack',
    provider: 'Slack',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Slack channel, and a way to reach your own assistant from Slack. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...built,
  }),
  planned({
    id: 'telegram',
    label: 'Telegram',
    provider: 'Telegram',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Telegram chat, and a way to reach your own assistant from your phone. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...built,
  }),
  planned({
    id: 'whatsapp',
    label: 'WhatsApp Business',
    provider: 'Meta',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and WhatsApp, and a way to reach your own assistant from your phone. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...built,
  }),
  planned({
    id: 'teams',
    label: 'Microsoft Teams',
    provider: 'Microsoft',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Teams channel, and a way to reach your own assistant from Teams. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...built,
  }),
];
