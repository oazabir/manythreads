import { badgeText } from './unreadLook';

/** The count badge of a sidebar row: `quiet` is grey, `attention` amber (something waited too long), `mention` red (someone wrote to you). */
export type PillTone = 'unread' | 'quiet' | 'attention' | 'mention';

export function Pill({ n, tone }: { n: number; tone: PillTone }) {
  const cls = tone === 'quiet' ? 'g' : tone === 'attention' ? 'attention' : tone === 'mention' ? 'mention' : '';
  return <span className={`pill ${cls}`} data-vt-mask>{badgeText(n)}</span>;
}
