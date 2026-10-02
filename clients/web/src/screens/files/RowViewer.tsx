import { useEffect, useState } from 'react';
import { useSession } from '../../app/session';
import { FileViewer } from '../../viewers/FileViewer';
import { ViewerMessage } from '../../viewers/common';
import type { FileContent } from './backend';
import { isAppFolder, type FileRow } from './model';
import { useFilesVersion, type TeamFiles } from './store';

/** The names a folder holds, for the viewer that recognises an app folder by them (null until they are known). */
function useFolderNames(files: TeamFiles, row: FileRow): string[] | null {
  const version = useFilesVersion();
  const [state, setState] = useState<{ path: string; names: string[] } | null>(null);
  useEffect(() => {
    if (row.kind !== 'folder') return;
    let live = true;
    files.backend.list(row.path).then(
      (l) => live && setState({ path: row.path, names: l.rows.map((r) => r.name) }),
      () => live && setState({ path: row.path, names: [] }),
    );
    return () => {
      live = false;
    };
  }, [files, row.kind, row.path, version]);
  return state?.path === row.path ? state.names : null;
}

/** The viewer of a row: a file in the viewer its type asks for, an app folder as a sandboxed app. */
export function RowViewer({ files, row, content, save, readOnly }: { files: TeamFiles; row: FileRow; content: FileContent; save: ((text: string) => Promise<void>) | undefined; readOnly: boolean }) {
  const session = useSession();
  const names = useFolderNames(files, row);
  const context = { teamSlug: files.slug, teamName: files.teamName, authorName: session.person.name };
  if (row.kind === 'folder') {
    if (names === null) return <div className="vw-loading" role="status" aria-busy="true">Loading…</div>;
    if (!isAppFolder(names)) return <ViewerMessage title="This folder is not an app">Open a file from the tree or the list.</ViewerMessage>;
    return <FileViewer path={row.path} kind="folder" entries={names} source={content.source} readOnly context={context} />;
  }
  return <FileViewer path={row.path} {...(row.mime ? { mime: row.mime } : {})} source={content.source} readOnly={readOnly} {...(save ? { onSave: save } : {})} context={context} />;
}
