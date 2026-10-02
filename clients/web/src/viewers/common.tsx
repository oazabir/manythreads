import { useCallback, useRef, useState, type ReactNode } from 'react';
import { baseName } from './mime';

/** Header band every text viewer shares: the path on the left, the actions (`[Save] [Raw]`) on the right. */
export function ViewerBar({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="vw-bar" data-testid="viewer-bar">
      <span className="vw-path" title={path}>{path}</span>
      <div className="vw-actions">{children}</div>
    </div>
  );
}

/** What the person sees under an editor: the commit notice, and the outcome of the last save. */
export function SaveFooter({ authorName, status, message, readOnly }: { authorName: string; status: SaveStatus; message?: string | undefined; readOnly: boolean }) {
  return (
    <div className="vw-foot">
      {status === 'error' ? <p className="vw-error" role="alert">{message ?? 'Could not save.'}</p> : null}
      {status === 'saved' ? <p className="vw-saved" role="status">Saved. A commit by {authorName} was made.</p> : null}
      {readOnly ? <p className="vw-note">You can read this file but not change it.</p> : <p className="vw-note">Saving creates a commit by {authorName}</p>}
    </div>
  );
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Wraps `onSave`: one save at a time, with the message of a refusal kept for the footer. */
export function useSave(onSave: ((text: string) => Promise<void>) | undefined) {
  const [state, setState] = useState<{ status: SaveStatus; message?: string }>({ status: 'idle' });
  const busy = useRef(false);
  const save = useCallback(
    async (text: string): Promise<boolean> => {
      if (!onSave || busy.current) return false;
      busy.current = true;
      setState({ status: 'saving' });
      try {
        await onSave(text);
        setState({ status: 'saved' });
        return true;
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error && err.message ? err.message : 'Could not save.' });
        return false;
      } finally {
        busy.current = false;
      }
    },
    [onSave],
  );
  const reset = useCallback(() => setState((s) => (s.status === 'idle' ? s : { status: 'idle' })), []);
  return { ...state, save, reset };
}

/** A message in the viewer area (nothing to show, could not render). */
export function ViewerMessage({ title, children, tone }: { title: string; children?: ReactNode; tone?: 'alert' }) {
  return (
    <div className={`vw-message ${tone ?? ''}`} role={tone === 'alert' ? 'alert' : 'status'}>
      <p className="vw-message-title">{title}</p>
      {children ? <div className="vw-message-body">{children}</div> : null}
    </div>
  );
}

export const fileLabel = baseName;
