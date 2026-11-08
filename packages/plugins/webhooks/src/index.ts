import { definePlugin } from '@manythreads/sdk';
import { registerOutgoing } from './outgoing.ts';
import { registerRunOrigin } from './origin.ts';
import { registerProviderDoor } from './provider-door.ts';
import { registerCallRoute } from './routes-call.ts';
import { registerManageRoutes } from './routes-manage.ts';
import { registerOutgoingRoutes } from './routes-outgoing.ts';
import { registerProviderRoutes } from './routes-provider.ts';
import { registerTokenRoutes } from './routes-tokens.ts';
import { registerSlackApi } from './slack-api.ts';

export { adapt, parseBody } from './adapters/index.ts';
export { createWindowLimiter } from './limiter.ts';
export { hashWebhookSecret, outgoingSignature, secretMatches, signatureMatches } from './secrets.ts';
export { OUTGOING_DEPS, classifyFailure, matchTrigger, parseReply } from './outgoing.ts';
export { isTs, messageIdToTs, tsToIdRange } from './ts.ts';

/**
 * webhooks: integrations for channels (PLAN P14-14). A lead or a workspace admin makes, for a channel, any of three things, each written as its own author
 * (never a person) with the Webhook mark: an **incoming webhook** (a secret address a CI job, GitHub, GitLab, an alert manager or a script posts to), an
 * **API token** (a Slack-shaped web API: `chat.postMessage`, `chat.update`, `reactions.add` / `.remove`, `auth.test`) and an **outgoing webhook** (a trigger word
 * in the channel sends the message to an address and posts the answer back). Payload readers turn what a sender posts into Markdown; secrets are kept only as
 * hashes (or sealed, for a signing secret); rotating and revoking turn an integration off at once. docs/plugins/webhooks.md.
 */
export default definePlugin({
  manifest: {
    name: 'webhooks',
    version: '0.1.0',
    kind: 'server',
    // `secret.seal`: a signing secret (what GitHub signs its calls with, what an outgoing webhook signs with) has to be readable to compute a signature, so it
    // is sealed. `event.subscribe` + `job.register`: an outgoing webhook is a job queued by a posted message. `hook.pre_egress`: what leaves is judged first.
    extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress', 'secret.seal'],
    events: {
      emits: [
        'webhooks.hook.created',
        'webhooks.hook.rotated',
        'webhooks.hook.revoked',
        'webhooks.hook.signing_changed',
        'webhooks.hook.use_failed',
        'webhooks.token.changed',
        'webhooks.token.used',
        'webhooks.outgoing.changed',
        'webhooks.outgoing.delivered',
        // Bundle D (docs/plugins/webhooks.md "Bundle D contracts"): endpoints a work app calls, and what came in through them
        'webhooks.provider_endpoint.changed',
        'webhooks.provider_event.received',
        'webhooks.provider_event.refused',
      ],
      consumes: ['channel.message.posted'],
    },
    // channels: app.channels and the message door; bots: app.message_authors is replaced on top of bots 0013; teams: app.teams; the egress chain must exist before
    // a delivery is judged by it (like link-preview).
    dependsOn: ['channels', 'bots', 'teams', 'guardrails-egress', 'guardrails-dlp'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerManageRoutes(ctx);
    registerCallRoute(ctx);
    registerTokenRoutes(ctx);
    registerOutgoingRoutes(ctx);
    registerSlackApi(ctx);
    registerOutgoing(ctx);
    // Bundle D: one call per module, each a stub until its work package fills it in.
    registerProviderRoutes(ctx);
    registerProviderDoor(ctx);
    registerRunOrigin(ctx);
  },
});
