import { createInboxDropper } from './dropper.ts';
import { definePlugin } from '@manythreads/sdk';
import { registerActions } from './actions.ts';
import { inboxDropFor, inboxRead } from './capability.ts';
import { registerDelivered } from './delivered.ts';
import { registerEmailDoor } from './email-door.ts';
import { registerJobs } from './jobs.ts';
import { registerPersonalInboxRoutes } from './personal-routes.ts';
import { registerRoutes } from './routes.ts';

/**
 * memory-inbox: a team's inbox for its memory (PLAN P8-14 to P8-17). Anyone on the team drops a file, a note or a chat message into it; the platform checks
 * what may come in, reads it into text, asks the team's Archivist (when there is one) to turn it into memory concepts, checks them, and files them with a
 * Reference that points back at the original. docs/plugins/memory-inbox.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory-inbox',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress', 'provider.inbox.dropper'],
    events: {
      emits: ['memory.item.dropped', 'memory.item.filed', 'memory.item.held', 'memory.item.failed', 'memory.item.released', 'memory.item.discarded', 'memory.personal_item.changed'],
      consumes: ['memory.digest.delivered'],
    },
    capabilities: [
      { name: 'inbox.read', destructive: false },
      { name: 'inbox.drop', destructive: false },
    ],
    // The email door reads the workspace mailbox (app.connections, the connections plugin) and a recorded action reads the card a person made (app.tasks);
    // app.inbox_run_item() reads the run and the bot; app.memory_run_context() (memory) names the run's team; the Reference and concepts go through the repo writer;
    // the original goes to blob storage; messages are read for Send to memory. A person's own inbox files into app.memory_personal_put (memory).
    dependsOn: ['teams', 'channels', 'bots', 'files', 'memory', 'repo-git', 'tasks', 'connections'],
  },
  register(ctx) {
    ctx.providers.register('inbox.dropper', createInboxDropper(ctx));
    ctx.capabilities.register('inbox.read', inboxRead);
    ctx.capabilities.register('inbox.drop', inboxDropFor(ctx));
    registerRoutes(ctx);
    registerPersonalInboxRoutes(ctx);
    registerEmailDoor(ctx);
    registerDelivered(ctx);
    registerActions(ctx);
    registerJobs(ctx);
  },
});
