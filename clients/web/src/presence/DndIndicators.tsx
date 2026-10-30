import { Link } from 'react-router';
import { MoonIcon } from '../shell/icons';
import { useMyDnd } from './hooks';
import { resumeNow, useSaver } from './PresencePanels';

/**
 * The paused state read aloud. One polite live region for the whole shell: it sits outside the sidebar (which is hidden from screen readers while
 * the phone's drawer is closed) and says "Paused until 14:30" when Do not disturb starts and nothing when it ends is left to the visible state.
 */
export function DndLive() {
  const { banner } = useMyDnd();
  return (
    <div className="sr-only" role="status" data-testid="dnd-live">
      {banner ? banner.text : ''}
    </div>
  );
}

/** A line above the account row in the sidebar while Do not disturb is on: the words, and "Resume now" (or the schedule, for quiet hours). */
export function DndStrip() {
  const { banner } = useMyDnd();
  const resume = useSaver();
  if (!banner) return null;
  return (
    <div className="dnd-strip" data-testid="dnd-strip" data-reason={banner.reason}>
      <span className="dnd-strip-ic" aria-hidden="true"><MoonIcon /></span>
      <span className="dnd-strip-text" data-vt-mask>{banner.text}</span>
      {banner.canResume ? (
        <button type="button" className="link-btn" data-testid="strip-resume" disabled={resume.busy} onClick={() => void resume.run(resumeNow)}>Resume now</button>
      ) : (
        <Link className="link-btn" to="/account#status-and-dnd">Change</Link>
      )}
      {resume.error ? <span className="dnd-strip-error" role="alert">{resume.error}</span> : null}
    </div>
  );
}
