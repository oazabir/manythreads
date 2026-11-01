import { useState } from 'react';
import { useShell } from './context';
import { FULL_STARS_TEXT, isStarred, starPatch } from './sidebarLayout';
import { sidebarPrefsStore, useSidebarPrefs } from './sidebarPrefsStore';
import { StarIcon } from './icons';

/**
 * The star in a team channel's header: marks the channel as one of the person's starred channels, which the sidebar lists in its own group at the
 * top. Absent for a direct message, for a guest, and where the server has no sidebar settings. On a phone it is hidden to leave room for the title;
 * the channel's row in the sidebar offers the same choice.
 */
export function ChannelStar({ channelId, channelName, teamSlug }: { channelId: string; channelName: string; teamSlug: string }) {
  const { guest } = useShell();
  const entry = useSidebarPrefs(teamSlug, !guest);
  const [problem, setProblem] = useState<string | null>(null);
  if (guest || entry.status !== 'ok') return null;
  const starred = isStarred(entry.prefs.starred, channelId);
  const toggle = (): void => {
    const patch = starPatch(entry.prefs.starred, channelId, !starred);
    if (!patch) {
      setProblem(FULL_STARS_TEXT);
      return;
    }
    setProblem(null);
    sidebarPrefsStore.update(teamSlug, patch).catch((e: unknown) => setProblem(e instanceof Error ? e.message : 'Could not save your sidebar. Try again.'));
  };
  return (
    <div className="sb-star-head">
      <button
        type="button"
        className={`icon-btn ${starred ? 'sb-starred' : ''}`}
        aria-pressed={starred}
        aria-label={starred ? `Remove the star from #${channelName}` : `Star #${channelName}`}
        title={starred ? 'Starred. Click to remove the star.' : 'Star this channel to keep it at the top of your sidebar'}
        data-testid="channel-star"
        onClick={toggle}
      >
        <StarIcon filled={starred} />
      </button>
      {problem ? <span className="sb-star-problem" role="alert">{problem}</span> : null}
    </div>
  );
}
