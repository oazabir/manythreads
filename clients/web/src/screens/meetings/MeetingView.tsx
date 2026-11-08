import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { MeetingOverview } from '@manythreads/shared';
import { fileContentUrl } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { ActorAvatar } from '../../components/ActorAvatar';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { fetchMeetingNotes, fetchMeetingOverview, fetchRecording } from '../../meetings/api';
import { PhoneIcon } from '../../meetings/icons';
import { useOpenMessage } from '../../shell/messageLink';
import { searchStamp } from '../../search/stamp';
import { NotesCard } from './NotesCard';
import { ShareDialog } from './ShareDialog';
import { TranscriptView } from './TranscriptView';
import { isMissing, lengthWords, parseJump, peopleWords, readFailure, readsOrganizerCopy, tabFor } from './words';

type Tab = 'notes' | 'transcript';
/** A meeting whose notes are still being written is asked about again this often, and for this long. */
const PENDING_POLL_MS = 10_000;
const PENDING_POLL_MAX = 30;

/** The audio of a meeting that was recorded, one file for each person who agreed; or "(no audio)". */
function Recording({ overview }: { overview: MeetingOverview }) {
  const has = overview.hasAudio;
  const q = useQuery(`meeting-recording:${overview.meeting.id}:${has}`, () => (has ? fetchRecording(overview.meeting.id) : Promise.resolve(null)));
  if (!has) return <span className="mv-quiet" data-testid="meeting-no-audio">(no audio)</span>;
  if (q.status === 'loading') return <span className="mv-quiet" role="status" aria-busy="true">Loading the recording…</span>;
  const files = q.status === 'ok' && q.data ? q.data.files.filter((f) => f.fileId !== null) : [];
  if (files.length === 0) return <span className="mv-quiet" data-testid="meeting-no-audio">(no audio)</span>;
  return (
    <span className="mv-recording" data-testid="meeting-recording">
      {files.map((f) => {
        const name = overview.people.find((p) => p.actorId === f.actorId)?.displayName ?? 'Someone';
        return (
          <span key={f.id} className="mv-audio">
            <span className="mv-audio-name">{name}</span>
            <audio controls preload="none" src={fileContentUrl(f.fileId ?? '')} aria-label={`Recording of ${name}`} />
          </span>
        );
      })}
    </span>
  );
}

function People({ overview }: { overview: MeetingOverview }) {
  return (
    <ul className="mv-people" aria-label="People" data-testid="meeting-people">
      {overview.people.map((p) => (
        <li key={p.actorId} className={`mv-person ${p.transcribed ? '' : 'quiet'}`}>
          <ActorAvatar actorId={p.actorId} name={p.displayName} />
          <span className="mv-person-name">{p.displayName}</span>
          {p.transcribed ? null : <span className="mv-person-note">not transcribed</span>}
        </li>
      ))}
    </ul>
  );
}

function Loaded({ overview }: { overview: MeetingOverview }) {
  const meetingId = overview.meeting.id;
  const [params, setParams] = useSearchParams();
  const mark = parseJump(params.get('t'));
  const [tab, setTab] = useState<Tab>(() => tabFor(mark, 'notes'));
  // a citation or search result for another moment of this same meeting changes `?t=` without leaving the page: show the transcript there
  useEffect(() => {
    setTab((current) => tabFor(mark, current));
  }, [mark]);
  const [sharing, setSharing] = useState(false);
  const open = useOpenMessage();
  const notes = useQuery(`meeting-notes:${meetingId}`, () => fetchMeetingNotes(meetingId));
  const reloadNotes = notes.reload;
  const pending = notes.status === 'ok' && notes.data.status === 'pending';
  const live = overview.meeting.state === 'live';

  // notes still being written: look again for a while
  useEffect(() => {
    if (!pending) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > PENDING_POLL_MAX) clearInterval(timer);
      else reloadNotes();
    }, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reloadNotes]);

  const jump = (ms: number): void => {
    setTab('transcript');
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('t', String(ms));
      return next;
    }, { replace: true });
  };

  const stamp = searchStamp(overview.meeting.startedAt);
  const canShare = notes.status === 'ok' && notes.data.canShare;
  const thread = overview.thread;

  return (
    <div className="mv-screen meeting-view" data-testid="meeting-view" data-meeting-id={meetingId} data-at-ms={mark ?? undefined}>
      <PageHeader
        title={overview.meeting.title}
        description={
          <span data-testid="meeting-facts">
            <time dateTime={overview.meeting.startedAt} data-vt-mask>{stamp}</time>
            {` · ${lengthWords(overview.durationSeconds)} · ${peopleWords(overview.people.length)}`}
            {overview.channelName ? ` · # ${overview.channelName}` : ''}
          </span>
        }
        actions={canShare ? <button type="button" className="btn" onClick={() => setSharing(true)} data-testid="meeting-share">Share</button> : undefined}
      />
      {live ? <p className="mv-banner" role="status" data-testid="meeting-live">This call is still going. The notes appear a couple of minutes after it ends.</p> : null}
      <People overview={overview} />
      <div className="mv-links" data-testid="meeting-links">
        {thread ? (
          <button
            type="button"
            className="btn s"
            data-testid="meeting-thread"
            onClick={() => void open({ channelId: thread.channelId, channelKind: overview.teamSlug ? 'channel' : 'dm', channelName: overview.channelName, messageId: thread.rootId, threadRootId: thread.rootId })}
          >
            Open the thread
          </button>
        ) : null}
        <span className="mv-link-recording"><b>Recording</b> <Recording overview={overview} /></span>
        {overview.notetaker ? <span className="mv-quiet" data-testid="meeting-notetaker">{`Note-taker: ${overview.notetaker.name}`}</span> : null}
      </div>
      <div className="mv-tabs" role="tablist" aria-label="Meeting">
        <button type="button" role="tab" id="mv-tab-notes" aria-selected={tab === 'notes'} aria-controls="mv-panel-notes" className={`mv-tab ${tab === 'notes' ? 'on' : ''}`} onClick={() => setTab('notes')} data-testid="meeting-tab-notes">Notes</button>
        <button type="button" role="tab" id="mv-tab-transcript" aria-selected={tab === 'transcript'} aria-controls="mv-panel-transcript" className={`mv-tab ${tab === 'transcript' ? 'on' : ''}`} onClick={() => setTab('transcript')} data-testid="meeting-tab-transcript">Transcript</button>
      </div>
      {tab === 'notes' ? (
        <section role="tabpanel" id="mv-panel-notes" aria-labelledby="mv-tab-notes" className="mv-panel">
          {notes.status === 'loading' ? <SkeletonRows rows={4} label="Loading the notes" /> : null}
          {notes.status === 'error' && isMissing(notes.error) ? (
            <div data-testid="notes-none">
              <EmptyState icon={PhoneIcon} title="There are no notes yet">Notes are written after a call that was transcribed. Check the transcript for what was said.</EmptyState>
            </div>
          ) : null}
          {notes.status === 'error' && !isMissing(notes.error) ? (
            <div className="inline-state" role="alert" data-testid="notes-error">
              <p>{readFailure(notes.error)}</p>
              <button type="button" className="btn" onClick={notes.reload}>Try again</button>
            </div>
          ) : null}
          {notes.status === 'ok' ? <NotesCard key={notes.data.updatedAt} overview={overview} notes={notes.data} onJump={jump} /> : null}
        </section>
      ) : (
        <section role="tabpanel" id="mv-panel-transcript" aria-labelledby="mv-tab-transcript" className="mv-panel">
          <TranscriptView meetingId={meetingId} organizerCopy={readsOrganizerCopy(overview)} mark={mark} onMark={jump} live={live} />
        </section>
      )}
      {sharing ? <ShareDialog overview={overview} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}

/**
 * The page of one voice-room meeting at /meetings/:meetingId (PLAN P15-20, decision C22): title, date, length and people, the notes with their decisions and action items,
 * the transcript, the thread and the recording, Share and Save to team. `?t=<ms>` opens the transcript at that moment. Whether a person may read it at all is the server's
 * answer: a meeting they have no access to looks the same as one that does not exist.
 */
export function MeetingView() {
  const { meetingId = '' } = useParams();
  const [params] = useSearchParams();
  const overview = useQuery(`meeting-overview:${meetingId}`, () => fetchMeetingOverview(meetingId));
  if (overview.status === 'loading') {
    return (
      <div className="mv-screen meeting-view" data-meeting-id={meetingId} data-at-ms={params.get('t') ?? undefined}>
        <PageHeader title="Meeting" />
        <SkeletonRows rows={5} label="Loading the meeting" />
      </div>
    );
  }
  if (overview.status === 'error') {
    return (
      <div className="mv-screen meeting-view" data-meeting-id={meetingId} data-at-ms={params.get('t') ?? undefined}>
        <PageHeader title="Meeting" />
        <div data-testid="meeting-error" role="alert">
          <EmptyState
            icon={PhoneIcon}
            title={isMissing(overview.error) ? 'This meeting is not available' : 'This meeting could not be loaded'}
            {...(isMissing(overview.error) ? {} : { action: { label: 'Try again', onClick: overview.reload } })}
          >
            {readFailure(overview.error)}
          </EmptyState>
        </div>
      </div>
    );
  }
  return <Loaded key={overview.data.meeting.id} overview={overview.data} />;
}
