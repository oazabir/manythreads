import { definePlugin } from '@manythreads/sdk';
import { registerProjectRoutes } from './routes.ts';

/**
 * projects: the git repositories a team works on, each tied to one of the team's channels. A bot asked in that channel is told which repository
 * it works on (runtime-hermes adds a short note to the run's prompt), and the team's Hermes pod keeps a copy of it (hermes-pods reads the table).
 * Everyone on the team reads; a team lead or a workspace admin adds, changes and removes. docs/plugins/projects.md.
 */
export default definePlugin({
  manifest: {
    name: 'projects',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    events: { emits: ['project.project.created', 'project.project.updated', 'project.project.deleted'], consumes: [] },
    migrations: 'migrations',
    dependsOn: ['teams', 'channels'],
  },
  register(ctx) {
    registerProjectRoutes(ctx);
  },
});
