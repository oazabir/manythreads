import type { MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import { ConnectionsSignInExpiredEvent } from '@manythreads/shared';
import { providerDef } from './providers.ts';
import type { OAuthDeps } from './store.ts';

// The "Reconnect" prompt (PLAN P16-02). When the provider stops honouring a person's sign-in for good, the person is told once, in the one place every notice for
// them lives: a message in their own Reminders conversation, written by the workspace's Reminders sender, and an event that the notifications plugin turns into a
// notification (the way a due reminder becomes one). The notice names the provider and says what to do; it carries no token, no address and none of the provider's own
// error text. One expired sign-in is one notice: `connection_oauth.notified_at` is claimed in the same transaction as the message, and cleared when the person connects
// again (saveSignIn), so a later expiry is a new notice.

/** The words of the notice. Plain language: what happened, what it means for the bots, what to press. */
export const reconnectNotice = (label: string): string =>
  `Reconnect ${label} — access expired. ${label} stopped accepting your sign-in, so bots can no longer use your ${label} account for you. Open Settings, then Connections, and choose Reconnect on ${label}.`;

/**
 * The hook for `OAuthDeps.onNeedsReconnect`: tells the owner of the connection, once. Safe to call as often as a dead sign-in is found: only the call that claims the
 * row writes the notice. A failure rolls the claim back with the rest, so the next call tries again.
 */
export function createReconnectNotifier(ctx: PluginContext): NonNullable<OAuthDeps['onNeedsReconnect']> {
  return async ({ workspaceId, connectionId, provider }) => {
    const def = providerDef(provider);
    if (!def) return;
    const messages = ctx.providers.get<MessageProvider>('messages');
    if (!messages) return;
    await ctx.db.system(
      async (sys) => {
        const claimed = (
          await sys.query<{ person_id: string }>(
            `UPDATE app.connection_oauth o SET notified_at = now()
               FROM app.connections c JOIN app.actors a ON a.id = c.owner_id AND a.kind = 'person'
              WHERE o.connection_id = $1 AND o.workspace_id = $2 AND o.state = 'needs_reconnect' AND o.notified_at IS NULL
                AND c.id = o.connection_id AND c.scope = 'person'
              RETURNING a.ref_id AS person_id`,
            [connectionId, workspaceId],
          )
        ).rows[0];
        if (!claimed) return;
        // the transaction acts as the Reminders sender from here on: the message and the event are written under that actor, or the outbox would skip the event
        const senderId = (await sys.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]!.id;
        const asSender: PluginTx = { actor: { kind: 'system', id: senderId, workspaceId }, query: (text, values) => sys.query(text, values) };
        const channelId = (await sys.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [claimed.person_id])).rows[0]!.id;
        const posted = await messages.post(asSender, { channelId, body: reconnectNotice(def.label), skipRefs: true });
        await ctx.audit.emit(
          asSender,
          ConnectionsSignInExpiredEvent.parse({
            type: 'connections.sign_in.expired',
            schemaVersion: 1,
            workspaceId,
            personId: claimed.person_id,
            connectionId,
            provider,
            messageId: posted.id,
            channelId,
          }),
        );
      },
      { workspaceId },
    );
  };
}
