import type { BridgeProvider } from '@manythreads/shared';
import '../styles/bridges.css';
import { PROVIDER_LABEL } from '../screens/bridges/words';

/**
 * The small "via Telegram" note after an author's name on a message that came across a chat bridge (PLAN Bundle D, P16-09, decision Q6). The name is the person's own: they linked their
 * account, so the message is theirs; the note only says where it was written.
 */
export function MessageVia({ via }: { via: { provider: BridgeProvider } }) {
  return <span className="br-via" data-testid="message-via" title={`Written in ${PROVIDER_LABEL[via.provider]}`}>via {PROVIDER_LABEL[via.provider]}</span>;
}
