import { badgeText } from './unreadLook';

/** The count badge of a sidebar row: `quiet` is grey, `attention` amber (something waited too long), `mention` red (someone wrote to you). */
export type PillTone = 'unread' | 'quiet' | 'attention' | 'mention';

/** `note` is words for what the colour means, read by a screen reader and shown as the tooltip (colour is never the only signal). */
export function Pill({ n, tone, note }: { n: number; tone: PillTone; note?: string }) {
  const cls = tone === 'quiet' ? 'g' : tone === 'attention' ? 'attention' : tone === 'mention' ? 'mention' : '';
  return (
    <span className={`pill ${cls}`} data-vt-mask title={note}>
      {badgeText(n)}
      {note ? <span className="sr-only">, {note}</span> : null}
    </span>
  );
}
