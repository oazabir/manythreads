import { definePlugin } from '@manythreads/sdk';
import { registerJobs, registerSettle } from './jobs.ts';
import { createImporter } from './import.ts';
import { registerShareLoader } from './loader.ts';
import { registerRoutes } from './routes.ts';

/**
 * memory-share: a team's memory shared with other teams (PLAN P8-22 to P8-25; SPEC §12.3). A lead or workspace admin writes `routines/shares/<slug>.yaml`; the platform (not a
 * model) picks the concepts that may leave, builds a digest from them (a small OKF bundle), checks it, passes it through the data rules and asks a person to approve it.
 * The receiving team's leads accept the share (an Approvals row) before anything is delivered, and can pause or end it; a workspace switch, "Memory sharing", stops every
 * send. An approved digest is handed to each accepting team as an inbox item (app.deliver_inbox_item), and the `inbox.importer` this plugin registers files it under
 * `memory/shared/team-<team>/`, with no model: a digest, or an OKF bundle dropped from outside, is checked whole and refused whole. docs/plugins/memory-share.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory-share',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress', 'provider.inbox.importer'],
    events: {
      emits: ['memory.share.defined', 'memory.share.built', 'memory.share.settled', 'memory.share.linked', 'memory.sharing.switched', 'memory.digest.delivered', 'memory.digest.imported'],
      consumes: ['repo.repo.committed', 'approvals.approval.decided'],
    },
    // memory_concepts (memory), the file read and the commit event (repo-git), app.approvals and its doors (approvals), team slugs (teams); guardrails-dlp is the guard that
    // answers pre_egress, and runs before this plugin builds anything; the inbox owns the table a delivery writes into and the pipeline that calls the importer.
    dependsOn: ['teams', 'repo-git', 'memory', 'approvals', 'guardrails-dlp', 'memory-inbox'],
  },
  register(ctx) {
    registerShareLoader(ctx);
    registerSettle(ctx);
    registerRoutes(ctx);
    registerJobs(ctx);
    ctx.providers.register('inbox.importer', createImporter(ctx));
  },
});
