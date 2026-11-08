import { definePlugin } from '@manythreads/sdk';
import { knowledgeSearchFor } from './capability.ts';
import { createKnowledgeDeployStep } from './deploy.ts';
import { registerConnectorRoutes } from './connector-routes.ts';
import { registerConnectorSync } from './connector-sync.ts';
import { registerJobs } from './jobs.ts';
import { registerPersonalRoutes } from './personal-routes.ts';
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
    // `provider.deploy.step`: the knowledge step of the bot page's Deploy action (P8-34), composed by the workshop plugin.
    extends: ['event.emit', 'job.register', 'hook.pre_egress', 'provider.deploy.step'],
    events: {
      emits: ['knowledge.base.created', 'knowledge.base.deleted', 'knowledge.document.added', 'knowledge.document.removed', 'knowledge.base.resynced', 'knowledge.personal_base.changed', 'knowledge.source.synced'],
      consumes: [],
    },
    capabilities: [{ name: 'knowledge.search', destructive: false }],
    // app.knowledge_run_grant() reads the run and the bot; the converted copy goes through the repo writer; the original goes to blob storage.
    dependsOn: ['teams', 'bots', 'repo-git'],
  },
  register(ctx) {
    ctx.capabilities.register('knowledge.search', knowledgeSearchFor(ctx));
    registerRoutes(ctx);
    registerPersonalRoutes(ctx);
    registerJobs(ctx);
    // Bundle D: one call per module, each a stub until its work package fills it in.
    registerConnectorRoutes(ctx);
    registerConnectorSync(ctx);
    ctx.providers.register('deploy.step', createKnowledgeDeployStep(ctx));
  },
});
