import { useEffect, useState } from 'react';
import { isApiError } from '../../api/client';
import type { FileRow } from './model';
import { useFilesVersion, type TeamFiles } from './store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A panel entry `file:<id>` names an attachment by its file id, a file of the repo by its path. */
export const isFileId = (id: string): boolean => UUID.test(id);

export type RowState = { status: 'loading' } | { status: 'ok'; row: FileRow } | { status: 'missing' } | { status: 'forbidden' } | { status: 'error'; message: string };

/** The row behind a path or a file id, loaded again after every change (the state of the row after a save, a move, a restore). */
export function useFileRow(files: TeamFiles | null, id: string | null): RowState {
  const version = useFilesVersion();
  const [state, setState] = useState<{ key: string; value: RowState }>({ key: '', value: { status: 'loading' } });
  const key = `${files?.slug ?? ''}\0${id ?? ''}`;
  useEffect(() => {
    if (!files || !id) return;
    let live = true;
    const read = isFileId(id) ? files.backend.statById(id) : files.backend.stat(id);
    read.then(
      (row) => live && setState({ key, value: row ? { status: 'ok', row } : { status: 'missing' } }),
      (err: unknown) => {
        if (!live) return;
        const status = isApiError(err) ? err.status : 0;
        setState({ key, value: status === 403 ? { status: 'forbidden' } : status === 404 ? { status: 'missing' } : { status: 'error', message: err instanceof Error ? err.message : 'The file could not be loaded.' } });
      },
    );
    return () => {
      live = false;
    };
  }, [files, id, key, version]);
  // a different file shows "loading", never the previous one
  return state.key === key ? state.value : { status: 'loading' };
}
