import { useEffect, useRef, useState } from 'react';
import type { ReactionSummary } from '@manythreads/shared';
import { fetchReactors } from '../api/endpoints';
import { EmojiGlyph } from './EmojiGlyph';
import { reactorsText } from './messageActions';
import type { People } from './hooks';

/** The answers already fetched, by message, emoji and count: a new reaction changes the count and so asks again. */
const known = new Map<string, readonly string[]>();

/** One reaction under a message. Hovering or focusing it for a moment says who reacted (P21-02); nothing is asked while the pointer only passes. */
export function ReactionPill({ channelId, messageId, reaction: r, people, selfActor, canPost, onToggle }: {
  channelId: string;
  messageId: string;
  reaction: ReactionSummary;
  people: People;
  selfActor: string | null;
  canPost: boolean;
  onToggle: () => void;
}) {
  const [tip, setTip] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // the pointer or focus is still on the pill: an answer that comes back after it left must not open the tip
  const over = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const key = `${messageId}|${r.emoji}|${r.count}`;
  const say = (actors: readonly string[]): void => {
    // a reader without a roster (a guest) cannot name anybody: only the count is said
    const names = people.list.length === 0 ? [] : actors.map((a) => (a === selfActor ? 'You' : people.byActor(a)?.name)).filter((n): n is string => n !== undefined);
    setTip(reactorsText(names, r.count, r.emoji));
  };
  const open = (): void => {
    over.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const cached = known.get(key);
      if (cached) return say(cached);
      void fetchReactors(channelId, messageId, r.emoji)
        .then((res) => {
          const actors = res.reactors.map((x) => x.actorId as string);
          known.set(key, actors);
          if (alive.current && over.current) say(actors);
        })
        .catch(() => undefined);
    }, 300);
  };
  const close = (): void => {
    over.current = false;
    if (timer.current) clearTimeout(timer.current);
    setTip(null);
  };
  return (
    <span className="rx-wrap" onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
      <button
        type="button"
        className={`rx ${r.mine ? 'mine' : ''}`}
        aria-pressed={r.mine}
        aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
        disabled={!canPost}
        onClick={onToggle}
      >
        <span aria-hidden="true"><EmojiGlyph value={r.emoji} /></span> <span className="rx-n" data-vt-mask>{r.count}</span>
      </button>
      {tip ? <span className="rx-tip" role="tooltip" data-vt-mask>{tip}</span> : null}
    </span>
  );
}
