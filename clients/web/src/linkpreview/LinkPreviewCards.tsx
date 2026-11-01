import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { linkPreviewImagePath, type LinkPreview } from '@manythreads/shared';
import { linkPreviewStore, type MessageCards } from './store';

/*
 * The cards under a message that carries a link (PLAN P14-08, docs/plugins/link-preview.md): the site, the title, a short description and the
 * picture, which comes from this server (the browser never contacts the linked site). The author sees a remove button. The card has a fixed height
 * and a picture slot of fixed size, so a picture that decodes late changes nothing; a row asks for its cards while it mounts and keeps the room
 * for one card until the answer, so cards that are already made arrive without moving the rows below. For a message that is new and has a link no
 * card exists for yet the server says `pending` and the room is kept a little longer (the card replaces it at the same size); a server that reads no
 * links keeps no room at all. A card that comes after the room was given back fades in; the row grows once.
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

function Card({ card }: { card: LinkPreview }) {
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
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
    <div className="lp-card" data-testid="link-preview" role="group" aria-label={`Link preview: ${label}`}>
      <a className="lp-link" href={card.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        <span className="lp-text">
          <span className="lp-host">
            {/* the real host first: the site name is what the page says about itself and may say anything */}
            {card.host}
            {card.siteName && card.siteName.toLowerCase() !== card.host ? ` · ${card.siteName}` : ''}
          </span>
          {card.title ? <span className="lp-title">{card.title}</span> : null}
          {card.description ? <span className="lp-desc">{card.description}</span> : null}
        </span>
        {card.hasImage && !broken ? (
          <img className="lp-img" src={linkPreviewImagePath(card.id)} alt="" width={88} height={88} loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : null}
      </a>
      {card.canRemove ? (
        <button type="button" className="lp-x" aria-label={`Remove the preview of ${card.host}`} title="Remove preview" data-testid="link-preview-remove" onClick={() => void remove()}>
          <span aria-hidden="true">×</span>
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
export const LinkPreviewCards = memo(function LinkPreviewCards({ channelId, messageId, body, enabled }: { channelId: string; messageId: string; body: string; enabled: boolean }) {
  const { cards, pending } = useLinkPreviews(channelId, messageId, body, enabled);
  if (cards.length === 0) return pending ? <div className="lp-slot" aria-hidden="true" data-testid="link-preview-slot" /> : null;
  return (
    <div className="lp-cards" data-testid="link-previews">
      {cards.map((c) => (
        <Card key={c.id} card={c} />
      ))}
    </div>
  );
});
