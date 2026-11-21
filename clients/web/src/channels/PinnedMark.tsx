import { PinMarkIcon } from '../shell/icons';
import type { People } from './hooks';

/** "Pinned" beside the author's name on a pinned message (P31-07), with who pinned it in the tooltip when the roster knows them. */
export function PinnedMark({ by, people }: { by: string | null; people: People }) {
  const who = by ? (people.byActor(by)?.name ?? people.botName?.(by)) : undefined;
  return (
    <span className="msg-pinned" data-testid="pinned-mark" title={who ? `Pinned by ${who}` : 'Pinned to the channel'}>
      <PinMarkIcon /> Pinned
    </span>
  );
}
