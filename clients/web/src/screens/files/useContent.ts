import { useEffect, useState } from 'react';
import { bumpFiles, type TeamFiles } from './store';
import type { FileContent } from './backend';
import type { FileRow } from './model';

/**
 * The content of the open file for its viewer. The object lives as long as the file is open, so a save (which it knows the new blob of) does not reload the
 * editor; when the file's blob became another one without this object saving it (a restore from History, a move), it is read again.
 */
export function useContent(files: TeamFiles, row: FileRow): { content: FileContent; save: ((text: string) => Promise<void>) | undefined } {
  const [content, setContent] = useState<FileContent>(() => files.backend.open(row));
  useEffect(() => {
    const known = content.sha?.();
    if (row.blobSha && known && known !== row.blobSha) setContent(files.backend.open(row));
  }, [row, content, files]);
  const saver = content.save;
  const save = saver
    ? async (text: string): Promise<void> => {
        await saver(text);
        bumpFiles();
      }
    : undefined;
  return { content, save };
}
