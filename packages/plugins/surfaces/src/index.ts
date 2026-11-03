import { definePlugin } from '@manythreads/sdk';
import { registerRoutes } from './routes.ts';
import { readSurfaceEvents, renderSurface, updateSurface } from './tools.ts';

export { allowCall, resetCallLimits } from './limits.ts';
export { readSurfaceEvents, renderSurface, updateSurface } from './tools.ts';

/**
 * Surfaces (PLAN P9-01 to P9-04): screens a bot draws in OpenUI Lang instead of plain text, and the history of what happened to each. The bot draws and changes
 * its screens with three tools (`surface.render`, `surface.update`, `surface.event`), which the MCP gateway offers only to a bot whose BOT.md grants them; the
 * web app reads a channel's surfaces and sends back a person's click or form through two small routes. Data binding (P9-06) and the export to pages (P9-09) come
 * next. docs/plugins/surfaces.md.
 */
export default definePlugin({
  manifest: {
    name: 'surfaces',
    version: '0.2.0',
    kind: 'server',
    extends: ['event.emit'],
    // Three tools a BOT.md grants by name (or `surface.*`). None is destructive: they add and change a screen in the bot's own thread, and every change is kept.
    capabilities: [
      { name: 'surface.render', destructive: false },
      { name: 'surface.update', destructive: false },
      { name: 'surface.event', destructive: false },
    ],
    events: { emits: ['surfaces.surface.rendered', 'surfaces.surface.updated', 'surfaces.surface.event_posted'], consumes: [] },
    // channels: a surface belongs to a channel, is read through app.visible_channel_ids and announced by a message (the `messages` provider); bots: the bot and its
    // run are foreign keys, and the run says where the bot draws.
    dependsOn: ['channels', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.capabilities.register('surface.render', (input, tx) => renderSurface(ctx, tx, input));
    ctx.capabilities.register('surface.update', (input, tx) => updateSurface(ctx, tx, input));
    ctx.capabilities.register('surface.event', (input, tx) => readSurfaceEvents(ctx, tx, input));
    registerRoutes(ctx);
  },
});
