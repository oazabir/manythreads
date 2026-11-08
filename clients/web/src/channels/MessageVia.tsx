import type { BridgeProvider } from '@manythreads/shared';

/**
 * The small "via Telegram" note after an author's name on a message that came across a chat bridge (PLAN Bundle D, P16-09, decision Q6). Work package B1 draws it; until then it draws nothing,
 * so a message looks as it did.
 */
export function MessageVia({ via }: { via: { provider: BridgeProvider } }) {
  void via;
  return null;
}
