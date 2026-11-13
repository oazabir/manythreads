import { definePlugin } from '@manythreads/sdk';
import { registerAsk } from './ask.ts';
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
    // `tool.invoke`: an approved tool call is re-run as the bot, in a run of its own (the same door the MCP gateway uses); `approval.resume`:
    // the one call a person approved may be made without asking again (`ctx.runs.asApproved`) — no other plugin declares it.
    extends: ['event.emit', 'job.register', 'provider.approvals', 'tool.invoke', 'approval.resume'],
    events: {
      emits: ['approvals.approval.requested', 'approvals.approval.decided', 'approvals.approval.resumed'],
      consumes: [],
    },
    // approvals reference bots, bot_runs and channels
    dependsOn: ['bots', 'channels'],
    // `approvals.ask`: every bot has it with no BOT.md line (`default`): a bot that needs a person must always be able to ask one (P24-03).
    capabilities: [{ name: 'approvals.ask', destructive: false, default: true }],
    migrations: 'migrations',
  },
  register(ctx) {
    const provider = createApprovalProvider(ctx);
    ctx.providers.register('approvals', provider);
    registerAsk(ctx, provider);
    registerRoutes(ctx);
    registerResumeJob(ctx);
  },
});
