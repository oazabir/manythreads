import { conflict, json, notFound, route, type PluginContext } from '@manythreads/sdk';
import {
  BridgeChannelParams,
  BridgeChannelProviderParams,
  BridgeLinkParams,
  ChannelLinkCodeResponse,
  DeleteBridgeLinkResponse,
  ListChannelBridgesResponse,
  abuseLimit,
  createChannelBridgeCodeRoute,
  deleteBridgeLinkRoute,
  listChannelBridgesRoute,
  type BridgeProvider,
} from '@manythreads/shared';
import { availableAccounts, issueCode } from './routes-me.ts';

/** What the lead does with the code, in plain words. */
function channelInstruction(provider: BridgeProvider, handle: string | null, command: string): string {
  const bot = handle ?? 'the bot';
  const where = provider === 'telegram' ? 'Telegram group' : provider === 'slack' ? 'Slack channel' : 'Teams channel';
  return `Add ${bot} to the ${where}, then send this message there: ${command}. It works for 10 minutes, once, and only a lead of the team can do it.`;
}

// Joining a PUBLIC channel to an outside chat (PLAN Bundle D, P16-09, decision D26). A lead of the channel's team (or a workspace admin) who is in the channel asks for a code, types
// `/connect <code>` in the outside chat, and the link is made when the bridge redeems the code (identity.ts). A lead or admin removes a link here.

interface ChannelFacts extends Record<string, unknown> {
  team_id: string | null;
  kind: string;
  private: boolean;
  archived: boolean;
  can_link: boolean;
}

export function registerChannelRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listChannelBridgesRoute,
    schema: { response: ListChannelBridgesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = BridgeChannelParams.parse(req.params);
      // the channel as the caller sees it: one they cannot read does not exist for them
      const facts = (
        await tx.query<ChannelFacts>(
          `SELECT c.team_id, c.kind, c.private, (c.archived_at IS NOT NULL) AS archived,
                  coalesce(app.lookup_workspace_role() IN ('owner', 'admin') OR app.lookup_team_role(c.team_id) = 'lead', false)
                    AND coalesce(app.lookup_channel_can(c.id, 'post'), false) AS can_link
             FROM app.channels c WHERE c.id = $1::uuid`,
          [channelId],
        )
      ).rows[0];
      if (!facts) throw notFound('No such channel');
      const rows = (
        await tx.query<{ id: string; account_id: string; team_id: string; channel_id: string; external_label: string | null; created_at: Date }>(
          'SELECT id, account_id, team_id, channel_id, external_label, created_at FROM app.bridge_links WHERE channel_id = $1::uuid ORDER BY created_at',
          [channelId],
        )
      ).rows;
      const providers = new Map<string, BridgeProvider>();
      if (rows.length > 0) {
        const found = await ctx.db.system((sys) => sys.query<{ id: string; provider: BridgeProvider }>('SELECT id, provider FROM app.bridge_accounts WHERE id = ANY ($1::uuid[])', [rows.map((r) => r.account_id)]), {
          workspaceId: tx.actor.workspaceId,
        });
        for (const r of found.rows) providers.set(r.id, r.provider);
      }
      const links = rows.flatMap((r) => {
        const provider = providers.get(r.account_id);
        return provider === undefined
          ? []
          : [{ id: r.id, accountId: r.account_id, provider, teamId: r.team_id, channelId: r.channel_id, externalLabel: r.external_label, createdAt: r.created_at.toISOString() }];
      });
      // WhatsApp only talks in direct chats, so it is never offered for a channel
      const accounts = (await availableAccounts(tx)).filter((a) => a.provider !== 'whatsapp');
      return json(ListChannelBridgesResponse.parse({ links, accounts, canLink: facts.can_link && facts.kind === 'channel' && !facts.private && !facts.archived }));
    }),
  });

  ctx.http.route({
    ...createChannelBridgeCodeRoute,
    schema: { response: ChannelLinkCodeResponse },
    rateLimit: abuseLimit('POST', createChannelBridgeCodeRoute.path),
    handler: route(async (req, tx) => {
      const { channelId, provider } = BridgeChannelProviderParams.parse(req.params);
      if (provider === 'whatsapp') throw conflict('WhatsApp works in direct chats only. A channel cannot be joined to it.');
      const account = (await availableAccounts(tx)).find((a) => a.provider === provider);
      if (!account) throw notFound('This chat app is not turned on');
      const { code, expiresAt } = await issueCode(tx, account.accountId, 'channel', channelId);
      const command = `/connect ${code}`;
      return json(
        ChannelLinkCodeResponse.parse({
          code,
          expiresAt,
          deepLink: null,
          instruction: channelInstruction(provider, account.handle, command),
          command,
        }),
        201,
      );
    }),
  });

  ctx.http.route({
    ...deleteBridgeLinkRoute,
    schema: { response: DeleteBridgeLinkResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { linkId } = BridgeLinkParams.parse(req.params);
      // row-level security: a lead of the team or a workspace admin removes it
      const gone = (await tx.query<{ account_id: string; team_id: string; channel_id: string }>('DELETE FROM app.bridge_links WHERE id = $1::uuid RETURNING account_id, team_id, channel_id', [linkId])).rows[0];
      if (!gone) throw notFound('No such link');
      const provider = (await ctx.db.system((sys) => sys.query<{ provider: BridgeProvider }>('SELECT provider FROM app.bridge_accounts WHERE id = $1::uuid', [gone.account_id]), { workspaceId: tx.actor.workspaceId })).rows[0]?.provider;
      if (provider !== undefined) {
        await ctx.audit.emit(tx, {
          type: 'bridges.channel.unlinked',
          workspaceId: tx.actor.workspaceId,
          teamId: gone.team_id,
          channelId: gone.channel_id,
          accountId: gone.account_id,
          linkId,
          provider,
          actorId: tx.actor.id,
          reason: 'person',
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json(DeleteBridgeLinkResponse.parse({ unlinked: true }));
    }),
  });
}
