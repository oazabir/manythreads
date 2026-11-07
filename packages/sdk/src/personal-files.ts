import type { PluginTx, ProviderImpl } from './types.ts';

// A person's own text files, for the plugins that keep a person's text in their Personal space (P20-10 to P20-12): the files plugin registers the one
// provider (kind `personal.files`), so the scheduled jobs plugin writes a routine's contract and its output, and the action-items list is read and saved,
// without importing the files plugin. Text only (a file of at most 200 000 bytes); every save of changed text is a new version of the file, so nothing a
// person wrote is lost. The caller's transaction decides who is acting: the owner's own, or the system's (a routine's run is finished by the system
// role, and says in `authorActorId` which bot wrote).

export interface PersonalTextFile {
  fileId: string;
  /** `Routines/morning-brief/output.md`: folder, a slash and the name. */
  path: string;
  text: string;
  /** The sha-256 of the text. A save that names the revision it read is refused (409) when the file has changed since. */
  revision: string;
  updatedAt: string;
}

export interface PersonalWriteOptions {
  /** `replace` (default) puts the new text in place of the old; `append` adds it to the end; `create` fails (409) when the file exists. */
  mode?: 'create' | 'replace' | 'append';
  /** The revision the writer read: `null` means "the file did not exist", a string "it had this revision". Left out, the write is not checked. */
  expectedRevision?: string | null;
  /** Who is recorded as the author of the new version; default is the transaction's actor. */
  authorActorId?: string;
}

export interface PersonalFilesProvider extends ProviderImpl {
  /** The text of one file in the person's space, or null when there is no such file or it is not text. A file over 200 000 bytes answers null. */
  read(tx: PluginTx, personId: string, path: string): Promise<PersonalTextFile | null>;
  /**
   * Save text at `path` in the person's space (the folders are made). Throws an HTTP error with status 409 when `expectedRevision` is stale or `create` finds the
   * file, 413 when the text or the person's allowance is too large, 403 when the person has no Personal space. `changed` is false when the text was already there.
   */
  write(tx: PluginTx, personId: string, path: string, text: string, options?: PersonalWriteOptions): Promise<{ file: PersonalTextFile; created: boolean; changed: boolean }>;
  /**
   * Delete one folder of the person's space with every file in it and every folder under it (the files' older versions go with them; the stored bytes are removed by the files plugin's
   * blob garbage collection). `folderPath` is the folder without a trailing slash (`Routines/morning-brief`). Nothing outside it is touched: a sibling whose name only starts the same
   * (`Routines/morning-brief-2`) stays. An empty path, a path with an empty, `.` or `..` part and one of the folders every Personal space starts with are refused (400). A folder
   * that does not exist removes nothing. Acts as the transaction's actor, so row level security still decides which rows are the person's.
   */
  removeFolder(tx: PluginTx, personId: string, folderPath: string): Promise<{ removed: number }>;
}

/** The most a routine file or action list may hold. */
export const PERSONAL_TEXT_MAX_BYTES = 200_000;
