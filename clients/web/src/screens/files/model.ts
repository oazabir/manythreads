/*
 * The Files screen's own vocabulary (SPEC section 5.2). A row is a file or a folder of one tree over two stores: the team repo (git, text only)
 * and attachments (Files storage, under `channels/<name>/`). Rows of both stores have one shape, so the tree, the breadcrumb, the list and the
 * preview never ask which store a row lives in; `store` only decides what an action may do (history and restore exist for git).
 */

export type Actor = { id: string | null; name: string; kind: 'person' | 'bot' | 'system' };

export type FileRow = {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  store: 'git' | 'attachments';
  size: number | null;
  mime: string | null;
  modifiedAt: string | null;
  by: Actor | null;
  /** Where an attachment was posted ("thread", "message"); empty for a file nobody posted. */
  where: string | null;
  /** The person may read but not change it (bots/, TEAM.md for a member who does not lead the team). */
  readOnly: boolean;
  readOnlyReason: 'change_by_pull_request' | null;
  /** Another part of the product owns the content (`memory/` mirrors the team's memory bank). */
  managedBy: 'team_memory' | null;
  fileId: string | null;
  channelId: string | null;
  /** The message that posted an attachment, for "Open in thread". */
  messageId: string | null;
};

export type Listing = { path: string; rows: FileRow[] };

export type Commit = {
  sha: string;
  author: Actor | null;
  coAuthors: Actor[];
  message: string;
  committedAt: string;
  paths: string[];
};

/** The text of one path before and after a commit (null: the file did not exist, or is not text). */
export type CommitDiff = { sha: string; path: string; before: string | null; after: string | null };

export const ROOT = '';

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT);
export const joinPath = (folder: string, name: string): string => (folder === ROOT ? name : `${folder}/${name}`);
export const segments = (path: string): string[] => (path === ROOT ? [] : path.split('/'));

/** Whether `path` is inside `folder` (or is it). */
export const isUnder = (path: string, folder: string): boolean => folder === ROOT || path === folder || path.startsWith(`${folder}/`);

export const isAttachmentPath = (path: string): boolean => path.startsWith('channels/') && path.length > 'channels/'.length;
/** The folder `channels/<name>` itself or below it. */
export const channelNameOf = (path: string): string | null => {
  const m = /^channels\/([^/]+)/.exec(path);
  return m?.[1] ?? null;
};
/** A folder where uploads go: a channel's own folder, never `channels/` itself and never a git folder. */
export const acceptsUploads = (folder: string): boolean => channelNameOf(folder) !== null;

export type TypeFilter = 'all' | 'images' | 'documents' | 'code';
export type SourceFilter = 'any' | 'bots' | 'people';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);
const DOC_EXT = new Set(['pdf', 'md', 'markdown', 'csv', 'tsv', 'txt', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf']);
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'ini', 'css', 'html', 'xml', 'py', 'go', 'rs', 'sh', 'bash', 'sql', 'diff', 'patch', 'mmd', 'mermaid']);

export const extOf = (name: string): string => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

export function matchesType(row: FileRow, filter: TypeFilter): boolean {
  if (filter === 'all' || row.kind === 'folder') return true;
  const ext = extOf(row.name);
  const mime = row.mime ?? '';
  if (filter === 'images') return mime.startsWith('image/') || IMAGE_EXT.has(ext);
  if (filter === 'documents') return DOC_EXT.has(ext) || mime === 'application/pdf';
  return CODE_EXT.has(ext);
}

export function matchesSource(row: FileRow, filter: SourceFilter): boolean {
  if (filter === 'any' || row.kind === 'folder') return true;
  if (filter === 'bots') return row.by?.kind === 'bot';
  return row.by?.kind === 'person';
}

/** Folders first, then files; files newest first (`recent`) or by name. */
export function sortRows(rows: readonly FileRow[], order: 'recent' | 'name'): FileRow[] {
  const byName = (a: FileRow, b: FileRow): number => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  return [...rows].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (a.kind === 'folder' || order === 'name') return byName(a, b);
    return (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || byName(a, b);
  });
}

/** Files of a folder as the tree shows them: git files yes, a channel's attachments no (they would drown the tree). */
export const treeShows = (row: FileRow): boolean => row.kind === 'folder' || row.store === 'git';

export const READ_ONLY_COPY = 'Change by pull request';
export const GIT_TEXT_ONLY_COPY = 'This folder is stored in git, which holds text only. Upload attachments to a channel folder.';
export const MEMORY_COPY = 'Managed by team memory';

/** Names of a new file or folder: one path segment the repo accepts (no slash, no dot-only name, no control characters). */
export function nameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Give it a name.';
  if (/[/\\]/.test(name)) return 'A name cannot contain a slash. Use Move to change the folder.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot contain control characters.';
  if (name === '.' || name === '..') return 'That name is not allowed.';
  if (/[. ]$/.test(name)) return 'A name cannot end in a dot or a space.';
  if (name.toLowerCase() === '.git' || name.toLowerCase() === '.gitmodules') return 'That name is not allowed.';
  if (name.length > 255) return 'That name is too long.';
  return null;
}

/** A page (`.md`) in `pages/`: shown with the read view of a durable page. */
export const isPage = (path: string): boolean => path.startsWith('pages/') && /\.(md|markdown)$/i.test(path);
