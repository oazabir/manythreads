import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { linkPreviewImagePath, type LinkPreview } from '@manythreads/shared';
import { linkPreviewStore, type MessageCards } from './store';
import { CloseIcon } from '../shell/icons';
import { allShownAbove, messageLinks, splitLinksAbove, type LinksAbove } from './dedupe';

/*
 * The cards under a message that carries a link (PLAN P14-08, docs/plugins/link-preview.md): the site, the title, a short description and the
 * picture, which comes from this server (the browser never contacts the linked site). The author sees a remove button. The card has a fixed height
 * and a picture slot of fixed size, so a picture that decodes late changes nothing; a row asks for its cards while it mounts and keeps the room
 * for one card until the answer, so cards that are already made arrive without moving the rows below. For a message that is new and has a link no
 * card exists for yet the server says `pending` and the room is kept a little longer (the card replaces it at the same size); a server that reads no
 * links keeps no room at all. A card that comes after the room was given back fades in; the row grows once.
 *
 * P34-04: a link an earlier message of the thread (or of the author's run in a channel) carries gets no second card (`dedupe.ts`); a page with only a
 * title draws one line, centred in the room the list keeps (the list cannot know in advance that the card will be short, so the room stays 96 px and no
 * row moves); the description is clamped by whole lines, one when the title takes two. The × takes the card off the message for everyone.
 */

const HAS_LINK = /https?:\/\//i;
const IDLE: MessageCards = { cards: [], pending: false };

/** The cards of one message, asked for while the row shows it. Nothing is asked for a message without a link in its text. */
export function useLinkPreviews(channelId: string, messageId: string, body: string, enabled: boolean): MessageCards {
  const asks = enabled && HAS_LINK.test(body);
  useEffect(() => (asks ? linkPreviewStore.want(channelId, messageId) : undefined), [asks, channelId, messageId]);
  const subscribe = useCallback((listener: () => void) => linkPreviewStore.subscribe(messageId, listener), [messageId]);
  const read = useCallback(() => linkPreviewStore.cardsOf(messageId), [messageId]);
  const state = useSyncExternalStore(subscribe, read);
  return asks ? state : IDLE;
}

/** `line`: a page with nothing but a title (no description, no picture that draws) is one line; `full`: the 94 px card. */
export const cardShape = (card: Pick<LinkPreview, 'description' | 'hasImage'>, imageBroken = false): 'line' | 'full' =>
  card.description === null || card.description.trim() === '' ? (card.hasImage && !imageBroken ? 'full' : 'line') : 'full';

/** How many whole lines of description fit under a title of `titleLines` lines in the 94 px card. */
export const descLines = (titleLines: number): 1 | 2 => (titleLines >= 2 ? 1 : 2);

/** How many lines the title draws (1 or 2, it is clamped at two); measured, since only the browser knows where the words wrap. */
function useTitleLines(el: RefObject<HTMLElement | null>, watch: boolean, text: string | null): number {
  const [lines, setLines] = useState(1);
  useLayoutEffect(() => {
    const node = el.current;
    if (!watch || !node) return undefined;
    const measure = (): void => {
      const lh = parseFloat(getComputedStyle(node).lineHeight);
      if (!(lh > 0)) return;
      setLines(node.getBoundingClientRect().height > lh * 1.5 ? 2 : 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, watch, text]);
  return lines;
}

/** One card (exported for its tests). */
export function Card({ card }: { card: LinkPreview }) {
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const shape = cardShape(card, broken);
  const titleLines = useTitleLines(titleRef, shape === 'full' && card.title !== null && card.description !== null, card.title);
  const label = card.title ?? card.siteName ?? card.host;
  const remove = async (): Promise<void> => {
    setError(null);
    try {
      await linkPreviewStore.remove(card);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The preview could not be removed.');
    }
  };
  return (
    <div className={shape === 'line' ? 'lp-card lp-line' : 'lp-card'} data-testid="link-preview" data-shape={shape} role="group" aria-label={`Link preview: ${label}`}>
      <a className="lp-link" href={card.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        <span className="lp-text">
          <span className="lp-host">
            {/* the real host first: the site name is what the page says about itself and may say anything */}
            {card.host}
            {card.siteName && card.siteName.toLowerCase() !== card.host ? ` · ${card.siteName}` : ''}
          </span>
          {card.title ? (
            <span className="lp-title" ref={titleRef}>
              {card.title}
            </span>
          ) : null}
          {card.description ? <span className={descLines(titleLines) === 1 ? 'lp-desc lp-desc-1' : 'lp-desc'}>{card.description}</span> : null}
        </span>
        {card.hasImage && !broken ? (
          <img className="lp-img" src={linkPreviewImagePath(card.id)} alt="" width={88} height={88} loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : null}
      </a>
      {card.canRemove ? (
        <button type="button" className="lp-x" aria-label={`Remove the preview of ${card.host}`} title="Remove preview" data-testid="link-preview-remove" onClick={() => void remove()}>
          <CloseIcon size={12} />
        </button>
      ) : null}
      {error ? (
        <p className="lp-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The cards of a message, or room for them while they are being asked for. Renders nothing for a message without a link. */
export const LinkPreviewCards = memo(function LinkPreviewCards({
  channelId,
  messageId,
  body,
  enabled,
  linksAbove = '',
}: {
  channelId: string;
  messageId: string;
  body: string;
  enabled: boolean;
  /** The links shown above in this thread or run: no second card for them, and nothing asked when every link of the message is one. */
  linksAbove?: LinksAbove;
}) {
  const above = useMemo(() => splitLinksAbove(linksAbove), [linksAbove]);
  const own = useMemo(() => (above.size === 0 ? [] : messageLinks(body)), [above, body]);
  const state = useLinkPreviews(channelId, messageId, body, enabled && !allShownAbove(own, above));
  // A message with a new link next to a repeated one shows all its cards: dropping the repeated card could leave nothing in the room the row already
  // reserved while it asked (the new link may get no card), and the row would shrink after it was drawn (P34-04 review).
  const cards = state.cards;
  if (cards.length === 0) return state.pending ? <div className="lp-slot" aria-hidden="true" data-testid="link-preview-slot" /> : null;
  return (
    <div className="lp-cards" data-testid="link-previews">
      {cards.map((c) => (
        <Card key={c.id} card={c} />
      ))}
    </div>
  );
});
