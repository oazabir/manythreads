import type { PluginContext, PluginTx } from '@manythreads/sdk';

/** Identity audit events (kept in app.events until the phase 10 console). Emitted in the caller's transaction. */
export const AUDIT_EVENTS = [
  'identity.session.signed_in',
  'identity.session.sign_in_failed',
  'identity.session.signed_out',
  'identity.workspace.bootstrapped',
  'identity.password.reset',
  'identity.email.verified',
] as const;

export function emitAudit(ctx: PluginContext, tx: PluginTx, event: { type: (typeof AUDIT_EVENTS)[number] } & Record<string, unknown>) {
  return ctx.events.emit(tx, { schemaVersion: 1, ...event });
}
