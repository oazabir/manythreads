import type { BookmarkTarget, FileId, TeamId } from '@manythreads/shared';
import type { FileRow } from '../screens/files/model';

/*
 * What a row of the Files screen is as a bookmark (P36-08 step 3): a file of a team's repository by its team and path (`repo_file`), an attachment or a
 * Personal file by its id (`file`). A folder is not bookmarked, nor a file seen during an admin's audited look into someone's space (it is not the admin's
 * to keep), nor a row whose store gave no id. Pure, so the rule is tested without a screen.
 */
export function fileBookmarkTarget(row: Pick<FileRow, 'kind' | 'store' | 'path' | 'fileId' | 'readOnlyReason'>, teamId: string | null): BookmarkTarget | null {
  if (row.kind !== 'file' || row.readOnlyReason === 'admin_view') return null;
  if (row.store === 'git') return teamId ? { kind: 'repo_file', teamId: teamId as TeamId, path: row.path } : null;
  return row.fileId ? { kind: 'file', fileId: row.fileId as FileId } : null;
}
