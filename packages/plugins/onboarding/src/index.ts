import { definePlugin } from '@manythreads/sdk';
import { registerRoutes } from './routes.ts';

/**
 * onboarding: the first admin's setup checklist (PLAN P10-01). It keeps only what a person decided or did (the first goal was sent to Brain, an
 * optional step was set aside, sign-in is password only, the checklist was put away); everything else on the checklist is read from the plugin that
 * owns it. docs/plugins/onboarding.md.
 */
export default definePlugin({
  manifest: {
    name: 'onboarding',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    extends: ['event.emit'],
    events: { emits: ['onboarding.step.marked', 'onboarding.goal.launched', 'onboarding.checklist.dismissed'], consumes: [] },
  },
  register(ctx) {
    registerRoutes(ctx);
  },
});
