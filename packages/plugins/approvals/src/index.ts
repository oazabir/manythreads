import { definePlugin } from '@manythreads/sdk';
import { createApprovalProvider } from './provider.ts';
import { registerResumeJob } from './resume.ts';
import { registerRoutes } from './routes.ts';

export { createApprovalProvider } from './provider.ts';
export { RESUME_QUEUE } from './resume.ts';
export { APPROVAL_SELECT, toApproval, type ApprovalRow } from './rows.ts';

/**
 * approvals: the Approvals inbox (SPEC §7.3, PLAN P5-20). One handler — the `approvals` provider — for everything that waits for a person, whichever
 * of the four sources set it (an Environment with `protected: true`, `dispatch: strict`, the DLP `require_approval` outcome, the per-grant
 * `needsApproval` flag); the routes the inbox and the in-thread card read; and the job that re-runs an approved tool call as its bot.
 * docs/plugins/approvals.md has the rules (the requester never decides their own, who the approvers are, what approving does).
 */
export default definePlugin({
  manifest: {
    name: 'approvals',
    version: '0.1.0',
    kind: 'server',
    // `tool.invoke`: an approved tool call is re-run as the bot, in a run of its own (the same door the MCP gateway uses).
    extends: ['event.emit', 'job.register', 'provider.approvals', 'tool.invoke'],
    events: {
      emits: ['approvals.approval.requested', 'approvals.approval.decided', 'approvals.approval.resumed'],
      consumes: [],
    },
    // approvals reference bots, bot_runs and channels
    dependsOn: ['bots', 'channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.providers.register('approvals', createApprovalProvider(ctx));
    registerRoutes(ctx);
    registerResumeJob(ctx);
  },
});
