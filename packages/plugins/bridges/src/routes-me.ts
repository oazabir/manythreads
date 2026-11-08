import { createHash, randomInt } from 'node:crypto';
import { json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  BRIDGE_CODE_DIGITS,
  BridgeProviderParams,
  LinkCodeResponse,
  ListMyBridgesResponse,
  UnlinkMyBridgeResponse,
  abuseLimit,
  createMyBridgeLinkCodeRoute,
  listMyBridgesRoute,
  unlinkMyBridgeRoute,
  type BridgeAvailable,
  type BridgeProvider,
} from '@manythreads/shared';
import { pgCode } from './util.ts';

// A person's own side, Account → Chat apps (PLAN Bundle D, P16-09, decision D25): which chat apps are set up, which of their chat users are linked, a code to link one (five in ten minutes,
// enforced by the database) and unlinking. The code is shown once; only its sha256 is stored.

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Eight random digits. */
export const newCode = (): string => String(randomInt(0, 10 ** BRIDGE_CODE_DIGITS)).padStart(BRIDGE_CODE_DIGITS, '0');

/** The accounts that are on, as a member sees them (the database function says nothing else of an account). */
export async function availableAccounts(tx: PluginTx): Promise<BridgeAvailable[]> {
  const rows = (await tx.query<{ account_id: string; provider: BridgeProvider; display_name: string; handle: string | null }>('SELECT account_id, provider, display_name, handle FROM app.bridges_available()')).rows;
  return rows.map((r) => ({ accountId: r.account_id, provider: r.provider, displayName: r.display_name, handle: r.handle })) as BridgeAvailable[];
}

const handleOf = (handle: string | null): string | null => (handle === null ? null : handle.replace(/^@/, ''));

/** What to tell the person, in plain words. */
export function instructionFor(provider: BridgeProvider, handle: string | null, code: string): string {
  const who = handle === null ? 'the bot' : handle;
  switch (provider) {
    case 'telegram':
      return `Open ${who} in Telegram and send it this code: ${code}. It works for 10 minutes, once.`;
    case 'whatsapp':
      return `Send ${code} to ${who} on WhatsApp. It works for 10 minutes, once.`;
    case 'slack':
      return `Send ${code} to ${who} in a direct message on Slack. It works for 10 minutes, once.`;
    case 'teams':
      return `Send ${code} to ${who} in a chat on Microsoft Teams. It works for 10 minutes, once.`;
  }
}

/** A link that opens the chat app with the code filled in, where the service has one. */
export function deepLinkFor(provider: BridgeProvider, handle: string | null, code: string): string | null {
  const h = handleOf(handle);
  if (provider === 'telegram' && h !== null && /^[A-Za-z0-9_]{3,64}$/.test(h)) return `https://t.me/${h}?start=${code}`;
  return null;
}

/** Asks the database for a code of this purpose and turns its refusals into plain answers. */
export async function issueCode(tx: PluginTx, accountId: string, purpose: 'identity' | 'channel', channelId: string | null): Promise<{ code: string; expiresAt: string }> {
  const code = newCode();
  try {
    const row = (await tx.query<{ expires: Date }>('SELECT app.bridges_issue_code($1::uuid, $2, $3::uuid, $4) AS expires', [accountId, purpose, channelId, sha256Hex(code)])).rows[0]!;
    return { code, expiresAt: row.expires.toISOString() };
  } catch (err) {
    if (pgCode(err) === 'P0002') throw notFound('This chat app is not turned on');
    throw err;
  }
}

export function registerMeRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listMyBridgesRoute,
    schema: { response: ListMyBridgesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const available = await availableAccounts(tx);
      const personId = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      // the person's own links; the service of each is read by the system role because a member may not read the accounts table
      const identities =
        personId === null
          ? []
          : (
              await ctx.db.system(
                (sys) =>
                  sys.query<{ account_id: string; provider: BridgeProvider; person_id: string; external_label: string | null; verified_at: Date }>(
                    `SELECT i.account_id, a.provider, i.person_id, i.external_label, i.verified_at
                       FROM app.bridge_identities i JOIN app.bridge_accounts a ON a.id = i.account_id
                      WHERE i.person_id = $1::uuid AND i.workspace_id = $2::uuid ORDER BY i.verified_at DESC`,
                    [personId, tx.actor.workspaceId],
                  ),
                { workspaceId: tx.actor.workspaceId },
              )
            ).rows.map((r) => ({ accountId: r.account_id, provider: r.provider, personId: r.person_id, externalLabel: r.external_label, verifiedAt: r.verified_at.toISOString() }));
      return json(ListMyBridgesResponse.parse({ available, identities }));
    }),
  });

  ctx.http.route({
    ...createMyBridgeLinkCodeRoute,
    schema: { response: LinkCodeResponse },
    rateLimit: abuseLimit('POST', createMyBridgeLinkCodeRoute.path),
    handler: route(async (req, tx) => {
      const { provider } = BridgeProviderParams.parse(req.params);
      const account = (await availableAccounts(tx)).find((a) => a.provider === provider);
      if (!account) throw notFound('This chat app is not turned on');
      const { code, expiresAt } = await issueCode(tx, account.accountId, 'identity', null);
      return json(LinkCodeResponse.parse({ code, expiresAt, deepLink: deepLinkFor(provider, account.handle, code), instruction: instructionFor(provider, account.handle, code) }), 201);
    }),
  });

  ctx.http.route({
    ...unlinkMyBridgeRoute,
    schema: { response: UnlinkMyBridgeResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { provider } = BridgeProviderParams.parse(req.params);
      const personId = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      if (personId === null) throw notFound('No link to remove');
      const accountId = (await ctx.db.system((sys) => sys.query<{ id: string }>('SELECT id FROM app.bridge_accounts WHERE workspace_id = $1::uuid AND provider = $2', [tx.actor.workspaceId, provider]), { workspaceId: tx.actor.workspaceId })).rows[0]?.id;
      if (!accountId) throw notFound('No link to remove');
      // row-level security: a person removes their own link
      const gone = await tx.query('DELETE FROM app.bridge_identities WHERE account_id = $1::uuid AND person_id = $2::uuid RETURNING id', [accountId, personId]);
      if (gone.rows.length === 0) throw notFound('No link to remove');
      await ctx.audit.emit(tx, { type: 'bridges.identity.unlinked', workspaceId: tx.actor.workspaceId, accountId, provider, personId, how: 'person', actorId: tx.actor.id, at: ctx.runtime.now().toISOString() });
      return json(UnlinkMyBridgeResponse.parse({ unlinked: true }));
    }),
  });
}
