import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxItem } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { InboxCard } from './InboxCard';
import { fetchConcepts, fetchInboxItems, uploadInboxFile } from './inboxApi';
import { useInboxPush } from './inboxLive';
import { FILTERS, countsByFilter, dropProblem, emailAddressOf, inFilter, isProcessing, message, type FilterId } from './inboxWords';
import { NoteDialog } from './NoteDialog';

type Upload = { id: number; name: string; state: 'sending' | 'done' | 'error'; fraction: number; message?: string };

/** How often the list is read again while something is still being filed (a live push makes it faster for the person's own drops). */
const POLL_MS = 3_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const NO_ITEMS: readonly InboxItem[] = [];

/**
 * The Memory screen's Inbox tab (PLAN P8-21): a drop zone and New note on top, the team's email address when the server has one, the queue with filters,
 * and a card for each drop. Anyone on the team with the right to post drops; a team lead or a workspace admin also releases, discards and retries.
 */
export function InboxTab({ slug }: { slug: string }) {
  const q = useQuery(`inbox:${slug}`, () => fetchInboxItems(slug));
  const concepts = useQuery(`inbox-concepts:${slug}`, () => fetchConcepts(slug));
  const [filter, setFilter] = useState<FilterId>('all');
  const [teamOnly, setTeamOnly] = useState(false);
  const [noting, setNoting] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const items = q.status === 'ok' ? q.data.items : NO_ITEMS;
  const canManage = q.status === 'ok' ? q.data.canManage : false;
  const maxBytes = q.status === 'ok' ? q.data.maxBytes : DEFAULT_MAX_BYTES;
  const address = q.status === 'ok' ? emailAddressOf(q.data) : null;
  const counts = useMemo(() => countsByFilter(items), [items]);
  const shown = useMemo(() => items.filter((i) => inFilter(i, filter)), [items, filter]);
  const titles = useMemo(() => new Map(concepts.status === 'ok' ? concepts.data.items.map((c) => [c.path, c.title]) : []), [concepts]);

  const { reload } = q;
  const conceptsReload = concepts.reload;
  const anyMoving = items.some(isProcessing);
  // read again while something is being filed, and once more when it finishes so the concept titles are there
  useEffect(() => {
    if (!anyMoving) return;
    const t = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [anyMoving, reload]);
  const wasMoving = useRef(false);
  useEffect(() => {
    if (wasMoving.current && !anyMoving) conceptsReload();
    wasMoving.current = anyMoving;
  }, [anyMoving, conceptsReload]);
  useInboxPush(useCallback(() => reload(), [reload]));

  const upload = async (list: File[]): Promise<void> => {
    for (const file of list) {
      const id = ++seq.current;
      const problem = dropProblem(file, maxBytes);
      if (problem) {
        setUploads((u) => [...u, { id, name: file.name, state: 'error', fraction: 0, message: problem }]);
        continue;
      }
      setUploads((u) => [...u, { id, name: file.name, state: 'sending', fraction: 0 }]);
      try {
        const answer = await uploadInboxFile(slug, file, teamOnly, (fraction) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, fraction } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'done', fraction: 1 } : x)));
        setSaid(answer.duplicate ? `${file.name} was dropped before, so nothing new was added.` : `${file.name} is in the inbox.`);
        reload();
        window.setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2_500);
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'error', message: message(e, 'The file could not be dropped.') } : x)));
      }
    }
  };
  const onPick = (list: FileList | null): void => {
    const chosen = list ? [...list] : [];
    if (picker.current) picker.current.value = '';
    void upload(chosen);
  };

  const copyAddress = async (): Promise<void> => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setSaid('The address was copied.');
    } catch {
      setSaid('Your browser would not copy it. Select the address and copy it by hand.');
    }
  };

  return (
    <div className="mi" data-testid="inbox-tab">
      <div
        className={`mi-drop ${dropping ? 'on' : ''}`}
        data-testid="inbox-dropzone"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropping(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDropping(false);
          void upload([...e.dataTransfer.files]);
        }}
      >
        <div className="mi-drop-text">
          <strong>Drop a file here</strong>
          <span>Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files are read and turned into memory. Pictures and recordings are kept but cannot be read yet.</span>
        </div>
        <div className="mi-drop-actions">
          <button type="button" className="btn s p" onClick={() => picker.current?.click()} data-testid="inbox-choose">Choose files</button>
          <button type="button" className="btn s" onClick={() => setNoting(true)} data-testid="inbox-new-note">New note</button>
          <input ref={picker} type="file" multiple hidden aria-label="Choose files to drop into the inbox" data-testid="inbox-file-input" onChange={(e) => onPick(e.target.files)} />
        </div>
        <label className="check mi-check">
          <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} data-testid="inbox-team-only" />
          <span>Team only: keep what is filed out of what is shared with other teams</span>
        </label>
        {address ? (
          <p className="mi-email" data-testid="inbox-email">
            Or send it by email to <code className="mono" data-testid="inbox-email-address">{address}</code>
            <button type="button" className="btn s" onClick={() => void copyAddress()} aria-label="Copy the team’s email address">Copy</button>
          </p>
        ) : null}
      </div>

      {uploads.length > 0 ? (
        <ul className="mi-uploads" data-testid="inbox-uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className={`mi-upload ${u.state}`}>
              <span className="mi-upload-name">{u.name}</span>
              {u.state === 'sending' ? <progress max={1} value={u.fraction} aria-label={`Sending ${u.name}`} /> : u.state === 'done' ? <span>Sent</span> : <span role="alert">{u.message}</span>}
              {u.state === 'error' ? <button type="button" className="btn s" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>Dismiss</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mi-status" role="status" aria-live="polite" data-testid="inbox-status">{said}</div>

      <div className="mi-filters" role="toolbar" aria-label="Filter the inbox" data-testid="inbox-filters">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} data-testid={`inbox-filter-${f.id}`}>
            {f.label} <span className="mi-count" data-testid={`inbox-count-${f.id}`}>{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {q.status === 'loading' ? <div className="view-empty" aria-busy="true" /> : null}
      {q.status === 'error' ? <p className="mi-error" role="alert" data-testid="inbox-load-error">The inbox could not be loaded: {q.error.message}</p> : null}
      {q.status === 'ok' && shown.length === 0 ? (
        <p className="mi-empty faint" data-testid="inbox-empty">
          {items.length === 0 ? 'Nothing has been dropped yet. Drop a file, write a note, or use “Send to memory” on a message.' : 'Nothing here right now.'}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="mi-list" data-testid="inbox-list">
          {shown.map((item) => (
            <InboxCard
              key={item.id}
              slug={slug}
              item={item}
              canManage={canManage}
              titles={titles}
              onChanged={(_next: InboxItem, line) => {
                setSaid(line);
                reload();
              }}
            />
          ))}
        </ul>
      ) : null}

      {noting ? (
        <NoteDialog
          slug={slug}
          teamOnlyDefault={teamOnly}
          onClose={() => setNoting(false)}
          onDone={(item, duplicate) => {
            setSaid(duplicate ? `${item.name} was added before, so nothing new was added.` : `${item.name} is in the inbox.`);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
