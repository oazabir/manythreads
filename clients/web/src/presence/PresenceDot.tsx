import { useCanShowPresence, usePresenceCard } from './hooks';
import { dotEmoji, dotLabel } from './profileModel';
import { statusNow } from './format';

/**
 * The small mark beside a person's name (PLAN P14-01): a dot that says Active (filled), Away (half filled) or Offline (an empty ring), and, when `status` is
 * set, the emoji of their custom status (one picture at most). The tooltip and the accessible name say the same in words, so a list option or a link that
 * contains the dot has them in its own name. Only for people: never draw it beside a bot (a bot has no heartbeat, and the roster shows a bot's availability
 * its own way). It draws nothing until the cards have arrived (an unknown answer is not "Offline"), nothing while the last few rounds failed, nothing on a
 * server without the presence plugin and, for a guest, nothing beside anybody but themself (the server serves a guest only their own card).
 * Every dot reads only its own person's card, which the shell fetches once for everybody (no request per row).
 */
export function PresenceDot({ personId, status = false }: { personId: string | null | undefined; status?: boolean }) {
  const show = useCanShowPresence(personId);
  const card = usePresenceCard(personId);
  if (!show) return null;
  const now = new Date();
  const label = dotLabel(card, now);
  const emoji = status ? dotEmoji(statusNow(card, now)) : null;
  return (
    <span className="pdot-wrap" data-testid="presence-dot" data-presence={card?.presence ?? 'offline'} title={label} role="img" aria-label={label} data-vt-mask>
      <span className="pdot" aria-hidden="true" />
      {emoji ? <span className="pdot-emoji" aria-hidden="true">{emoji}</span> : null}
    </span>
  );
}
