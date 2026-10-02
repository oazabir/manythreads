import { useEffect, useState } from 'react';
import { isApiError } from '../api/client';
import { probeFiles } from '../api/endpoints';

/** The server refuses bigger uploads (413); the composer says so before sending a byte. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const TOO_LARGE = 'Too large (50 MB)';

let supported: boolean | undefined;

/** Whether attachments exist on this server (the files plugin is loaded); `false` until known, so the clip never flashes. */
export function useFilesSupport(channelId: string): boolean {
  const [known, setKnown] = useState<boolean>(supported === true);
  useEffect(() => {
    if (supported !== undefined) {
      setKnown(supported);
      return;
    }
    let live = true;
    probeFiles(channelId).then(
      () => {
        supported = true;
        if (live) setKnown(true);
      },
      (e: unknown) => {
        // 404 = no such route (no plugin). 403 or anything else says nothing about the server: stay hidden for now, ask again next time.
        if (isApiError(e) && e.status === 404) supported = false;
      },
    );
    return () => {
      live = false;
    };
  }, [channelId]);
  return known;
}

/** Files from a drop or a paste, without folders. */
export const filesOf = (list: FileList | null | undefined): File[] => (list ? [...list].filter((f) => f.name !== '') : []);
