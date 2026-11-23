import { useEffect, useId, useState } from 'react';

/*
 * A note for a thread (owner, 2026-11-23): something to remember about it, kept in this browser only (nobody else sees it, and it is not on other devices). It
 * is saved as it is typed; an empty note is removed.
 */

const KEY = (rootId: string): string => `manythreads.thread-note:${rootId}`;

export function readThreadNote(rootId: string): string {
  try {
    return window.localStorage.getItem(KEY(rootId)) ?? '';
  } catch {
    return '';
  }
}

export function writeThreadNote(rootId: string, text: string): void {
  try {
    if (text.trim() === '') window.localStorage.removeItem(KEY(rootId));
    else window.localStorage.setItem(KEY(rootId), text.slice(0, 5000));
  } catch {
    /* storage can be blocked: the note then lasts as long as the page */
  }
}

export function ThreadNote({ rootId }: { rootId: string }) {
  const heading = useId();
  const [text, setText] = useState(() => readThreadNote(rootId));
  // another thread opened in the same rail: its own note
  useEffect(() => setText(readThreadNote(rootId)), [rootId]);
  useEffect(() => {
    const t = window.setTimeout(() => writeThreadNote(rootId, text), 300);
    return () => window.clearTimeout(t);
  }, [rootId, text]);
  return (
    <section className="trSection trNote" aria-labelledby={heading} data-testid="thread-note">
      <h3 id={heading} className="trH">My note</h3>
      <textarea
        className="trNoteBox"
        value={text}
        maxLength={5000}
        rows={4}
        placeholder="Something to remember about this thread. Only you see it, in this browser."
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => writeThreadNote(rootId, e.target.value)}
        aria-labelledby={heading}
        data-testid="thread-note-box"
      />
    </section>
  );
}
