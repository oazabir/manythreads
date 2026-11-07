import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListPersonalInboxResponse, PersonalInboxItem } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { useShell } from '../../shell/context';
import { FILTERS, countsByFilter, dropProblem, inFilter, isProcessing, message, type FilterId } from './inboxWords';
import { fetchPersonalConcepts, fetchPersonalInbox, uploadPersonalFile } from './personalApi';
import { PersonalInboxCard } from './PersonalInboxCard';
import { PersonalNoteDialog, SendToTeamDialog } from './PersonalDialogs';
import { conceptTitles } from './personalWords';

type Upload = { id: number; name: string; state: 'sending' | 'done' | 'error'; fraction: number; message?: string };

/** How often the list is read again while something is still being filed (a person's own inbox is not pushed live). */
const POLL_MS = 3_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const NO_ITEMS: readonly PersonalInboxItem[] = [];
const PERSONAL_FILTERS = FILTERS.filter((f) => f.id !== 'needs_review');

/**
 * The Personal side of the Memory screen's Inbox tab: a drop zone and New note on top, the queue with filters, and a card for each drop. It is the team inbox on a
 * shorter road: nothing here belongs to a team, so nobody checks it for you. What looks risky waits for you to let it through or discard it. "Send to team" copies
 * an item into a team's inbox, where that team's rules apply.
 */
export function PersonalInboxTab() {
  const { teams } = useShell();
  const q = useQuery('personal-inbox', () => fetchPersonalInbox());
  const concepts = useQuery('personal-inbox-concepts', fetchPersonalConcepts);
  const [filter, setFilter] = useState<FilterId>('all');
  const [noting, setNoting] = useState(false);
  const [sending, setSending] = useState<PersonalInboxItem | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // The last list that arrived is kept: a read that fails once (a dropped connection in the middle of the polling) must not empty the list or stop the polling
  const lastGood = useRef<ListPersonalInboxResponse | null>(null);
  if (q.status === 'ok') lastGood.current = q.data;
  const data = q.status === 'ok' ? q.data : lastGood.current;
  const items = data?.items ?? NO_ITEMS;
  const maxBytes = data?.maxBytes ?? DEFAULT_MAX_BYTES;
  const counts = useMemo(() => countsByFilter(items), [items]);
  const shown = useMemo(() => items.filter((i) => inFilter(i, filter)), [items, filter]);
  const titles = useMemo(() => conceptTitles(concepts.status === 'ok' ? concepts.data.items : []), [concepts]);

  const { reload } = q;
  const conceptsReload = concepts.reload;
  const anyMoving = items.some(isProcessing);
  // read again while something is being filed, and once more when it finishes so the file titles are there
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
        const answer = await uploadPersonalFile(file, (fraction) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, fraction } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'done', fraction: 1 } : x)));
        setSaid(answer.duplicate ? `${file.name} is already in your inbox, so nothing new was added.` : `${file.name} is in your inbox.`);
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

  return (
    <div className="mi" data-testid="personal-inbox-tab">
      <div
        className={`mi-drop ${dropping ? 'on' : ''}`}
        data-testid="personal-inbox-dropzone"
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
          <span>Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files are read and filed in your own memory. Only you can see them. Pictures and recordings are kept but cannot be read yet.</span>
        </div>
        <div className="mi-drop-actions">
          <button type="button" className="btn s p" onClick={() => picker.current?.click()} data-testid="personal-inbox-choose">Choose files</button>
          <button type="button" className="btn s" onClick={() => setNoting(true)} data-testid="personal-inbox-new-note">New note</button>
          <input ref={picker} type="file" multiple hidden aria-label="Choose files to drop into your inbox" data-testid="personal-inbox-file-input" onChange={(e) => onPick(e.target.files)} />
        </div>
        <p className="mi-help mp-tip">You can also use “Send to memory” on any message and choose your own memory.</p>
      </div>

      {uploads.length > 0 ? (
        <ul className="mi-uploads" data-testid="personal-inbox-uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className={`mi-upload ${u.state}`}>
              <span className="mi-upload-name">{u.name}</span>
              {u.state === 'sending' ? <progress max={1} value={u.fraction} aria-label={`Sending ${u.name}`} /> : u.state === 'done' ? <span>Sent</span> : <span role="alert">{u.message}</span>}
              {u.state === 'error' ? <button type="button" className="btn s" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>Dismiss</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mi-status" role="status" aria-live="polite" data-testid="personal-inbox-status">{said}</div>

      <div className="mi-filters" role="toolbar" aria-label="Filter your inbox" data-testid="personal-inbox-filters">
        {PERSONAL_FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} data-testid={`personal-inbox-filter-${f.id}`}>
            {f.label} <span className="mi-count" data-testid={`personal-inbox-count-${f.id}`}>{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {q.status === 'loading' && data === null ? <div className="view-empty" aria-busy="true" /> : null}
      {q.status === 'error' ? (
        <p className="mi-error" role={data === null ? 'alert' : undefined} data-testid="personal-inbox-load-error">
          Your inbox could not be loaded: {q.error.message}
          {data !== null ? ' The list below may be out of date.' : ' '}
          <button type="button" className="btn s" onClick={q.reload}>Try again</button>
        </p>
      ) : null}
      {data !== null && shown.length === 0 ? (
        <p className="mi-empty faint" data-testid="personal-inbox-empty">
          {items.length === 0 ? 'Nothing has been dropped yet. Drop a file, write a note, or use “Send to memory” on a message.' : 'Nothing here right now.'}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="mi-list" data-testid="personal-inbox-list">
          {shown.map((item) => (
            <PersonalInboxCard
              key={item.id}
              item={item}
              titles={titles}
              onSendToTeam={setSending}
              onChanged={(_next, line) => {
                setSaid(line);
                reload();
              }}
            />
          ))}
        </ul>
      ) : null}

      {noting ? (
        <PersonalNoteDialog
          onClose={() => setNoting(false)}
          onDone={(item, duplicate) => {
            setSaid(duplicate ? `${item.name} is already in your inbox, so nothing new was added.` : `${item.name} is in your inbox.`);
            reload();
          }}
        />
      ) : null}
      {sending ? <SendToTeamDialog item={sending} teams={teams} onClose={() => setSending(null)} onDone={setSaid} /> : null}
    </div>
  );
}
