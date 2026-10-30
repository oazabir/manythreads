import { definePlugin } from '@manythreads/sdk';
import { registerAnswerShareRoutes } from './answer-share.ts';
import { registerIndexer } from './indexer.ts';
import { registerRehearsalRoutes } from './rehearsal.ts';
import { registerRoutes } from './routes.ts';

/**
 * conversations: talking to a bot (SPEC §6.2, PLAN P5-16). Each person has one private conversation channel per bot (kind
 * `bot_conversation`, unlisted in the sidebar; channels migration 0006 lets the bot answer in it from its own run); a message they send
 * there is the root of a thread and fires the bot's `conversation` trigger (runtime-hermes' router). This plugin owns the one door that
 * makes the channel (migration 0001), the index of conversations with their visibility, the event that announces a new one, and the two
 * routes the conversation view reads: open, and the lists Mine · Shared · Channel mentions; and (P5-17) what a person does with an answer of their
 * own conversation: the share preview, share to a channel with masking, hand to another bot; and (P7-11) the bot page's Test action: one question
 * from a team lead or workspace admin, run as a rehearsal (the gateway holds back every write). docs/plugins/conversations.md.
 */
export default definePlugin({
  manifest: {
    name: 'conversations',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'event.emit'],
    events: {
      emits: ['conversations.conversation.started', 'channel.channel.created', 'answer.answer.shared'],
      consumes: ['channel.message.posted'],
    },
    // channels (the channel, its messages and threads), bots (the bot a conversation is with, and the runs behind Channel mentions) and answer
    // (the sharer's view of an answer and the reach of a channel: `app.answer_share_view`, migration 0003)
    dependsOn: ['channels', 'bots', 'answer'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerIndexer(ctx);
    registerRoutes(ctx);
    registerAnswerShareRoutes(ctx);
    registerRehearsalRoutes(ctx);
  },
});
