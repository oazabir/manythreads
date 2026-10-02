import { definePlugin } from '@manythreads/sdk';
import { SearchQuery, SearchResponse, searchRoute } from '@manythreads/shared';
import { z } from 'zod';
import { search, searchFiles, searchMessages, normalizeQuery } from './service.ts';

export { search, searchFiles, searchMessages, searchThreads, normalizeQuery } from './service.ts';

/** What a bot or the Brain passes to `messages.search` / `files.search` (the same fields as the HTTP query, without the scope). */
const CapabilityInput = z.object({
  query: z.string().trim().min(2).max(200),
  teamId: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

/**
 * Search: `GET /api/search` and the capabilities `messages.search` and `files.search` (SPEC section 12, PLAN P3-10). Trigram word
 * similarity over messages, thread titles and file names, filtered by the read policies of the tables, newest first among equals.
 */
export default definePlugin({
  manifest: {
    name: 'search',
    version: '0.1.0',
    kind: 'server',
    extends: [],
    capabilities: [
      { name: 'messages.search', destructive: false },
      { name: 'files.search', destructive: false },
    ],
    // The functions it calls read channels, messages, threads and files.
    dependsOn: ['channels', 'files'],
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.http.route({
      ...searchRoute,
      schema: { query: SearchQuery, response: SearchResponse },
      rateLimit: { limit: 120, windowMs: 60_000 },
      handler: async (req, tx) => ({ body: SearchResponse.parse(await search(tx, SearchQuery.parse(req.query))) }),
    });
    // Capabilities run as the asking actor (a bot's transaction is its asker's visibility), so the same policies decide what comes back.
    ctx.capabilities.register('messages.search', async (input, tx) => {
      const i = CapabilityInput.parse(input);
      return { hits: await searchMessages(tx, normalizeQuery(i.query), i.teamId ?? null, i.limit) };
    });
    ctx.capabilities.register('files.search', async (input, tx) => {
      const i = CapabilityInput.parse(input);
      return { hits: await searchFiles(tx, normalizeQuery(i.query), i.teamId ?? null, i.limit) };
    });
  },
});
