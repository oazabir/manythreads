import { useState } from 'react';
import { Link } from 'react-router';
import type { BoardId, MeetingNoteItem, MeetingNotes, MeetingOverview } from '@manythreads/shared';
import { Markdown } from '../../channels/MessageMarkdown';
import { fetchBoards, createTask } from '../boards/api';
import { useQuery } from '../../app/useQuery';
import { SkeletonRows } from '../../components/Skeleton';
import { saveMeetingNotes } from '../../meetings/api';
import { friendlyPath } from '../../components/friendlyPath';
import { SaveToTeamDialog } from './SaveToTeamDialog';
import { SendToMemoryDialog } from './SendToMemoryDialog';
import {
  NOTES_CHANGED,
  NOTES_FAILED,
  NOTES_PENDING,
  actionFailure,
  actionsOf,
  boardCardOf,
  cardKey,
  clockWords,
  decisionsOf,
  headingWithCount,
  isConflict,
  itemKey,
  ownerLine,
  questionsOf,
  showsMarkdownOnly,
} from './words';

/** The action items this browser already made cards of. A per-viewer convenience: the server does not record it, so a cleared browser forgets and may offer the button again. */
function readDone(meetingId: string): string[] {
  try {
    const raw = window.localStorage.getItem(cardKey(meetingId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeDone(meetingId: string, keys: string[]): void {
  try {
    window.localStorage.setItem(cardKey(meetingId), JSON.stringify(keys.slice(-200)));
  } catch {
    // private window or blocked storage: the button simply comes back next time
  }
}

/** The time a note came from, as a button that jumps to that line of the transcript. */
function At({ ms, onJump }: { ms: number; onJump: (ms: number) => void }) {
  return (
    <button type="button" className="mv-at" onClick={() => onJump(ms)} title="Go to this moment in the transcript" data-testid="note-at">
      {clockWords(ms)}
    </button>
  );
}

/** "Add to board" on one action item: pick the team's board (the first by default) and a card is made in your name with the owner and the day in it. */
function AddToBoard({ slug, item, meetingTitle, onAdded }: { slug: string; item: MeetingNoteItem; meetingTitle: string; onAdded: (boardName: string) => void }) {
  const boards = useQuery(`meeting-boards:${slug}`, () => fetchBoards(slug).then((r) => r.items));
  const [boardId, setBoardId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (boards.status === 'loading') return <span className="mv-add" role="status" aria-busy="true">Loading boards…</span>;
  if (boards.status === 'error') return <span className="mv-add mv-bad" role="alert">{actionFailure(boards.error, 'Could not load the boards.')}</span>;
  if (boards.data.length === 0) return <span className="mv-add mv-quiet">This team has no board yet.</span>;
  const chosen = boards.data.find((b) => b.id === boardId) ?? boards.data[0];
  if (!chosen) return null;
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const card = boardCardOf(item, meetingTitle);
      await createTask(slug, { ...card, kind: 'other', priority: 'normal', branch: 'main', boardId: chosen.id as BoardId });
      onAdded(chosen.name);
    } catch (e) {
      setError(actionFailure(e, 'The card could not be made. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="mv-add">
      {boards.data.length > 1 ? (
        <select className="dlg-input mv-board-pick" aria-label="Board" value={chosen.id} onChange={(e) => setBoardId(e.target.value)} data-testid="note-board">
          {boards.data.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
        </select>
      ) : (
        <span className="mv-quiet">On {chosen.name}</span>
      )}
      <button type="button" className="btn s primary" disabled={busy} onClick={() => void add()} data-testid="note-board-add">{busy ? 'Adding…' : 'Add'}</button>
      {error ? <span className="mv-bad" role="alert">{error}</span> : null}
    </span>
  );
}

function ActionRow({ item, slug, meetingId, meetingTitle, added, onAdded, onJump }: { item: MeetingNoteItem; slug: string | null; meetingId: string; meetingTitle: string; added: string | undefined; onAdded: (key: string, boardName: string) => void; onJump: (ms: number) => void }) {
  const [picking, setPicking] = useState(false);
  const key = itemKey(item);
  return (
    <li className="mv-item" data-testid="action-item">
      <span className="mv-item-text">{item.text}</span>
      <span className="mv-item-meta">
        <span className={item.ownerName ? '' : 'mv-quiet'} data-testid="action-owner">{ownerLine(item)}</span>
        <At ms={item.atMs} onJump={onJump} />
      </span>
      {slug ? (
        <span className="mv-item-act">
          {added !== undefined ? (
            <span className="chip ok" data-testid="action-added">{`Added to ${added}`}</span>
          ) : picking ? (
            <AddToBoard key={meetingId} slug={slug} item={item} meetingTitle={meetingTitle} onAdded={(name) => { onAdded(key, name); setPicking(false); }} />
          ) : (
            <button type="button" className="btn s" onClick={() => setPicking(true)} data-testid="action-to-board">Add to board</button>
          )}
        </span>
      ) : null}
    </li>
  );
}

/** What the notes say: the summary, then Decisions, Action items and Questions each with a count. The markdown file is drawn instead when it holds no list. */
export function NotesBody({
  notes,
  meetingId,
  meetingTitle,
  slug,
  added,
  onAdded,
  onJump,
  teamSlug,
}: {
  notes: Pick<MeetingNotes, 'summary' | 'items' | 'notesMd'>;
  meetingId: string;
  meetingTitle: string;
  slug: string | null;
  added: Readonly<Record<string, string>>;
  onAdded: (key: string, boardName: string) => void;
  onJump: (ms: number) => void;
  teamSlug: string | null;
}) {
  if (showsMarkdownOnly(notes)) return <div className="mv-md" data-testid="notes-markdown"><Markdown source={notes.notesMd} teamSlug={teamSlug} /></div>;
  const decisions = decisionsOf(notes.items);
  const actions = actionsOf(notes.items);
  const questions = questionsOf(notes.items);
  return (
    <div className="mv-notes-body">
      {notes.summary.trim() !== '' ? (
        <section aria-label="Summary">
          <h3 className="mv-sub">Summary</h3>
          <p className="mv-summary" data-testid="notes-summary">{notes.summary}</p>
        </section>
      ) : null}
      <section aria-labelledby="mv-decisions" data-testid="notes-decisions">
        <h3 className="mv-sub" id="mv-decisions">{headingWithCount('Decisions', decisions.length)}</h3>
        {decisions.length === 0 ? <p className="mv-quiet">No decisions were noted.</p> : (
          <ul className="mv-items">
            {decisions.map((d) => (
              <li key={itemKey(d)} className="mv-item">
                <span className="mv-item-text">{d.text}</span>
                <span className="mv-item-meta"><At ms={d.atMs} onJump={onJump} /></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="mv-actions" data-testid="notes-actions">
        <h3 className="mv-sub" id="mv-actions">{headingWithCount('Action items', actions.length)}</h3>
        {actions.length === 0 ? <p className="mv-quiet">No action items were noted.</p> : (
          <ul className="mv-items">
            {actions.map((a) => (
              <ActionRow key={itemKey(a)} item={a} slug={slug} meetingId={meetingId} meetingTitle={meetingTitle} added={added[itemKey(a)]} onAdded={onAdded} onJump={onJump} />
            ))}
          </ul>
        )}
      </section>
      {questions.length > 0 ? (
        <section aria-labelledby="mv-questions" data-testid="notes-questions">
          <h3 className="mv-sub" id="mv-questions">{headingWithCount('Open questions', questions.length)}</h3>
          <ul className="mv-items">
            {questions.map((q) => (
              <li key={itemKey(q)} className="mv-item">
                <span className="mv-item-text">{q.text}</span>
                <span className="mv-item-meta"><At ms={q.atMs} onJump={onJump} /></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The notes of one meeting with the buttons after it: Edit notes, Send to memory, Save to team meeting notes. */
export function NotesCard({ overview, notes: first, onJump }: { overview: MeetingOverview; notes: MeetingNotes; onJump: (ms: number) => void }) {
  const meetingId = overview.meeting.id;
  const [notes, setNotes] = useState(first);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'save' | 'memory' | null>(null);
  const [added, setAdded] = useState<Record<string, string>>(() => Object.fromEntries(readDone(meetingId).map((k) => [k, 'the board'])));
  const slug = overview.teamSlug;

  const startEdit = (): void => {
    setDraft(notes.notesMd);
    setError(null);
    setEditing(true);
  };
  const saveEdit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setNotes(await saveMeetingNotes(meetingId, { notesMd: draft, baseUpdatedAt: notes.updatedAt }));
      setEditing(false);
    } catch (e) {
      setError(isConflict(e) ? NOTES_CHANGED : actionFailure(e, 'The notes could not be saved. Your words are still in the box.'));
    } finally {
      setBusy(false);
    }
  };

  if (notes.status === 'pending') {
    return (
      <div className="mv-card" data-testid="notes-pending">
        <p className="mv-note" role="status">{NOTES_PENDING}</p>
        <SkeletonRows rows={3} label="The notes are being written" />
      </div>
    );
  }
  const failed = notes.status === 'failed';
  const filed = notes.memoryItemId !== null;
  const memoryLink = slug ? `/t/${encodeURIComponent(slug)}/memory?tab=inbox` : '/memory?tab=inbox';
  return (
    <div className="mv-card" data-testid="notes-card" data-status={notes.status}>
      {failed ? <p className="dlg-error" role="alert" data-testid="notes-failed">{notes.failure ?? NOTES_FAILED}</p> : null}
      {editing ? (
        <div className="mv-edit">
          <label className="dlg-label" htmlFor="mv-notes-edit">Notes</label>
          <textarea id="mv-notes-edit" className="dlg-input mv-textarea" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="notes-edit" />
          {error ? <p className="dlg-error" role="alert" data-testid="notes-edit-error">{error}</p> : null}
          <div className="mv-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void saveEdit()} data-testid="notes-save">{busy ? 'Saving…' : 'Save notes'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : failed && notes.notesMd.trim() === '' ? null : (
        <NotesBody
          notes={notes}
          meetingId={meetingId}
          meetingTitle={overview.meeting.title}
          slug={slug}
          added={added}
          onAdded={(key, boardName) => {
            const next = { ...added, [key]: boardName };
            setAdded(next);
            writeDone(meetingId, Object.keys(next));
          }}
          onJump={onJump}
          teamSlug={slug}
        />
      )}
      <div className="mv-facts" data-testid="notes-facts">
        {filed ? (
          <p className="mv-fact" data-testid="notes-filed">Filed to memory. <Link to={memoryLink}>See the team’s memory inbox</Link></p>
        ) : null}
        {notes.savedPath ? (
          <p className="mv-fact" data-testid="notes-saved">Saved to the team’s meeting notes at <code title={notes.savedPath}>{friendlyPath(notes.savedPath)}</code></p>
        ) : null}
      </div>
      {!editing ? (
        <div className="mv-actions" data-testid="notes-actions-row">
          {notes.canEdit ? <button type="button" className="btn" onClick={startEdit} data-testid="notes-edit-open">Edit notes</button> : null}
          {notes.canSendToMemory && !filed ? <button type="button" className="btn" onClick={() => setDialog('memory')} data-testid="notes-send-memory">Send to memory</button> : null}
          {notes.canSaveToTeam && !notes.savedPath ? <button type="button" className="btn" onClick={() => setDialog('save')} data-testid="notes-save-team">Save to team meeting notes</button> : null}
        </div>
      ) : null}
      {dialog === 'save' ? (
        <SaveToTeamDialog
          overview={overview}
          onClose={() => setDialog(null)}
          onSaved={(done) => setNotes((n) => ({ ...n, ...done.notes, savedPath: done.notes.savedPath ?? done.path, memoryItemId: done.memoryItemId ?? done.notes.memoryItemId }))}
        />
      ) : null}
      {dialog === 'memory' ? (
        <SendToMemoryDialog
          meetingId={meetingId}
          onClose={() => setDialog(null)}
          onSent={(id) => {
            setNotes((n) => ({ ...n, memoryItemId: id ?? 'sent', canSendToMemory: false }));
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
