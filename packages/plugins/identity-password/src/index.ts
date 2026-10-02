import { definePlugin } from '@manythreads/sdk';
import { AUDIT_EVENTS } from './audit.ts';
import { createLockout } from './lockout.ts';
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
    const lockout = createLockout({ now: ctx.runtime.now });
    registerSignIn(ctx, lockout);
    registerSessionRoutes(ctx);
    registerResetRoutes(ctx);
    registerAccountRoutes(ctx);
    registerBootstrap(ctx);
  },
});
