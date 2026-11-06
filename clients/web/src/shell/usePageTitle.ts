import { useEffect } from 'react';
import { useSessionState } from '../app/session';

/** The tab title of a page outside the shell (settings, account, sign-in): `<page> · <workspace>`; before the workspace is known, `<page> · manythreads`. */
export function useDocumentTitle(page: string | null): void {
  const { state } = useSessionState();
  const workspace = state.status === 'ready' ? state.session.workspace.name : 'manythreads';
  useEffect(() => {
    if (page) document.title = `${page} · ${workspace}`;
  }, [page, workspace]);
}
