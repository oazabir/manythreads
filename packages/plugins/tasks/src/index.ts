import { definePlugin } from '@manythreads/sdk';
import { registerCapabilities } from './capabilities.ts';
import { registerApprovalSubscriber, registerNotWokenSubscriber } from './events.ts';
import { registerJobs } from './jobs.ts';
import { registerRoutes } from './routes.ts';

export { CLAIM_SWEEP_QUEUE } from './jobs.ts';
export { TASK_SELECT, toTask, type TaskRow } from './rows.ts';

/**
 * tasks: the task substrate and its board API (PLAN P6-01 … P6-05; SPEC §8). One card has one owner at a time (a live claim per card), a
 * `code` card cannot be done without the commit that was tested, a handover is atomic and bounded, and a strict handover or a protected
 * deploy waits in the Approvals inbox. The doors are SQL functions owned by the system role; the routes and the `tasks.*` tools call them.
 * docs/plugins/tasks.md has the rules.
 */
export default definePlugin({
  manifest: {
    name: 'tasks',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register', 'secret.seal'],
    // Not destructive: every one changes a card's own state, and `destructive` here means "can never be granted to a bot" (files.delete).
    // What a destructive tool would mean elsewhere — a deploy — is bounded by the environment's approval, not by the grant door.
    capabilities: [
      { name: 'tasks.read', destructive: false },
      { name: 'tasks.create', destructive: false },
      { name: 'tasks.claim', destructive: false },
      { name: 'tasks.complete', destructive: false },
      { name: 'tasks.handoff', destructive: false },
      { name: 'tasks.private_note', destructive: false },
      { name: 'tasks.deploy', destructive: false },
    ],
    events: {
      emits: ['tasks.task.created', 'tasks.task.updated', 'tasks.task.claimed', 'tasks.task.completed', 'tasks.task.handed_off'],
      consumes: ['approvals.approval.decided', 'runtime.task.not_woken'],
    },
    dependsOn: ['approvals'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerCapabilities(ctx);
    registerJobs(ctx);
    registerApprovalSubscriber(ctx);
    registerNotWokenSubscriber(ctx);
  },
});
