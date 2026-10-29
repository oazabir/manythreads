import { definePlugin } from '@manythreads/sdk';
import { registerCallRoute } from './routes-call.ts';
import { registerManageRoutes } from './routes-manage.ts';

export { adapt, parseBody } from './adapters/index.ts';
export { createWindowLimiter } from './limiter.ts';
export { hashWebhookSecret, secretMatches, signatureMatches } from './secrets.ts';

/**
 * webhooks: incoming webhooks for channels (PLAN P14-14). A lead or a workspace admin makes a secret address for a channel; a CI job, GitHub, GitLab, an
 * alert manager or a script that calls it posts a message there, written as the webhook (its own author, never a person). Payload readers turn what the
 * sender posts into Markdown; the secret is kept only as a hash; rotating and revoking turn an address off at once. docs/plugins/webhooks.md.
 */
export default definePlugin({
  manifest: {
    name: 'webhooks',
    version: '0.1.0',
    kind: 'server',
    // `secret.seal`: the optional signing secret (what GitHub signs its calls with) has to be readable to check a signature, so it is sealed.
    extends: ['event.emit', 'secret.seal'],
    events: {
      emits: ['webhooks.hook.created', 'webhooks.hook.rotated', 'webhooks.hook.revoked', 'webhooks.hook.signing_changed', 'webhooks.hook.use_failed'],
      consumes: [],
    },
    // channels: app.channels and the message door; bots: app.message_authors is replaced on top of bots 0013; teams: app.teams.
    dependsOn: ['channels', 'bots', 'teams'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerManageRoutes(ctx);
    registerCallRoute(ctx);
  },
});
