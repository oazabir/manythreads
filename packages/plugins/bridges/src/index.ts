import { definePlugin } from '@manythreads/sdk';
import { registerDm } from './dm.ts';
import { registerIdentity } from './identity.ts';
import { registerInbound } from './inbound.ts';
import { registerOutbound } from './outbound.ts';
import { registerAdminRoutes } from './routes-admin.ts';
import { registerChannelRoutes } from './routes-channel.ts';
import { registerMeRoutes } from './routes-me.ts';

export type { BridgeAccountRef, BridgeAdapter, BridgeRequest, BridgeVerifyResult, InboundChat, InboundMessage } from './adapter.ts';
export { BRIDGE_ADAPTERS } from './adapters/index.ts';

/**
 * bridges: chat apps (Telegram, WhatsApp, Slack, Teams) joined to the workspace (PLAN Bundle D, P16-09). An admin connects one account per service; a person proves a chat user is theirs with
 * a code, after which their words in a direct chat with the bot, or in a public channel joined to an outside chat, are posted as them ("via Telegram"); what the channel says goes back. Only
 * linked people are heard. Credentials are sealed; the doors are public and believe only a valid signature. docs/plugins/bridges.md.
 */
export default definePlugin({
  manifest: {
    name: 'bridges',
    version: '0.1.0',
    kind: 'server',
    // `secret.seal`: a bot token or a signing secret has to be readable to call the service, so it is sealed. `event.subscribe` + `job.register`: a posted message queues an outbound send.
    extends: ['event.emit', 'event.subscribe', 'job.register', 'secret.seal'],
    events: {
      emits: [
        'bridges.account.changed',
        'bridges.channel.linked',
        'bridges.channel.unlinked',
        'bridges.identity.linked',
        'bridges.identity.unlinked',
        'bridges.message.refused',
      ],
      // channel.message.posted: a message of a linked channel or direct chat is sent out. channel.channel.archived: its links end. workspace.member.status_changed: a leaving person's links end.
      consumes: ['channel.message.posted', 'channel.channel.archived', 'workspace.member.status_changed'],
    },
    // teams: who leads a team; channels: the message door and what a person may read; bots: the bot a direct chat talks to; direct-messages: the DM channel it opens;
    // the egress chain and the DLP check judge what leaves before it is sent.
    dependsOn: ['teams', 'channels', 'bots', 'direct-messages', 'guardrails-egress', 'guardrails-dlp'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerAdminRoutes(ctx);
    registerMeRoutes(ctx);
    registerChannelRoutes(ctx);
    registerInbound(ctx);
    registerOutbound(ctx);
    registerIdentity(ctx);
    registerDm(ctx);
  },
});
