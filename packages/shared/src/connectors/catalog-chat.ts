import type { ConnectorEntry } from './catalog.ts';
import { planned, soon, svc, trig } from './catalog-helpers.ts';

// The catalog entries of the chat connectors (PLAN Bundle D, P16-09): Slack, Telegram, WhatsApp Business and Microsoft Teams. Owned by the package that builds them
// (WP-B), which flips the statuses and services here and nowhere else.

export const CHAT_PLANNED_ENTRIES: ConnectorEntry[] = [
  planned({
    id: 'slack',
    label: 'Slack',
    provider: 'Slack',
    categories: ['chat'],
    description: 'A two-way bridge to a Slack channel for the move-in period. Messages show who wrote them and where.',
    source: 'first_party',
    auth: 'app_install',
    heldBy: ['team'],
    services: [svc('bridge', 'Channel bridge', 'Read and post in the channels the app is added to.', ['channels:history', 'chat:write'], false)],
    tools: [],
    triggers: [trig('message_posted', 'A message is posted')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
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
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
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
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
  planned({
    id: 'teams',
    label: 'Microsoft Teams',
    provider: 'Microsoft',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Teams channel, and a way to reach your own assistant from Teams.',
    source: 'first_party',
    auth: 'app_install',
    heldBy: ['team'],
    services: [svc('bridge', 'Channel bridge', 'Read and post in the channels the app is added to.', ['ChannelMessage.Send'], false)],
    tools: [],
    triggers: [trig('message_posted', 'A message is posted')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
];
