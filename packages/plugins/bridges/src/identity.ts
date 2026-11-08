import { HttpError, createLockout, guardRedemption, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { BRIDGE_WRONG_CODES_PER_CHAT, ChannelChannelArchivedEvent, WorkspaceMemberStatusChangedEvent, type BridgeProvider } from '@manythreads/shared';
import type { BridgeAccountRef } from './adapter.ts';
import { sha256Hex } from './routes-me.ts';
import { cleanLabel } from './text.ts';
import { pgCode } from './util.ts';

// Proving that a chat user is a person (PLAN Bundle D, P16-09, decision D25). A code (eight digits, ten minutes, once) is made by `app.bridges_issue_code` for a signed-in person; the person
// sends it to the workspace's bot; `app.bridges_link_identity` (system only) redeems it. Five wrong codes from one chat in 15 minutes lock that chat out of every code for 15 minutes, so a
// code cannot be guessed (eight digits are a hundred million; the person asking is limited to five codes in ten minutes by the database). The same lock guards the channel codes.
// A link ends when the person unlinks (the button, `/unlink` in the chat), an admin removes it, or the person leaves (their account is switched off).

export type Redeemed<T> = { kind: 'ok'; value: T } | { kind: 'wrong' } | { kind: 'locked'; minutes: number } | { kind: 'taken' };

export interface IdentityService {
  /** A chat user sent a code to be linked as a person. */
  redeemIdentity(ref: BridgeAccountRef, chat: string, externalUserId: string, label: string, code: string): Promise<Redeemed<{ personId: string; name: string }>>;
  /** Someone typed `/connect <code>` in an outside chat. */
  redeemChannel(ref: BridgeAccountRef, chat: string, title: string | null, code: string): Promise<Redeemed<{ linkId: string; channelName: string }>>;
  /** `/unlink` in the chat. True when a link was there. */
  unlinkFromChat(ref: BridgeAccountRef, personId: string): Promise<boolean>;
}

const WINDOW_MS = 15 * 60_000;

export function createIdentityService(ctx: PluginContext): IdentityService {
  const lock = createLockout({ max: BRIDGE_WRONG_CODES_PER_CHAT, windowMs: WINDOW_MS, lockMs: WINDOW_MS, now: ctx.runtime.now });
  const now = (): string => ctx.runtime.now().toISOString();

  async function guarded<T>(key: string, redeem: () => Promise<T | null | 'taken'>): Promise<Redeemed<T>> {
    try {
      const result = await guardRedemption(lock, key, 'codes', redeem, ({ result: r }) => r === null);
      if (result === null) return { kind: 'wrong' };
      if (result === 'taken') return { kind: 'taken' };
      return { kind: 'ok', value: result };
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) return { kind: 'locked', minutes: Math.max(1, Math.ceil(Number(err.headers['retry-after'] ?? '60') / 60)) };
      throw err;
    }
  }

  return {
    redeemIdentity: (ref, chat, externalUserId, label, code) =>
      guarded(`${ref.id}\n${chat}`, async () => {
        let personId: string | null;
        try {
          personId = await ctx.db.system(async (sys) => (await sys.query<{ person_id: string | null }>('SELECT app.bridges_link_identity($1::uuid, $2, $3, $4) AS person_id', [ref.id, sha256Hex(code), externalUserId, cleanLabel(label)])).rows[0]?.person_id ?? null, {
            workspaceId: ref.workspaceId,
          });
        } catch (err) {
          // this chat user is linked to someone else already: the code stays unused, and it is not a wrong guess
          if (pgCode(err) === '23505') return 'taken';
          throw err;
        }
        if (personId === null) return null;
        const name = await ctx.db.system(
          async (sys) => {
            await ctx.audit.emit(sys, { type: 'bridges.identity.linked', workspaceId: ref.workspaceId, accountId: ref.id, provider: ref.provider, personId, at: now() });
            return (await sys.query<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1::uuid', [personId])).rows[0]?.display_name ?? 'there';
          },
          { workspaceId: ref.workspaceId },
        );
        return { personId, name };
      }),

    redeemChannel: (ref, chat, title, code) =>
      guarded(`${ref.id}\n${chat}`, async () => {
        try {
          return await ctx.db.system(
            async (sys) => {
              const linkId = (await sys.query<{ id: string | null }>('SELECT app.bridges_link_channel($1::uuid, $2, $3, $4) AS id', [ref.id, sha256Hex(code), chat, cleanLabel(title ?? '')])).rows[0]?.id ?? null;
              if (linkId === null) return null;
              const link = (
                await sys.query<{ team_id: string; channel_id: string; name: string; actor_id: string | null }>(
                  `SELECT l.team_id, l.channel_id, c.name, a.id AS actor_id
                     FROM app.bridge_links l JOIN app.channels c ON c.id = l.channel_id
                     LEFT JOIN app.actors a ON a.kind = 'person' AND a.ref_id = l.linked_by AND a.workspace_id = l.workspace_id
                    WHERE l.id = $1::uuid`,
                  [linkId],
                )
              ).rows[0]!;
              await ctx.audit.emit(sys, {
                type: 'bridges.channel.linked',
                workspaceId: ref.workspaceId,
                teamId: link.team_id,
                channelId: link.channel_id,
                accountId: ref.id,
                linkId,
                provider: ref.provider,
                actorId: link.actor_id ?? sys.actor.id,
                at: now(),
              });
              return { linkId, channelName: link.name };
            },
            { workspaceId: ref.workspaceId },
          );
        } catch (err) {
          if (pgCode(err) === '23505') return 'taken';
          throw err;
        }
      }),

    async unlinkFromChat(ref, personId) {
      return ctx.db.system(
        async (sys) => {
          const gone = await sys.query('DELETE FROM app.bridge_identities WHERE account_id = $1::uuid AND person_id = $2::uuid RETURNING id', [ref.id, personId]);
          if (gone.rows.length === 0) return false;
          await emitUnlinked(ctx, sys, ref.workspaceId, ref.id, ref.provider, personId, 'chat_command', null);
          return true;
        },
        { workspaceId: ref.workspaceId },
      );
    },
  };
}

async function emitUnlinked(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
  accountId: string,
  provider: BridgeProvider,
  personId: string,
  how: 'person' | 'chat_command' | 'admin' | 'offboarded',
  actorId: string | null,
): Promise<void> {
  await ctx.audit.emit(tx, { type: 'bridges.identity.unlinked', workspaceId, accountId, provider, personId, how, actorId, at: ctx.runtime.now().toISOString() });
}

export function registerIdentity(ctx: PluginContext): void {
  // A member who is switched off (deactivated) can no longer be heard: every link of theirs ends. Reactivating them does not bring a link back; they link again.
  ctx.events.subscribe('workspace.member.status_changed', async (raw: PluginEvent, tx: PluginTx) => {
    const e = WorkspaceMemberStatusChangedEvent.safeParse(raw);
    if (!e.success || e.data.status === 'active') return;
    const gone = await tx.query<{ account_id: string; provider: BridgeProvider }>(
      `DELETE FROM app.bridge_identities i USING app.bridge_accounts a
        WHERE a.id = i.account_id AND i.person_id = $1::uuid AND i.workspace_id = $2::uuid RETURNING i.account_id, a.provider`,
      [e.data.personId, e.data.workspaceId],
    );
    for (const r of gone.rows) await emitUnlinked(ctx, tx, e.data.workspaceId, r.account_id, r.provider, e.data.personId, 'offboarded', null);
  });

  // An archived channel is read-only: nothing can be sent into it, so its links end (restoring it does not bring them back; a lead links again).
  ctx.events.subscribe('channel.channel.archived', async (raw: PluginEvent, tx: PluginTx) => {
    const e = ChannelChannelArchivedEvent.safeParse(raw);
    if (!e.success || !e.data.archived) return;
    const gone = await tx.query<{ id: string; account_id: string; team_id: string; provider: BridgeProvider }>(
      `DELETE FROM app.bridge_links l USING app.bridge_accounts a
        WHERE a.id = l.account_id AND l.channel_id = $1::uuid AND l.workspace_id = $2::uuid RETURNING l.id, l.account_id, l.team_id, a.provider`,
      [e.data.channelId, e.data.workspaceId],
    );
    for (const r of gone.rows) {
      await ctx.audit.emit(tx, {
        type: 'bridges.channel.unlinked',
        workspaceId: e.data.workspaceId,
        teamId: r.team_id,
        channelId: e.data.channelId,
        accountId: r.account_id,
        linkId: r.id,
        provider: r.provider,
        actorId: null,
        reason: 'channel_archived',
        at: ctx.runtime.now().toISOString(),
      });
    }
  });
}
