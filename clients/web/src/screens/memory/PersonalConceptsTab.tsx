import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { MemoryConceptSummary, PersonalMemoryFile } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { friendlyPath } from '../../components/friendlyPath';
import { Dialog } from '../../components/Dialog';
import { SkeletonRows } from '../../components/Skeleton';
import { Time } from '../../components/ui';
import { fetchPersonalConcepts, fetchPersonalFile, fetchPersonalVersions, removePersonalFile, restorePersonalVersion, savePersonalFile } from './personalApi';
import { authorLabel, findConcept, isChangedSince, saveFailureWords, versionLine } from './personalWords';
import { message } from './inboxWords';

const isStale = (c: Pick<MemoryConceptSummary, 'staleAfter'>): boolean => c.staleAfter !== null && Date.parse(c.staleAfter) < Date.now();

const TRUST_WORDS: Record<MemoryConceptSummary['trustTier'], string> = {
  unverified: 'Not checked',
  'machine-confirmed': 'Checked by a bot',
  'human-reviewed': 'Checked by you',
};

/**
 * The Personal side of the Memory screen's first tab: the files of your own memory (an OKF bundle, the open format a team's memory folder uses), the file itself
 * on the right, and what you can do with it: edit it (a save that started from an old version is refused, never merged), look at its saved versions and bring one
 * back, or delete it. Only you see this; it is never shared with a team.
 */
export function PersonalConceptsTab({ wanted }: { wanted: string | null }) {
  const q = useQuery('personal-memory-concepts', fetchPersonalConcepts);
  const [picked, setPicked] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);

  const items = useMemo(() => (q.status === 'ok' ? q.data.items : []), [q]);
  // a link to another file replaces the person's pick
  useEffect(() => setPicked(null), [wanted]);
  const selected = findConcept(items, picked) ?? findConcept(items, wanted);
  const words = find.trim().toLowerCase();
  const shown = words === '' ? items : items.filter((c) => `${c.title} ${c.path} ${c.description ?? ''} ${c.tags.join(' ')}`.toLowerCase().includes(words));

  const pick = (path: string): void => {
    setPicked(path);
    window.setTimeout(() => detail.current?.scrollIntoView?.({ block: 'start' }), 0);
  };

  if (q.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (q.status === 'error') return <p className="mi-error" role="alert" data-testid="personal-memory-error">Your memory could not be loaded: {q.error.message}</p>;

  return (
    <div className="mp" data-testid="personal-concepts">
      <p className="mi-help" data-testid="personal-memory-intro">This is your own memory. Only you can see it, and it is never shared with a team. Bots read it only when you ask them in a private conversation and have said they may.</p>
      <div className="mp-find">
        <label className="mi-label" htmlFor="mp-find-input">Find in your memory</label>
        <input id="mp-find-input" className="mi-input" type="search" value={find} onChange={(e) => setFind(e.target.value)} autoComplete="off" data-testid="personal-memory-find" />
      </div>
      <div className="mp-status" role="status" aria-live="polite" data-testid="personal-memory-status">{said}</div>
      <div className="mm-body">
        <ul className="mm-tree mp-tree" data-testid="personal-concept-list" aria-label="Your memory files">
          {shown.map((c) => (
            <li key={c.path} className="mp-item">
              <button
                type="button"
                className={`mp-row ${selected?.path === c.path ? 'on' : ''}`}
                aria-current={selected?.path === c.path ? 'true' : undefined}
                onClick={() => pick(c.path)}
                data-testid="personal-concept-row"
                data-path={c.path}
              >
                <span className="mm-concept-path" title={c.path}>{c.title || c.path}</span>
                {c.description ? <span className="mm-concept-desc">{c.description}</span> : null}
                <span className="mp-chips">
                  <span className="mm-chip mm-chip-type">{c.type}</span>
                  <span className={`mm-chip mm-chip-trust mm-trust-${c.trustTier}`}>{TRUST_WORDS[c.trustTier]}</span>
                  {isStale(c) ? <span className="mm-chip mm-chip-stale">stale</span> : null}
                  {c.status === 'deprecated' ? <span className="mm-chip mm-chip-deprecated">deprecated</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <PersonalFileDetail
            key={selected.path}
            concept={selected}
            panel={detail}
            onChanged={(line) => {
              setSaid(line);
              q.reload();
            }}
            onGone={(line) => {
              setPicked(null);
              setSaid(line);
              q.reload();
            }}
          />
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="mi-empty faint" data-testid="personal-memory-empty">Nothing in your memory yet. Drop a file or a note in the Inbox tab and it is read and filed here.</p>
      ) : shown.length === 0 ? (
        <p className="mi-empty faint" data-testid="personal-memory-nomatch">No file matches “{find.trim()}”.</p>
      ) : null}
    </div>
  );
}

type Mode = 'view' | 'edit' | 'history';

function PersonalFileDetail({ concept, panel, onChanged, onGone }: { concept: MemoryConceptSummary; panel: RefObject<HTMLElement | null>; onChanged: (said: string) => void; onGone: (said: string) => void }) {
  const [load, setLoad] = useState(0);
  const file = useQuery(`personal-memory-file:${concept.path}:${String(load)}`, () => fetchPersonalFile(concept.path));
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const current = file.status === 'ok' ? file.data.file : null;
  // The button that opened Edit or Earlier versions is gone while the form or the list is open: focus goes into it, and back to that button when it closes.
  const editBtn = useRef<HTMLButtonElement>(null);
  const historyBtn = useRef<HTMLButtonElement>(null);
  const editArea = useRef<HTMLTextAreaElement>(null);
  const leaving = useRef<Mode | null>(null);
  useEffect(() => {
    if (mode === 'edit') editArea.current?.focus();
    else if (mode === 'view' && leaving.current === 'edit') editBtn.current?.focus();
    else if (mode === 'view' && leaving.current === 'history') historyBtn.current?.focus();
    leaving.current = mode;
  }, [mode]);

  const reread = (): void => {
    setLoad((n) => n + 1);
    setError(null);
    setStale(false);
  };

  const startEdit = (f: PersonalMemoryFile): void => {
    setDraft(f.content);
    setError(null);
    setStale(false);
    setMode('edit');
  };

  const save = async (f: PersonalMemoryFile): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await savePersonalFile({ path: f.path, content: draft, baseVersion: f.versionNo });
      setMode('view');
      reread();
      onChanged(`Saved ${saved.concept.title || f.path} as version ${String(saved.file.versionNo)}.`);
    } catch (e) {
      setStale(isChangedSince(e));
      setError(saveFailureWords(e, 'The file could not be saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: PersonalMemoryFile): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await removePersonalFile(f.path);
      onGone(`${concept.title || f.path} was deleted from your memory.`);
    } catch (e) {
      setConfirming(false);
      setError(message(e, 'The file could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="mm-detail mp-detail" ref={panel} data-testid="personal-concept-detail" data-path={concept.path} aria-busy={file.status === 'loading' || undefined}>
      <h2 className="mm-detail-title" data-testid="personal-concept-title">{concept.title || concept.path}</h2>
      {concept.description ? <p className="mm-detail-desc">{concept.description}</p> : null}
      <div className="mm-detail-meta">
        <span className="mm-chip mm-chip-type">{concept.type}</span>
        <span className={`mm-chip mm-chip-trust mm-trust-${concept.trustTier}`}>{TRUST_WORDS[concept.trustTier]}</span>
        {isStale(concept) ? <span className="mm-chip mm-chip-stale">stale</span> : null}
        {concept.status === 'deprecated' ? <span className="mm-chip mm-chip-deprecated">deprecated</span> : null}
      </div>
      <div className="mm-tags mono" title={concept.path}>{friendlyPath(concept.path)}</div>
      {concept.tags.length > 0 ? <div className="mm-tags">{concept.tags.join(', ')}</div> : null}

      {file.status === 'error' ? <p className="mi-error" role="alert" data-testid="personal-file-error">This file could not be opened: {file.error.message}</p> : null}
      {current ? (
        <p className="mp-version faint" data-testid="personal-file-version">
          {versionLine(current)} · changed <Time iso={current.updatedAt} />
        </p>
      ) : null}

      {mode === 'view' && current ? (
        <>
          <pre className="mp-text" tabIndex={0} aria-label={`Text of ${concept.title || concept.path}`} data-testid="personal-file-text" data-vt-mask>{current.content}</pre>
          <div className="mm-actions mp-actions">
            <button ref={editBtn} type="button" className="btn s" onClick={() => startEdit(current)} data-testid="personal-file-edit">Edit</button>
            <button ref={historyBtn} type="button" className="btn s" onClick={() => setMode('history')} data-testid="personal-file-history">Earlier versions</button>
            <button type="button" className="btn s danger" onClick={() => setConfirming(true)} data-testid="personal-file-delete">Delete</button>
          </div>
        </>
      ) : null}

      {mode === 'edit' && current ? (
        <form
          className="mp-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save(current);
          }}
        >
          <label className="mi-label" htmlFor="mp-edit-text">Text of the file (Markdown, with its front block)</label>
          <textarea ref={editArea} id="mp-edit-text" className="mi-input mi-text mp-textarea" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} data-testid="personal-file-textarea" />
          <div className="mm-actions mp-actions">
            <button type="submit" className="btn s primary" disabled={busy || draft.trim() === '' || draft === current.content} data-testid="personal-file-save">{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn s" disabled={busy} onClick={() => { setMode('view'); setError(null); }} data-testid="personal-file-cancel">Cancel</button>
            {stale ? <button type="button" className="btn s" onClick={() => { setMode('view'); reread(); }} data-testid="personal-file-reload">Open the latest version</button> : null}
          </div>
        </form>
      ) : null}

      {mode === 'history' ? (
        <History
          path={concept.path}
          currentVersion={current?.versionNo ?? null}
          onClose={() => setMode('view')}
          onRestored={(f) => {
            setMode('view');
            reread();
            onChanged(`Version ${String(f.versionNo)} of ${concept.title || concept.path} was brought back as a new version.`);
          }}
        />
      ) : null}

      {error ? <p className="mi-error" role="alert" data-testid="personal-file-problem">{error}</p> : null}

      {confirming && current ? (
        <Dialog
          title="Delete this file?"
          onClose={() => setConfirming(false)}
          testId="personal-file-delete-dialog"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Keep it</button>
              <button type="button" className="btn danger" onClick={() => void remove(current)} disabled={busy} data-testid="personal-file-delete-confirm">{busy ? 'Deleting…' : 'Delete it'}</button>
            </>
          }
        >
          <p className="mi-help">“{concept.title || concept.path}” is removed from your memory, with its earlier versions. Bots will no longer find it.</p>
        </Dialog>
      ) : null}
    </aside>
  );
}

function History({ path, currentVersion, onClose, onRestored }: { path: string; currentVersion: number | null; onClose: () => void; onRestored: (file: PersonalMemoryFile) => void }) {
  const q = useQuery(`personal-memory-versions:${path}`, () => fetchPersonalVersions(path));
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (versionNo: number): Promise<void> => {
    setBusy(versionNo);
    setError(null);
    try {
      const done = await restorePersonalVersion(path, versionNo);
      onRestored(done.file);
    } catch (e) {
      setError(saveFailureWords(e, 'That version could not be brought back.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mp-history" aria-label="Earlier versions" data-testid="personal-file-versions">
      <div className="mp-history-head">
        <strong>Earlier versions</strong>
        <button type="button" className="btn s" onClick={onClose} data-testid="personal-file-history-close">Close</button>
      </div>
      {q.status === 'loading' ? <SkeletonRows rows={2} label="Loading earlier versions" /> : null}
      {q.status === 'error' ? <p className="mi-error" role="alert">The versions could not be loaded: {q.error.message}</p> : null}
      {q.status === 'ok' ? (
        <ul className="mp-versions">
          {q.data.items.map((v) => (
            <li key={v.versionNo} className="mp-version-row" data-testid="personal-file-version-row" data-version={v.versionNo}>
              <span className="mp-version-main">
                <strong>Version {v.versionNo}</strong>
                {v.versionNo === currentVersion ? <span className="mi-chip">Now</span> : null}
                <span className="faint"> · <Time iso={v.createdAt} /> · {authorLabel(v.authorKind)}</span>
              </span>
              {v.versionNo !== currentVersion ? (
                <button type="button" className="btn s" disabled={busy !== null} onClick={() => void restore(v.versionNo)} aria-label={`Bring back version ${String(v.versionNo)}`} data-testid="personal-file-restore">
                  {busy === v.versionNo ? 'Bringing back…' : 'Bring back'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mi-error" role="alert" data-testid="personal-file-restore-error">{error}</p> : null}
      <p className="faint mp-hint">Bringing a version back adds it as a new version; nothing is lost. The latest 50 versions of a file are kept.</p>
    </section>
  );
}
