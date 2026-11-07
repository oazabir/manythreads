/*
 * The Files screen's own vocabulary (SPEC section 5.2). A row is a file or a folder of one tree over two stores: the team repo (git, text only)
 * and attachments (Files storage, under `channels/<name>/`); a person's Personal space is a third store, `personal` (Files storage too, but the rows can
 * be renamed, moved and saved, and they keep versions). Rows of all stores have one shape, so the tree, the breadcrumb, the list and the preview never
 * ask which store a row lives in; `store` only decides what an action may do (history and restore exist for git and for personal).
 */

export type Actor = { id: string | null; name: string; kind: 'person' | 'bot' | 'system'; /** The picture they chose (`preset:<id>` or `photo:<hash>`). */ avatar?: string | null; personId?: string };

export type ReadOnlyReason = 'change_by_pull_request' | 'attachment' | 'no_write_access' | 'admin_view';

/** Who keeps a folder's content besides people: the team's memory bank (`memory/`) or a person's own memory (the `Memory` folder of Personal). */
export type ManagedBy = 'team_memory' | 'personal_memory';

export type FileRow = {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  store: 'git' | 'attachments' | 'personal';
  size: number | null;
  mime: string | null;
  modifiedAt: string | null;
  by: Actor | null;
  /** Where an attachment came from ("# release-eng"); null for a file of the repo. */
  where: string | null;
  /** The person cannot change it in place (bots/, TEAM.md for a member who does not lead the team; an attachment never changes in place). */
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /** Another part of the product owns the content (`memory/` mirrors the team's memory bank). */
  managedBy: ManagedBy | null;
  fileId: string | null;
  channelId: string | null;
  /** Repo files: the blob that was listed, sent back as `baseBlobSha` when saving. */
  blobSha: string | null;
  /** Where the bytes are, usable as `<img src>`; null for a folder. */
  contentUrl: string | null;
};

/** What is true of the folder being listed. */
export type FolderInfo = {
  path: string;
  store: 'git' | 'attachments' | 'personal';
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
  managedBy: ManagedBy | null;
  /** The channel behind `channels/<name>`; null elsewhere. */
  channelId: string | null;
};

export type Listing = { path: string; folder: FolderInfo; rows: FileRow[]; truncated: boolean };

export type Commit = {
  sha: string;
  parentSha: string | null;
  author: Actor | null;
  coAuthors: Actor[];
  subject: string;
  message: string;
  committedAt: string;
  /** What the commit did to the file whose history this is. */
  change: 'added' | 'modified' | 'deleted' | null;
};

export type DiffLine = { type: 'context' | 'add' | 'del'; text: string; oldLine: number | null; newLine: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
/** The change one commit made to one file, as unified hunks. */
export type FileDiff = {
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated: boolean;
};

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

/** Text a viewer can edit and a line diff can compare (by type, else by extension). */
export function isTextual(row: Pick<FileRow, 'name' | 'mime'>): boolean {
  const mime = row.mime ?? '';
  if (mime.startsWith('text/') || /^application\/(json|xml|yaml|x-yaml|toml)/.test(mime)) return true;
  const ext = extOf(row.name);
  return ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'csv' || ext === 'tsv' || CODE_EXT.has(ext);
}

/** Bytes in the unit a person reads: `4.2 GB`, `310 MB`, `12 KB`. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(bytes < 10_737_418_240 ? 1 : 0)} GB`;
}

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

/** Files of a folder as the tree shows them: git files and Personal files yes, a channel's attachments no (they would drown the tree). */
export const treeShows = (row: FileRow): boolean => row.kind === 'folder' || row.store !== 'attachments';

// ---- sorting (the list's headers) ----

export type SortKey = 'name' | 'where' | 'by' | 'modified' | 'size';
export type SortDir = 'asc' | 'desc';
export type Sort = { key: SortKey; dir: SortDir };
export const DEFAULT_SORT: Sort = { key: 'modified', dir: 'desc' };
export const SORT_LABELS: Readonly<Record<SortKey, string>> = { name: 'Name', where: 'Where', by: 'By', modified: 'When', size: 'Size' };
/** What a column sorts first: text columns A to Z, "when" and "size" newest and largest first. */
export const firstDir = (key: SortKey): SortDir => (key === 'modified' || key === 'size' ? 'desc' : 'asc');

/** Folders stay first whatever the column; within each group the column decides (a missing value sorts last), then the name. */
export function sortRowsBy(rows: readonly FileRow[], sort: Sort, whereOf: (row: FileRow) => string = (r) => r.where ?? ''): FileRow[] {
  const byName = (a: FileRow, b: FileRow): number => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  const sign = sort.dir === 'asc' ? 1 : -1;
  const text = (a: string | null, b: string | null): number => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return sign * a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  };
  const num = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return sign * (a - b);
  };
  return [...rows].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let c = 0;
    if (sort.key === 'name') c = sign * byName(a, b);
    else if (sort.key === 'where') c = text(whereOf(a), whereOf(b));
    else if (sort.key === 'by') c = text(a.by?.name ?? null, b.by?.name ?? null);
    else if (sort.key === 'modified') c = a.modifiedAt && b.modifiedAt ? sign * (a.modifiedAt < b.modifiedAt ? -1 : a.modifiedAt > b.modifiedAt ? 1 : 0) : a.modifiedAt ? -1 : b.modifiedAt ? 1 : 0;
    else c = num(a.size, b.size);
    return c || byName(a, b);
  });
}

/** The key of a row in the selection: the file id when it has one, else its path. */
export const rowKey = (row: FileRow): string => row.fileId ?? row.path;

/**
 * The team's inbox, drawn as a folder at the top of the tree (PLAN P8-21). It is not in the repo: its items wait in storage until the platform files them
 * into `memory/`. Opening the row opens the Memory screen's Inbox tab.
 */
export const INBOX_FOLDER = 'inbox';
export const inboxRow = (): FileRow => ({
  path: INBOX_FOLDER, name: INBOX_FOLDER, kind: 'folder', store: 'git', size: null, mime: null, modifiedAt: null, by: null, where: 'Memory inbox', readOnly: true, readOnlyReason: null,
  managedBy: null, fileId: null, channelId: null, blobSha: null, contentUrl: null,
});

export const READ_ONLY_COPY = 'Change by proposal';
export const GIT_TEXT_ONLY_COPY = 'This folder is stored in git, which holds text only. Upload attachments to a channel folder.';
export const MEMORY_COPY = 'OKF memory bundle';

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

/** A folder is an embedded app when it holds `index.html` and no `index.md` (SPEC section 5.2). */
export const isAppFolder = (names: readonly string[]): boolean => names.includes('index.html') && !names.includes('index.md');
