import { createLockout, definePlugin } from '@manythreads/sdk';
import { PASSWORD_ACCOUNT_LOCK, PASSWORD_ADDRESS_LOCK, TOKEN_FAILURE_LOCK, CHANGE_PASSWORD_LOCK } from '@manythreads/shared';
import { AUDIT_EVENTS } from './audit.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerBootstrap } from './routes/bootstrap.ts';
import { registerResetRoutes } from './routes/reset.ts';
import { registerSessionRoutes } from './routes/session.ts';
import { registerSignIn } from './routes/sign-in.ts';

/**
 * Username and password sign-in (spec section 4): the password form, sessions, password reset and email verification
 * by mailed link, and the one-time first-admin bootstrap link. The session cookie itself is the server's session
 * service (packages/server/src/session); this plugin decides who may have one.
 */
export default definePlugin({
  manifest: {
    name: 'identity-password',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.identity', 'event.emit'],
    events: { emits: [...AUDIT_EVENTS], consumes: [] },
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.providers.register('identity', { id: 'password' });
    const now = ctx.runtime.now;
    // Per replica, in memory (PLAN D3). The numbers are listed in docs/deploy/rate-limits.md.
    const address = createLockout({ now, ...PASSWORD_ADDRESS_LOCK });
    const account = createLockout({ now, ...PASSWORD_ACCOUNT_LOCK });
    const tokens = createLockout({ now, ...TOKEN_FAILURE_LOCK });
    registerSignIn(ctx, { address, account });
    registerSessionRoutes(ctx);
    registerResetRoutes(ctx, { tokens, account });
    registerAccountRoutes(ctx, createLockout({ now, ...CHANGE_PASSWORD_LOCK }));
    registerBootstrap(ctx, tokens);
  },
});
