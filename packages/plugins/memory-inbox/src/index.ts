import { definePlugin } from '@manythreads/sdk';
import { inboxDropFor, inboxRead } from './capability.ts';
import { registerJobs } from './jobs.ts';
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
    extends: ['event.emit', 'job.register', 'hook.pre_egress'],
    events: {
      emits: ['memory.item.dropped', 'memory.item.filed', 'memory.item.held', 'memory.item.failed', 'memory.item.released', 'memory.item.discarded'],
      consumes: [],
    },
    capabilities: [
      { name: 'inbox.read', destructive: false },
      { name: 'inbox.drop', destructive: false },
    ],
    // app.inbox_run_item() reads the run and the bot; app.memory_run_context() (memory) names the run's team; the Reference and concepts go through the repo writer;
    // the original goes to blob storage; messages are read for Send to memory.
    dependsOn: ['teams', 'channels', 'bots', 'files', 'memory', 'repo-git'],
  },
  register(ctx) {
    ctx.capabilities.register('inbox.read', inboxRead);
    ctx.capabilities.register('inbox.drop', inboxDropFor(ctx));
    registerRoutes(ctx);
    registerJobs(ctx);
  },
});
