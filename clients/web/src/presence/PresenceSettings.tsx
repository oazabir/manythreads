import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Alert } from '../components/ui';
import { useMyDnd } from './hooks';
import { HoursEditor, PauseControls, PausedNote, ScheduleEditor, StatusEditor, resumeNow, useSaver } from './PresencePanels';
import { presenceStore } from './store';

export const PRESENCE_SECTION_ID = 'status-and-dnd';

/**
 * "Status and Do not disturb" in the account settings (PLAN P14-01): a custom status, pausing notifications, the weekly quiet-hours schedule, the
 * time zone and working hours. Nothing is drawn on a server without the presence plugin.
 */
export function PresenceSettings() {
  const dnd = useMyDnd();
  const loc = useLocation();
  const resume = useSaver();
  useEffect(() => {
    void presenceStore.loadMe();
  }, []);
  // a link to /account#status-and-dnd scrolls here once the section exists (it is drawn after the first answer)
  const ready = dnd.me !== null;
  useEffect(() => {
    if (ready && loc.hash === `#${PRESENCE_SECTION_ID}`) document.getElementById(PRESENCE_SECTION_ID)?.scrollIntoView({ block: 'start' });
  }, [ready, loc.hash]);

  // nothing is drawn until the server has answered, so a server without the plugin never flashes the heading (a failed read still says so)
  if (dnd.status === 'absent' || (dnd.me === null && dnd.status !== 'error')) return null;
  const me = dnd.me;
  return (
    <section className="block" id={PRESENCE_SECTION_ID} aria-labelledby="acc-presence" data-landmark="presence" data-testid="presence-settings">
      <h2 className="bh" id="acc-presence">Status and Do not disturb</h2>
      <div className="block-body pr">
        {me === null ? (
          <Alert>Could not load your status settings. <button type="button" className="link-btn" onClick={() => void presenceStore.loadMe()}>Try again</button></Alert>
        ) : (
          <>
            <div role="status" data-testid="paused-live">
              {dnd.banner ? <PausedNote banner={dnd.banner} onResume={() => void resume.run(resumeNow)} busy={resume.busy} error={resume.error} /> : null}
            </div>
            <div className="pr-part">
              <h3 className="pr-h">Status</h3>
              <StatusEditor me={me} />
            </div>
            <div className="pr-part">
              <h3 className="pr-h">Pause notifications</h3>
              <PauseControls banner={null} />
            </div>
            <div className="pr-part">
              <h3 className="pr-h">Weekly schedule</h3>
              <ScheduleEditor me={me} />
            </div>
            <div className="pr-part">
              <h3 className="pr-h">Time zone and working hours</h3>
              <HoursEditor me={me} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
