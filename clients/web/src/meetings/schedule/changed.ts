/**
 * A room was planned in this tab (the Schedule a room button in the header, or the same item in the channel details menu on a phone): the planned-room chip asks again
 * at once, as it would when the server's push arrives. Plain browser event, so the button and the chip need not know each other.
 */
const EVENT = 'mt:scheduled-changed';

export function notifyScheduledChanged(channelId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: channelId }));
}

export function onScheduledChangedHere(channelId: string, fn: () => void): () => void {
  const on = (e: Event): void => {
    if ((e as CustomEvent<string>).detail === channelId) fn();
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
