import type { ComponentType } from 'react';

/** Who is looking and where; viewers use it for copy ("Saving creates a commit by Tariq") and the embedded-app bridge. */
export type ViewerContext = {
  teamSlug: string;
  teamName: string;
  /** The person who will be the commit's author. */
  authorName: string;
};

/**
 * The one props contract of every viewer. The host gives exactly what the contribution's `input` asks for:
 * `text`, `bytes` or `url` (a viewer never fetches the file itself, except pdf.js reading `url` with the session cookie).
 */
export type ViewerProps = {
  /** Repo-relative path, or the folder for an embedded app. */
  path: string;
  /** Lowercase mime type; always set (the host falls back to `application/octet-stream`). */
  mime: string;
  text?: string;
  bytes?: Uint8Array;
  url?: string;
  /** The person cannot write here (or the store is read-only): no editing controls. */
  readOnly: boolean;
  /** Persist new text; rejects with the reason (conflict, forbidden). Absent when the viewer cannot save. */
  onSave?: (text: string) => Promise<void>;
  context: ViewerContext;
  /** An Office file's PDF rendition when the optional worker made one. */
  renditionUrl?: string;
};

export type ViewerModule = { default: ComponentType<ViewerProps> };
