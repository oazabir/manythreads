import { definePlugin } from '@manythreads/sdk';

/**
 * Surfaces (PLAN P9-01): screens a bot draws in OpenUI Lang, and the history of what happened to each. This first step holds only the tables and their
 * row-level security (migrations/0001_surfaces.sql); the tools a bot calls to draw (`surface.render`, `surface.update`, `surface.event`, P9-04), data binding
 * (P9-06) and the export to pages (P9-09) come next. docs/plugins/surfaces.md.
 */
export default definePlugin({
  manifest: {
    name: 'surfaces',
    version: '0.1.0',
    kind: 'server',
    extends: [],
    events: { emits: [], consumes: [] },
    // channels: a surface belongs to a channel and is read through app.visible_channel_ids; bots: the bot and its run are foreign keys.
    dependsOn: ['channels', 'bots'],
    migrations: 'migrations',
  },
  register() {
    // No routes or tools yet (P9-04).
  },
});
