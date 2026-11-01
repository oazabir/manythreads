import { definePlugin } from '@manythreads/sdk';
import { registerJobs } from './jobs.ts';
import { registerRoutes } from './routes.ts';

export { vetUrl, safeFetch, SafeFetchError } from './safe-fetch.ts';
export { isPublicAddress } from './address.ts';
export { extractLinks, normalizeLink } from './links.ts';
export { linkPreviewEnabled } from './limits.ts';
export { parseHtmlMeta, parseOembed, sniffImage } from './parse.ts';

/**
 * link-preview (PLAN P14-08): for a link in a posted message the server reads the page's title, description and picture (Open Graph and oEmbed),
 * keeps a copy under the message as a card, and serves the picture itself so the browser never contacts the linked site. Every read goes through
 * one guarded fetcher (public addresses only, redirects capped, bytes and time bounded) and through the `pre_egress` chain. docs/plugins/link-preview.md.
 *
 * It subscribes to the channel message events and runs four queues: `link-preview.sync` (which links need a card), `link-preview.fetch` (one link, with no
 * database transaction open while the page is read), `link-preview.sweep` (the rules changed: remove what no longer passes) and a daily `link-preview.purge`.
 * `MANYTHREADS_LINK_PREVIEW=off` turns the whole feature off on a server (it is off under `NODE_ENV=test` unless a test says `on`). The team inbox is never read here: a dropped file is not a channel message (PLAN D6).
 */
export default definePlugin({
  manifest: {
    name: 'link-preview',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'event.emit', 'job.register', 'hook.pre_egress'],
    events: { emits: ['linkpreview.settings.updated'], consumes: ['channel.message.posted', 'channel.message.edited', 'channel.message.deleted'] },
    // messages and channels (and app.channel_audience) are the channels plugin's; the egress chain must exist before a read is judged by it
    dependsOn: ['channels', 'guardrails-egress', 'guardrails-dlp'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerJobs(ctx);
  },
});
