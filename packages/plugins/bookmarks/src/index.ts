import { definePlugin } from '@manythreads/sdk';
import { createBookmarksProvider } from './provider.ts';
import { registerBookmarkRoutes } from './routes.ts';

/**
 * Bookmarks: the threads, messages and files a person keeps to find again (P36-08, docs/plans/bookmarks.md, docs/plugins/bookmarks.md). They are the
 * person's own; nobody else sees them, an admin included. The rows hold ids and a path only; the list reads each item under the caller's own access, so
 * what they can no longer read says "No longer available". No events and no audit rows (private, no text, as Later); a change is pushed to the person's
 * own tabs only. The threads plugin reads the bookmarked threads through `provider.bookmarks` for the Threads view's Bookmarked filter.
 */
export default definePlugin({
  manifest: {
    name: 'bookmarks',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.bookmarks'],
    // The messages, threads and channels a bookmark points at belong to channels; files (and the file policies the insert policy reads) to files;
    // the teams of a repository file to teams, and the index of its repository (`repo_entries`: is the path there, how big is it) to repo-git; the name of
    // the bot of a conversation with a bot to bots.
    dependsOn: ['channels', 'files', 'teams', 'repo-git', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerBookmarkRoutes(ctx);
    ctx.providers.register('bookmarks', createBookmarksProvider());
  },
});
