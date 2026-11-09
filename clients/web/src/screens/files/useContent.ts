import { useCallback, useEffect, useRef, useState } from 'react';
import { bumpFiles, type TeamFiles } from './store';
import type { FileContent } from './backend';
import type { FileRow } from './model';

/**
 * The content of the open file for its viewer. The object lives as long as the file is open, so a save (which it knows the new blob of) does not reload the
 * editor; when the file's blob became another one without this object saving it (a restore from History, a move), it is read again.
 * A viewer that changed the file by another route (live editing) says so with `viewerChangedFile`: this object no longer knows what the file holds, so the next
 * time the row is read again it reads the file again whatever the blob is (a restore can bring back the very blob it first read, and the sha alone cannot tell).
 */
export function useContent(files: TeamFiles, row: FileRow): { content: FileContent; save: ((text: string) => Promise<void>) | undefined; viewerChangedFile: () => void } {
  const [content, setContent] = useState<FileContent>(() => files.backend.open(row));
  const changedAt = useRef<FileRow | null>(null);
  useEffect(() => {
    const known = content.sha?.();
    const blobMoved = Boolean(row.blobSha && known && known !== row.blobSha);
    // a row read after the viewer's change (a new object for every read)
    const readAgain = changedAt.current !== null && changedAt.current !== row;
    if (blobMoved || readAgain) {
      changedAt.current = null;
      setContent(files.backend.open(row));
    }
  }, [row, content, files]);
  const viewerChangedFile = useCallback(() => {
    changedAt.current = row;
  }, [row]);
  const saver = content.save;
  const save = saver
    ? async (text: string): Promise<void> => {
        await saver(text);
        bumpFiles();
      }
    : undefined;
  return { content, save, viewerChangedFile };
}
