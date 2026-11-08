import { useEffect, useRef, useState } from 'react';
import { GetMeetingTranscriptQuery, GetMeetingTranscriptResponse, getMeetingTranscriptRoute } from '@manythreads/shared';
import { call } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonRows } from '../../components/Skeleton';
import { correctSegment, fetchTranscript } from '../../meetings/api';
import { WaveIcon } from '../../meetings/icons';
import { actionFailure, clockWords, lineAt, readFailure, runsOf } from './words';

type Line = GetMeetingTranscriptResponse['lines'][number];

/** A reader the notes were shared with reads the organizer's own copy (`?copy=organizer`); `fetchTranscript` of the meetings client is the room's own transcript. */
const fetchOrganizerCopy = (meetingId: string) =>
  call(getMeetingTranscriptRoute, { request: GetMeetingTranscriptQuery, response: GetMeetingTranscriptResponse }, { copy: 'organizer' }, { meetingId });

/** One line: its time (a button that marks it), the words, and Edit for a line the reader may still correct. */
function LineRow({ line, index, marked, onMark, onEdit, editing, onSave, onCancel }: { line: Line; index: number; marked: boolean; onMark: (ms: number) => void; onEdit: (index: number) => void; editing: boolean; onSave: (index: number, text: string) => Promise<string | null>; onCancel: () => void }) {
  const [text, setText] = useState(line.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className={`mv-line ${marked ? 'hit' : ''} ${line.transcribed ? '' : 'quiet'}`} data-testid="transcript-line" data-start-ms={line.startMs} aria-current={marked ? 'true' : undefined}>
      <button type="button" className="mv-at" onClick={() => onMark(line.startMs)} title="Link to this moment" data-testid="line-time">{clockWords(line.startMs)}</button>
      {editing ? (
        <form
          className="mv-line-edit"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void onSave(index, text).then((problem) => {
              setBusy(false);
              setError(problem);
            });
          }}
        >
          <label className="sr-only" htmlFor={`mv-line-${index}`}>Your words</label>
          <textarea id={`mv-line-${index}`} className="dlg-input" rows={2} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} data-testid="line-edit" />
          {error ? <span className="mv-bad" role="alert">{error}</span> : null}
          <span className="mv-actions">
            <button type="submit" className="btn s primary" disabled={busy || text.trim() === ''}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn s" disabled={busy} onClick={onCancel}>Cancel</button>
          </span>
        </form>
      ) : (
        <>
          <span className="mv-line-text">{line.text}</span>
          {line.editable && line.segmentId ? <button type="button" className="mv-line-edit-btn" onClick={() => onEdit(index)} data-testid="line-edit-open">Edit</button> : null}
        </>
      )}
    </li>
  );
}

/** The lines of a transcript in blocks by speaker. `mark` is the time `?t=` points at: the line it falls in is marked and scrolled to. */
export function TranscriptLines({ lines: first, mark, onMark, meetingId }: { lines: readonly Line[]; mark: number | null; onMark: (ms: number) => void; meetingId: string }) {
  const [lines, setLines] = useState(first);
  const [editing, setEditing] = useState<number | null>(null);
  const marked = mark === null ? -1 : lineAt(lines, mark);
  const box = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (marked < 0) return;
    const row = box.current?.querySelectorAll<HTMLElement>('[data-testid="transcript-line"]')[marked];
    row?.scrollIntoView({ block: 'center' });
  }, [marked, mark]);

  const save = async (index: number, text: string): Promise<string | null> => {
    const line = lines[index];
    if (!line?.segmentId) return 'This line cannot be changed.';
    try {
      await correctSegment(meetingId, line.segmentId, text.trim());
      setLines((all) => all.map((l, i) => (i === index ? { ...l, text: text.trim() } : l)));
      setEditing(null);
      return null;
    } catch (e) {
      return actionFailure(e, 'That line could not be changed. Try again.');
    }
  };

  return (
    <ol className="mv-transcript" ref={box} data-testid="transcript">
      {runsOf(lines).map((run, r) => (
        <li key={`${run.speakerId}:${r}`} className="mv-run">
          <p className="mv-speaker" data-testid="transcript-speaker">{lines[run.lines[0]?.index ?? 0]?.speakerName ?? ''}</p>
          <ol className="mv-run-lines">
            {run.lines.map(({ line, index }) => (
              <LineRow key={`${line.segmentId ?? 'x'}:${line.startMs}:${index}`} line={line} index={index} marked={index === marked} onMark={onMark} onEdit={setEditing} editing={editing === index} onSave={save} onCancel={() => setEditing(null)} />
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** The transcript tab: loads the lines (the organizer's copy for a shared reader) and draws them. */
export function TranscriptView({ meetingId, organizerCopy, mark, onMark, live }: { meetingId: string; organizerCopy: boolean; mark: number | null; onMark: (ms: number) => void; live: boolean }) {
  const q = useQuery(`meeting-transcript:${meetingId}:${organizerCopy ? 'organizer' : 'room'}`, () => (organizerCopy ? fetchOrganizerCopy(meetingId) : fetchTranscript(meetingId)));
  if (q.status === 'loading') return <SkeletonRows rows={6} label="Loading the transcript" />;
  if (q.status === 'error') {
    return (
      <div className="inline-state" role="alert" data-testid="transcript-error">
        <p>{readFailure(q.error)}</p>
        <button type="button" className="btn" onClick={q.reload}>Try again</button>
      </div>
    );
  }
  if (q.data.lines.length === 0) {
    return (
      <div data-testid="transcript-empty">
        <EmptyState icon={WaveIcon} title="There is no transcript">
          {live ? 'Lines appear here as people speak, if they agreed to be transcribed.' : 'Nobody agreed to be transcribed in this meeting, or transcription was off.'}
        </EmptyState>
      </div>
    );
  }
  return <TranscriptLines key={`${meetingId}:${q.data.lines.length}`} lines={q.data.lines} mark={mark} onMark={onMark} meetingId={meetingId} />;
}
