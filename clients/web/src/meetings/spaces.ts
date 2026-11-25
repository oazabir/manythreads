import { useEffect } from 'react';
import { useQuery } from '../app/useQuery';
import { fetchMeetingSpaces } from './api';

/* The meeting spaces of the person (P36-03): the Chat page lists them, the sidebar's Chat entry shows a dot for the live ones, and both ask again when one is opened. */
const CHANGED = 'mt:meeting-spaces-changed';
export const notifyMeetingSpacesChanged = (): void => {
  window.dispatchEvent(new Event(CHANGED));
};

export function useMeetingSpaces() {
  const q = useQuery('meeting-spaces', fetchMeetingSpaces);
  const reload = q.reload;
  useEffect(() => {
    const on = (): void => reload();
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [reload]);
  return q;
}
