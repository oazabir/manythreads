import type { PluginTx, ProviderImpl } from './types.ts';

// The threads a person bookmarked, as other plugins see them (P36-08): `ctx.providers.get<BookmarksProvider>('bookmarks')`, registered by the bookmarks
// plugin (`provider.bookmarks`). The threads plugin asks it for the Threads view's Bookmarked filter, so it never reads the bookmarks table. Look it up
// when a request arrives, not in `register` (bookmarks may load after you); a server without it has no bookmarks.

export interface BookmarksProvider extends ProviderImpl {
  id: 'bookmarks';
  /** The root message ids of the threads the transaction's person bookmarked (at most 500; row-level security keeps it to their own). Empty for a bot. */
  threadRootIds(tx: PluginTx): Promise<string[]>;
}
