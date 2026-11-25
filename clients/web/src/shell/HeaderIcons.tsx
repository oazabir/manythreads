import { BookmarksLink } from '../bookmarks/BookmarksLink';
import { Bell } from '../notifications/Bell';

/** The person's own tools at the top right, wherever a header band is drawn (the shell's, the Threads inbox's thread band): Bookmarks, then the bell. */
export function HeaderIcons() {
  return (
    <>
      <BookmarksLink />
      <Bell />
    </>
  );
}
