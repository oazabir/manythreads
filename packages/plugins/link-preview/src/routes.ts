import { forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  LINK_PREVIEW_LIST_MAX,
  LinkPreview,
  LinkPreviewChannelPathParams,
  LinkPreviewImagePathParams,
  LinkPreviewItemPathParams,
  LinkPreviewMessagePathParams,
  LinkPreviewSettings,
  ListLinkPreviewsQuery,
  ListLinkPreviewsResponse,
  RemoveLinkPreviewResponse,
  SetLinkPreviewSettingsRequest,
  getLinkPreviewSettingsRoute,
  linkPreviewImageRoute,
  listLinkPreviewsRoute,
  listMessageLinkPreviewsRoute,
  removeLinkPreviewRoute,
  setLinkPreviewSettingsRoute,
} from '@manythreads/shared';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { SWEEP_QUEUE, hostOf, loadRules, pushChanged } from './jobs.ts';
import { linkPreviewEnabled } from './limits.ts';
import { cleanHostList, extractLinks, refusedByRules, type HostRules } from './links.ts';
import { sniffImage } from './parse.ts';

// Routes of the link-preview plugin. Reading a card, its picture and removing a card are all judged by row-level security through the message's
// channel (`app.visible_channel_ids`): hide the channel and the next read is a 403, whatever address the browser holds. On top of that, a card is
// served only while the workspace's rules still allow the address it was made for (an admin who denies a site hides the cards of that site at once,
// before the sweep that deletes them has run).

interface PreviewRow extends Record<string, unknown> {
  id: string;
  channel_id: string;
  message_id: string;
  url: string;
  host: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  has_image: boolean;
  can_remove: boolean;
  created_at: Date;
}

/** Who may take a card off a message: its author, a manager of its channel, a workspace owner or admin. The same three the row-level policy lets through. */
const CAN_REMOVE = `coalesce(m.author_id = app.actor() OR app.channel_can(p.channel_id, 'manage') OR app.workspace_role() IN ('owner', 'admin'), false)`;

const PREVIEW_COLUMNS = `p.id, p.channel_id, p.message_id, p.url, p.host, p.title, p.description, p.site_name, (p.image_id IS NOT NULL) AS has_image,
  ${CAN_REMOVE} AS can_remove, p.created_at`;

/** The one mapper of a card row. The picture's third-party address is not in the row, so it cannot reach a response. */
const toLinkPreview = (r: PreviewRow): LinkPreview =>
  LinkPreview.parse({
    id: r.id,
    channelId: r.channel_id,
    messageId: r.message_id,
    url: r.url,
    host: r.host,
    title: r.title,
    description: r.description,
    siteName: r.site_name,
    hasImage: r.has_image,
    canRemove: r.can_remove,
    createdAt: r.created_at.toISOString(),
  });

async function requireReadable(tx: PluginTx, channelId: string): Promise<void> {
  const ok = (await tx.query<{ ok: boolean | null }>('SELECT app.channel_can($1::uuid, $2) AS ok', [channelId, 'read'])).rows[0]?.ok === true;
  if (!ok) throw forbidden('You cannot read this channel');
}

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can change the link-preview rules.');
}

/** True when the workspace's rules (and this server's switch) allow the address a card was made for. */
const allowedByRules = (rules: HostRules, url: string): boolean => {
  const host = hostOf(url);
  return host !== null && refusedByRules(rules, host) === null;
};

async function cardsOf(tx: PluginTx, channelId: string, messageIds: readonly string[], rules: HostRules): Promise<LinkPreview[]> {
  const res = await tx.query<PreviewRow>(
    `SELECT ${PREVIEW_COLUMNS}
       FROM app.link_previews p JOIN app.messages m ON m.id = p.message_id
      WHERE p.channel_id = $1::uuid AND p.message_id = ANY ($2::uuid[]) AND p.removed_at IS NULL AND m.deleted_at IS NULL
      ORDER BY p.message_id, p.ordinal, p.id`,
    [channelId, messageIds],
  );
  return res.rows.filter((r) => allowedByRules(rules, r.url)).map(toLinkPreview);
}

/** A card may still arrive for a message this young: a read is queued or running. After this long the row stops waiting. */
export const PENDING_WINDOW_SECONDS = 30;

/** Of the asked messages, the ones that are new and carry an allowed link that has neither a card nor a removed card yet. */
async function pendingOf(tx: PluginTx, channelId: string, messageIds: readonly string[], rules: HostRules): Promise<string[]> {
  const recent = (
    await tx.query<{ id: string; body: string }>(
      `SELECT m.id, m.body FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
        WHERE m.channel_id = $1::uuid AND m.id = ANY ($2::uuid[]) AND m.deleted_at IS NULL AND c.kind <> 'bot_conversation'
          AND m.created_at > now() - $3::int * interval '1 second'`,
      [channelId, messageIds, PENDING_WINDOW_SECONDS],
    )
  ).rows;
  if (recent.length === 0) return [];
  const have = new Map<string, Set<string>>();
  for (const r of (await tx.query<{ message_id: string; url: string }>('SELECT message_id, url FROM app.link_previews WHERE message_id = ANY ($1::uuid[])', [recent.map((m) => m.id)])).rows) {
    let set = have.get(r.message_id);
    if (!set) have.set(r.message_id, (set = new Set()));
    set.add(r.url);
  }
  return recent.filter((m) => extractLinks(m.body).some((url) => allowedByRules(rules, url) && !(have.get(m.id)?.has(url) ?? false))).map((m) => m.id);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function registerRoutes(ctx: PluginContext, serverEnabled: () => boolean = () => linkPreviewEnabled()): void {
  /** What this caller's workspace may do with links right now: this server's switch and the workspace's own. */
  const rulesOf = async (tx: PluginTx): Promise<{ rules: HostRules; on: boolean }> => {
    const rules = await loadRules(tx, tx.actor.workspaceId);
    return { rules, on: serverEnabled() && rules.enabled };
  };
  const answer = async (tx: PluginTx, channelId: string, messageIds: readonly string[]): Promise<ListLinkPreviewsResponse> => {
    const { rules, on } = await rulesOf(tx);
    if (!on) return ListLinkPreviewsResponse.parse({ items: [], pending: [], enabled: false });
    const items = await cardsOf(tx, channelId, messageIds, rules);
    const pending = await pendingOf(tx, channelId, messageIds, rules);
    return ListLinkPreviewsResponse.parse({ items, pending, enabled: true });
  };
  // The cards of several messages of one channel (the message list asks for a screenful at once).
  ctx.http.route({
    ...listLinkPreviewsRoute,
    schema: { query: ListLinkPreviewsQuery, response: ListLinkPreviewsResponse },
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = LinkPreviewChannelPathParams.parse(req.params);
      const { messageIds } = ListLinkPreviewsQuery.parse(req.query);
      await requireReadable(tx, channelId);
      return json(await answer(tx, channelId, messageIds));
    }),
  });

  ctx.http.route({
    ...listMessageLinkPreviewsRoute,
    schema: { response: ListLinkPreviewsResponse },
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = LinkPreviewMessagePathParams.parse(req.params);
      await requireReadable(tx, channelId);
      return json(await answer(tx, channelId, [messageId]));
    }),
  });

  // The author of the message, a manager of its channel or a workspace admin takes one card off the message. The row stays as a tombstone, so an
  // edit that keeps the link does not bring the card back.
  ctx.http.route({
    ...removeLinkPreviewRoute,
    schema: { response: RemoveLinkPreviewResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId, previewId } = LinkPreviewItemPathParams.parse(req.params);
      await requireReadable(tx, channelId);
      const card = (
        await tx.query<{ can_remove: boolean; removed_at: Date | null }>(
          `SELECT ${CAN_REMOVE} AS can_remove, p.removed_at FROM app.link_previews p JOIN app.messages m ON m.id = p.message_id
            WHERE p.id = $1::uuid AND p.message_id = $2::uuid AND p.channel_id = $3::uuid`,
          [previewId, messageId, channelId],
        )
      ).rows[0];
      if (!card) throw notFound('There is no such preview.');
      if (!card.can_remove) throw forbidden('Only the author of a message, a manager of its channel or a workspace admin can remove its previews.');
      if (card.removed_at !== null) return json(RemoveLinkPreviewResponse.parse({ removed: false }));
      const done = await tx.query(
        'UPDATE app.link_previews SET removed_at = now(), removed_by = app.actor() WHERE id = $1::uuid AND removed_at IS NULL RETURNING id',
        [previewId],
      );
      if (done.rows.length > 0) await pushChanged(ctx, tx, channelId, messageId);
      return json(RemoveLinkPreviewResponse.parse({ removed: done.rows.length > 0 }));
    }),
  });

  // The picture, served from this server: the browser never contacts the site that owns it. Only a picture whose bytes still sniff as one of the
  // five kinds the fetcher stores is sent; the answer carries headers that stop a browser from treating it as anything else. It is served only while
  // the workspace's rules still allow the address of its card.
  ctx.http.route({
    ...linkPreviewImageRoute,
    rateLimit: { limit: 1200, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { previewId } = LinkPreviewImagePathParams.parse(req.params);
      const { rules, on } = await rulesOf(tx);
      if (!on) throw notFound('There is no such picture.');
      const row = (
        await tx.query<{ bytes: Buffer; content_type: string; url: string }>(
          `SELECT i.bytes, i.content_type, p.url
             FROM app.link_previews p
             JOIN app.messages m ON m.id = p.message_id AND m.deleted_at IS NULL
             JOIN app.link_preview_images i ON i.id = p.image_id
            WHERE p.id = $1::uuid AND p.removed_at IS NULL`,
          [previewId],
        )
      ).rows[0];
      if (!row || !allowedByRules(rules, row.url)) throw notFound('There is no such picture.');
      const type = sniffImage(row.bytes);
      if (type === null || type !== row.content_type) throw notFound('There is no such picture.');
      // Access is decided again on every request: the browser may keep the picture only if it asks again first (a short answer, 304, when it has not changed).
      const etag = `"${createHash('sha256').update(row.bytes).digest('hex').slice(0, 32)}"`;
      const headers: Record<string, string> = {
        etag,
        'cache-control': 'private, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      };
      if ((req.headers['if-none-match'] ?? '').split(',').some((t) => t.trim() === etag)) return { status: 304, headers };
      return {
        status: 200,
        body: Readable.from([row.bytes]),
        headers: {
          ...headers,
          'content-type': type,
          'content-length': String(row.bytes.length),
          'content-disposition': 'inline',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      };
    }),
  });

  // Settings: the switch and the allow and deny lists. Workspace owners and admins only.
  const settingsOf = async (tx: PluginTx): Promise<LinkPreviewSettings> => {
    const row = (
      await tx.query<{ enabled: boolean; allow: string[]; deny: string[]; updated_at: Date }>(
        'SELECT enabled, allow, deny, updated_at FROM app.link_preview_settings WHERE workspace_id = $1::uuid',
        [tx.actor.workspaceId],
      )
    ).rows[0];
    return LinkPreviewSettings.parse({
      enabled: row?.enabled ?? true,
      allow: row?.allow ?? [],
      deny: row?.deny ?? [],
      updatedAt: row ? row.updated_at.toISOString() : null,
    });
  };

  ctx.http.route({
    ...getLinkPreviewSettingsRoute,
    schema: { response: LinkPreviewSettings },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      return json(await settingsOf(tx));
    }),
  });

  ctx.http.route({
    ...setLinkPreviewSettingsRoute,
    schema: { body: SetLinkPreviewSettingsRequest, response: LinkPreviewSettings },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = SetLinkPreviewSettingsRequest.parse(req.body);
      const allow = cleanHostList(body.allow);
      if ('bad' in allow) throw invalid(`"${allow.bad.slice(0, 60)}" is not a host name. Write it like example.com, without a path.`);
      const deny = cleanHostList(body.deny);
      if ('bad' in deny) throw invalid(`"${deny.bad.slice(0, 60)}" is not a host name. Write it like example.com, without a path.`);
      if (allow.hosts.length > LINK_PREVIEW_LIST_MAX || deny.hosts.length > LINK_PREVIEW_LIST_MAX) throw invalid(`Each list holds at most ${LINK_PREVIEW_LIST_MAX} hosts.`);
      const before = await settingsOf(tx);
      await tx.query(
        `INSERT INTO app.link_preview_settings (workspace_id, enabled, allow, deny, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3::text[], $4::text[], $5::uuid, now())
         ON CONFLICT (workspace_id) DO UPDATE SET enabled = EXCLUDED.enabled, allow = EXCLUDED.allow, deny = EXCLUDED.deny, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tx.actor.workspaceId, body.enabled, allow.hosts, deny.hosts, tx.actor.id],
      );
      const changed = before.enabled !== body.enabled || !sameList(before.allow, allow.hosts) || !sameList(before.deny, deny.hosts);
      if (changed) {
        await ctx.audit.emit(tx, {
          type: 'linkpreview.settings.updated',
          workspaceId: tx.actor.workspaceId,
          changedBy: tx.actor.id,
          enabled: { from: before.enabled, to: body.enabled },
          allowCount: { from: before.allow.length, to: allow.hosts.length },
          denyCount: { from: before.deny.length, to: deny.hosts.length },
          at: ctx.runtime.now().toISOString(),
        });
        // A rule is not retroactive by itself: cards and kept reads that no longer pass are removed by a sweep (until it has run, they are not served).
        await ctx.jobs.enqueue(tx, SWEEP_QUEUE, { workspaceId: tx.actor.workspaceId }, { dedupeKey: `sweep:${tx.actor.workspaceId}` });
      }
      return json(await settingsOf(tx));
    }),
  });
}
