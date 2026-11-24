import type { BookmarksProvider } from '@manythreads/sdk';
import { SAVED_BOOKMARKS_MAX } from '@manythreads/shared';

/** `provider.bookmarks`: the threads the transaction's person bookmarked. Row-level security keeps it to their own rows; a bot has none. */
export function createBookmarksProvider(): BookmarksProvider {
  return {
    id: 'bookmarks',
    async threadRootIds(tx) {
      const res = await tx.query<{ root: string }>(
        `SELECT b.thread_root_id AS root FROM app.bookmarks b WHERE b.person_id = app.person_id() AND b.kind = 'thread' ORDER BY b.id DESC LIMIT $1`,
        [SAVED_BOOKMARKS_MAX],
      );
      return res.rows.map((r) => r.root);
    },
  };
}
