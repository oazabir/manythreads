import { definePlugin } from '@manythreads/sdk';
import { registerIndexer } from './indexer.ts';
import { registerRoutes } from './routes.ts';

/**
 * conversations: talking to a bot (SPEC §6.2, PLAN P5-16). Each person has one private conversation channel per bot (kind
 * `bot_conversation`, unlisted in the sidebar; channels migration 0006 lets the bot answer in it from its own run); a message they send
 * there is the root of a thread and fires the bot's `conversation` trigger (runtime-hermes' router). This plugin owns the one door that
 * makes the channel (migration 0001), the index of conversations with their visibility, the event that announces a new one, and the two
 * routes the conversation view reads: open, and the lists Mine · Shared · Channel mentions. docs/plugins/conversations.md.
 */
export default definePlugin({
  manifest: {
    name: 'conversations',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'event.emit'],
    events: {
      emits: ['conversations.conversation.started', 'channel.channel.created'],
      consumes: ['channel.message.posted'],
    },
    // channels (the channel, its messages and threads) and bots (the bot a conversation is with, and the runs behind Channel mentions)
    dependsOn: ['channels', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerIndexer(ctx);
    registerRoutes(ctx);
  },
});
