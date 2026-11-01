import { badgeText } from './unreadLook';

/** The count badge of a sidebar row; `quiet` is the grey one. */
export function Pill({ n, tone }: { n: number; tone: 'unread' | 'quiet' }) {
  return <span className={`pill ${tone === 'quiet' ? 'g' : ''}`} data-vt-mask>{badgeText(n)}</span>;
}
