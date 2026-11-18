import { useState } from 'react';
import { isMockMode } from '../../api/setup';
import { ScheduleCalendarIcon } from '../../shell/icons';
import { notifyScheduledChanged } from './changed';
import { ScheduleRoomDialog } from './ScheduleRoomDialog';

/** "Schedule a room" in a channel's header (P33-01): a calendar icon like its neighbours; it opens the dialog that plans a room for later. */
export function ScheduleButton({ channelId, channelLabel }: { channelId: string; channelLabel?: string }) {
  const [dialog, setDialog] = useState(false);
  if (isMockMode()) return null;
  return (
    <>
      <button type="button" className="icon-btn chv-tool chv-schedule" data-testid="schedule-open" title="Schedule a room: plan a voice room for later" aria-label="Schedule a room" aria-haspopup="dialog" onClick={() => setDialog(true)}>
        <ScheduleCalendarIcon />
      </button>
      {dialog ? (
        <ScheduleRoomDialog
          channelId={channelId}
          {...(channelLabel ? { channelLabel } : {})}
          onClose={() => setDialog(false)}
          onCreated={() => {
            setDialog(false);
            notifyScheduledChanged(channelId);
          }}
        />
      ) : null}
    </>
  );
}
