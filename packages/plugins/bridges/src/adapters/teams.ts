import type { BridgeAdapter } from '../adapter.ts';
import { notBuilt } from '../not-built.ts';

// Work package B2 (P16-09): the Teams adapter. STUB: it trusts no request (every verify fails) and reads nothing, so an account switched on before this is built hears nothing.
export const teamsAdapter: BridgeAdapter = {
  provider: 'teams',
  verify: () => ({ ok: false, reason: 'bad_signature' }),
  parse: () => [],
  send: async () => notBuilt(),
};
