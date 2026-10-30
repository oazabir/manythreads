import { definePlugin } from '@manythreads/sdk';
import { knowledgeSearch } from './capability.ts';
import { registerRoutes } from './routes.ts';

/**
 * knowledge: a team's knowledge bases (PLAN P8-07, P8-08, P8-31..33). A base is a folder of the team's documents (manuals, runbooks, policies): each
 * is uploaded, converted to text off the request path, cut into passages and indexed; the original stays in blob storage and the converted text is a
 * Markdown file in the team repo. Bots call `knowledge.search` and cite the passages, with the document's version. docs/plugins/knowledge.md.
 */
export default definePlugin({
  manifest: {
    name: 'knowledge',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    extends: ['event.emit'],
    events: {
      emits: ['knowledge.base.created', 'knowledge.base.deleted', 'knowledge.document.added', 'knowledge.document.removed', 'knowledge.base.resynced'],
      consumes: [],
    },
    capabilities: [{ name: 'knowledge.search', destructive: false }],
    // app.knowledge_run_grant() reads the run and the bot; the converted copy goes through the repo writer; the original goes to blob storage.
    dependsOn: ['teams', 'bots', 'repo-git'],
  },
  register(ctx) {
    ctx.capabilities.register('knowledge.search', knowledgeSearch);
    registerRoutes(ctx);
  },
});
