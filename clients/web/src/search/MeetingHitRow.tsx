import type { SearchMeetingHit } from '@manythreads/shared';
import { useNavigate } from 'react-router';
import { clockWords } from '../screens/meetings/words';
import { searchStamp } from './stamp';
import { Highlight } from './SearchHighlight';

/** Where a meeting hit opens: the meeting page, at the moment of the line (the top for a hit in the notes). */
export const meetingHitHref = (h: Pick<SearchMeetingHit, 'meetingId' | 'atMs' | 'where'>): string =>
  `/meetings/${encodeURIComponent(h.meetingId)}${h.where === 'transcript' && h.atMs > 0 ? `?t=${String(h.atMs)}` : ''}`;

/** The line above a hit's words: the meeting's channel, who said it and when in the call, or that it is in the notes. */
export function meetingHitWhere(h: Pick<SearchMeetingHit, 'where' | 'speakerName' | 'atMs'>): string {
  if (h.where === 'notes') return 'In the notes';
  return `${h.speakerName ?? 'Someone'} at ${clockWords(h.atMs)}`;
}

const channelWords = (c: SearchMeetingHit['channel']): string => (c === null ? 'Meeting' : c.kind === 'channel' ? `#${(c.name ?? '').replace(/^#/, '')}` : 'Direct message');

/** One search result for kind `meeting` (PLAN P15-13): the title, where in the meeting the words are, and the words with the search terms marked. */
export function MeetingHitRow({ hit, words }: { hit: SearchMeetingHit; words: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="hit hit-meeting" data-testid="search-hit" data-kind="meeting" onClick={() => void navigate(meetingHitHref(hit))}>
      <span className="hit-where">
        <span className="hit-ch">{channelWords(hit.channel)}</span>
        <span>{hit.title}</span>
        <time dateTime={hit.startedAt} data-vt-mask>{searchStamp(hit.startedAt)}</time>
      </span>
      <span className="hit-meeting-who">{meetingHitWhere(hit)}</span>
      <span className="hit-snip"><Highlight text={hit.snippet} query={words} /></span>
    </button>
  );
}
