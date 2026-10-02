import { definePlugin } from '@manythreads/sdk';
import { registerAdmin } from './admin.ts';
import { registerSignIn } from './sign-in.ts';

/**
 * OpenID Connect sign-in (spec section 4): the Google Workspace and Microsoft 365 presets and any OIDC provider.
 * Authorization code flow with PKCE (S256), server-side state and nonce, id_token verified against the provider's keys.
 * This plugin decides who may have a session; the session itself is the server's session service.
 *
 * Provider setup is a workspace-admin API (`/api/auth/oidc/providers`); the client secret is stored with `ctx.secrets`
 * (envelope encrypted) and no route ever returns it.
 */
export default definePlugin({
  manifest: {
    name: 'identity-oidc',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.identity', 'event.emit'],
    events: {
      emits: [
        'identity.provider.changed',
        'identity.oidc.signed_in',
        'identity.oidc.refused',
        'workspace.invitation.accepted',
        'team.member.added',
      ],
      consumes: [],
    },
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.providers.register('identity', { id: 'oidc' });
    registerAdmin(ctx);
    registerSignIn(ctx);
  },
});
