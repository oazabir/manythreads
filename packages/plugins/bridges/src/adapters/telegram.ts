import type { BridgeAdapter } from '../adapter.ts';
import { notBuilt } from '../not-built.ts';

// Work package B1 (P16-09): the Telegram adapter. STUB: it trusts no request (every verify fails) and reads nothing, so an account switched on before this is built hears nothing.
export const telegramAdapter: BridgeAdapter = {
  provider: 'telegram',
  verify: () => ({ ok: false, reason: 'bad_signature' }),
  parse: () => [],
  send: async () => notBuilt(),
};
