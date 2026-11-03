import { definePlugin } from '@manythreads/sdk';
import { registerJobs, registerSettle } from './jobs.ts';
import { registerShareLoader } from './loader.ts';
import { registerRoutes } from './routes.ts';

/**
 * memory-share: a team's outgoing memory shares (PLAN P8-22, P8-23; SPEC §12.3). A lead or workspace admin writes `routines/shares/<slug>.yaml`; the platform (not a
 * model) picks the concepts that may leave, builds a digest from them (a small OKF bundle), checks it, passes it through the data rules and asks a person to approve
 * it. Accepting a share on the destination side, delivery and import are later tasks. docs/plugins/memory-share.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory-share',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress'],
    events: {
      emits: ['memory.share.defined', 'memory.share.built', 'memory.share.settled'],
      consumes: ['repo.repo.committed', 'approvals.approval.decided'],
    },
    // memory_concepts (memory), the file read and the commit event (repo-git), app.approvals and its doors (approvals), team slugs (teams); guardrails-dlp is the guard that
    // answers pre_egress, and runs before this plugin builds anything.
    dependsOn: ['teams', 'repo-git', 'memory', 'approvals', 'guardrails-dlp'],
  },
  register(ctx) {
    registerShareLoader(ctx);
    registerSettle(ctx);
    registerRoutes(ctx);
    registerJobs(ctx);
  },
});
