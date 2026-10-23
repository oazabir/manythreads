import type { FileSummary } from '@manythreads/shared';

/*
 * Which attachments a message draws as a picture. The files route serves only the types whose first bytes confirmed them as an image
 * inline (`INLINE_IMAGE_TYPES` in `packages/plugins/files/src/mime.ts`); an SVG is deliberately not one of them — it is served as
 * opaque bytes, so `<img>` cannot draw it and it stays a file card. The list is repeated here because the browser bundle cannot import
 * a server plugin's module.
 */
const PREVIEWABLE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** A file the chat can show as a preview rather than as a download card. */
export const isPreviewableImage = (file: FileSummary): boolean => PREVIEWABLE.has(file.mime);

/** A message's attachments, split into the pictures drawn as previews and the files drawn as cards (order kept in both). */
export function splitAttachments(files: readonly FileSummary[] | undefined): { images: FileSummary[]; files: FileSummary[] } {
  const images: FileSummary[] = [];
  const rest: FileSummary[] = [];
  for (const file of files ?? []) (isPreviewableImage(file) ? images : rest).push(file);
  return { images, files: rest };
}
