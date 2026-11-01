import type { PluginContext, PluginEvent, PluginLogger, PluginTx } from '@manythreads/sdk';
import { LINK_PREVIEW_MAX_PER_MESSAGE, WS_LINK_PREVIEW_CHANGED } from '@manythreads/shared';
import { z } from 'zod';
import { fetchPreview, type FetchedPreview } from './fetch-preview.ts';
import { createHostBreaker, createLinkBudget, linkPreviewEnabled, type HostBreaker, type LinkBudget } from './limits.ts';
import { DEFAULT_RULES, extractLinks, refusedByRules, type HostRules } from './links.ts';
import { DEFAULT_DEPS, SafeFetchError, type SafeFetchDeps } from './safe-fetch.ts';

// The background half of link previews. A message is posted (or edited): `link-preview.sync` works out which of its links need a card and queues one
// `link-preview.fetch` job per link. A fetch job reads the address through the egress guard (or finds it in the day's cache), copies the result
// onto the message as a card, and tells the channel's readers to look again. Jobs run as the system actor, so each re-checks everything it relies on:
// the payload is whatever anybody put in the queue, so the address must be one the message really contains, the workspace must be the message's own.
//
// The network wait is NOT inside a database transaction. A fetch job is `detached`: it opens a short transaction to look at the message and the
// rules, lets go, reads the page (up to 8 seconds, with a connection pool slot free for everybody else), and opens a second short transaction to
// store the result, where it checks again that the message is still live and still carries the link. One fetch runs per workspace at a time
// (`serialKey`), so one busy workspace cannot take every worker, and a budget per author and per workspace limits how many new reads a minute or an
// hour can start.

export const SYNC_QUEUE = 'link-preview.sync';
export const FETCH_QUEUE = 'link-preview.fetch';
export const PURGE_QUEUE = 'link-preview.purge';
export const SWEEP_QUEUE = 'link-preview.sweep';
/** A good read is reused for a day; a failed one for an hour, so a broken site is not asked again at every post but is tried again soon. */
export const OK_TTL_MS = 24 * 60 * 60 * 1000;
export const FAIL_TTL_MS = 60 * 60 * 1000;
/** A read refused because the site is cooling down is remembered only as long as the cool-down. */
export const COOLING_TTL_MS = 5 * 60 * 1000;
export const PURGE_CRON = '23 3 * * *';
/** The pictures one workspace keeps: past this, the oldest pictures no card uses are dropped first; if that is not enough the new card has no picture. */
export const WORKSPACE_IMAGE_BYTES_MAX = 128 * 1024 * 1024;

const SyncPayload = z.object({ workspaceId: z.uuid(), messageId: z.uuid() });
const FetchPayload = z.object({ workspaceId: z.uuid(), messageId: z.uuid(), url: z.string().min(1).max(2000) });
const SweepPayload = z.object({ workspaceId: z.uuid() });

/** What the jobs use instead of the real network and the real clock, in tests. */
export interface JobDeps {
  fetchDeps: SafeFetchDeps;
  breaker: HostBreaker;
  budget: LinkBudget;
  /** Whether this server reads links at all (`MANYTHREADS_LINK_PREVIEW`); asked at every job, so a test can change it. */
  enabled: () => boolean;
  /** Time for one whole fetch job. Default 8 seconds. */
  overallMs?: number;
}
export const DEFAULT_JOB_DEPS: JobDeps = {
  fetchDeps: DEFAULT_DEPS,
  breaker: createHostBreaker(),
  budget: createLinkBudget(),
  enabled: () => linkPreviewEnabled(),
};

interface MessageRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_id: string;
  body: string;
  deleted: boolean;
  channel_kind: string;
  team_id: string | null;
}

async function loadMessage(tx: PluginTx, workspaceId: string, messageId: string): Promise<MessageRow | null> {
  const res = await tx.query<MessageRow>(
    `SELECT m.id, m.workspace_id, m.channel_id, m.author_id, m.body, (m.deleted_at IS NOT NULL) AS deleted, c.kind AS channel_kind, c.team_id
       FROM app.messages m JOIN app.channels c ON c.id = m.channel_id
      WHERE m.id = $1::uuid AND m.workspace_id = $2::uuid`,
    [messageId, workspaceId],
  );
  return res.rows[0] ?? null;
}

/** The workspace's allow and deny lists and switch (the default when an admin never set them: on, any public site). */
export async function loadRules(tx: PluginTx, workspaceId: string): Promise<HostRules> {
  const row = (
    await tx.query<{ enabled: boolean; allow: string[]; deny: string[] }>('SELECT enabled, allow, deny FROM app.link_preview_settings WHERE workspace_id = $1::uuid', [workspaceId])
  ).rows[0];
  return row ? { enabled: row.enabled, allow: row.allow, deny: row.deny } : DEFAULT_RULES;
}

/** The host of a stored address, or null when it does not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The workspace's model-guard preset and egress allowlist, when the model gateway keeps them (they decide `air-gapped` and `strict-egress`). */
async function loadEgressSetup(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

/** Runs `fn` in a transaction. In a detached job that is a short transaction of its own; the check below runs while the network is being read. */
type InTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

/**
 * The check `safeFetch` runs before every address it requests (first page, each redirect, oEmbed endpoint, picture) and that a cached result also
 * passes before it becomes a card: the workspace's lists, then the `pre_egress` chain with destination `link_preview` (so `air-gapped` refuses every
 * read, `strict-egress` allows only listed hosts, the team's own list of reachable hosts applies, and the data-loss check reads the address itself: a
 * secret in a query string is not sent to a third party). Fails closed when nothing guards the destination. The guard writes its own refusal to the
 * audit log (`recorded: false`), in the short transaction this opens, so the line stays even though the read goes on to fail.
 */
export function egressCheck(
  ctx: PluginContext,
  inTx: InTx,
  scope: { workspaceId: string; teamId: string | null; rules: HostRules; setup: { preset: string; allowlist: string[] } },
) {
  return async (url: URL): Promise<void> => {
    const refused = refusedByRules(scope.rules, url.hostname);
    if (refused !== null) throw new SafeFetchError('blocked_by_policy', `The workspace's link-preview rules do not allow ${url.hostname} (${refused}).`);
    const decision = await inTx((tx) =>
      ctx.hooks.runPreEgress(tx, {
        destination: 'link_preview',
        workspaceId: scope.workspaceId,
        teamId: scope.teamId,
        text: url.href,
        preset: scope.setup.preset,
        allowlist: scope.setup.allowlist,
        targets: [{ name: 'link-preview', host: url.hostname.toLowerCase(), local: false }],
        recorded: false,
      }),
    );
    if (decision.hooks === 0 || decision.outcome !== 'allow') {
      throw new SafeFetchError('blocked_by_policy', decision.message ?? 'The workspace guard does not let this address be read.');
    }
  };
}

/** Tells everyone who can read the channel to read this message's cards again. */
export async function pushChanged(ctx: PluginContext, tx: PluginTx, channelId: string, messageId: string): Promise<void> {
  const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [channelId])).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, WS_LINK_PREVIEW_CHANGED, { channelId, messageId });
}

/** The message was posted or edited: queue a card for each new link, drop the cards of links that are gone. Idempotent. */
async function sync(ctx: PluginContext, tx: PluginTx, deps: JobDeps, log: PluginLogger, workspaceId: string, messageId: string): Promise<void> {
  const message = await loadMessage(tx, workspaceId, messageId);
  if (!message) return;
  // A deleted message keeps no card; a conversation with a bot is not read out to the web (its text is for the bot and the asker).
  if (message.deleted || message.channel_kind === 'bot_conversation') {
    const gone = await tx.query('DELETE FROM app.link_previews WHERE message_id = $1::uuid RETURNING id', [messageId]);
    if (gone.rows.length > 0 && !message.deleted) await pushChanged(ctx, tx, message.channel_id, messageId);
    return;
  }
  // Switched off for the workspace: nothing is queued and nothing is pruned here (the sweep that follows the switch took the cards away already).
  const rules = await loadRules(tx, workspaceId);
  if (!rules.enabled) return;
  const links = extractLinks(message.body);
  // a card whose link is gone from the text goes; the tombstone of a card its author removed stays, so the same link written again stays without a card
  const pruned = await tx.query('DELETE FROM app.link_previews WHERE message_id = $1::uuid AND removed_at IS NULL AND NOT (url = ANY ($2::text[])) RETURNING id', [messageId, links]);
  if (pruned.rows.length > 0) await pushChanged(ctx, tx, message.channel_id, messageId);

  const allowed = links.filter((url) => {
    const host = hostOf(url);
    return host !== null && refusedByRules(rules, host) === null;
  });
  if (allowed.length === 0) return;
  // Which links still need the network: no card (or tombstone) yet and no read of the last day to reuse. Those are what the budget counts.
  const needNetwork = (
    await tx.query<{ url: string }>(
      `SELECT u.url FROM unnest($1::text[]) AS u(url)
        WHERE NOT EXISTS (SELECT 1 FROM app.link_previews p WHERE p.message_id = $2::uuid AND p.url = u.url)
          AND NOT EXISTS (SELECT 1 FROM app.link_preview_cache c WHERE c.workspace_id = $3::uuid AND c.url = u.url AND c.expires_at > now())`,
      [allowed, messageId, workspaceId],
    )
  ).rows.map((r) => r.url);
  let skip = new Set<string>();
  if (needNetwork.length > 0) {
    const taken = deps.budget.take(message.author_id, workspaceId, needNetwork.length);
    if (!taken.ok) {
      skip = new Set(needNetwork);
      log.warn(`link-preview: ${needNetwork.length} read(s) not started, the ${taken.scope} budget is used up`);
    }
  }
  for (const url of allowed) {
    if (skip.has(url)) continue;
    await ctx.jobs.enqueue(tx, FETCH_QUEUE, { workspaceId, messageId, url }, { dedupeKey: `lp:${messageId}:${url}` });
  }
}

interface CacheRow extends Record<string, unknown> {
  status: 'ok' | 'failed' | 'blocked';
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_id: string | null;
}

/** What the first short transaction of a fetch job learned: enough to read the page without the database. */
interface Plan {
  message: MessageRow;
  rules: HostRules;
  setup: { preset: string; allowlist: string[] };
  cached: CacheRow | undefined;
}

async function plan(tx: PluginTx, workspaceId: string, messageId: string, url: string): Promise<Plan | null> {
  const message = await loadMessage(tx, workspaceId, messageId);
  if (!message || message.deleted || message.channel_kind === 'bot_conversation') return null;
  // the address must be one the message really carries: a job payload is not proof of anything
  if (!extractLinks(message.body).includes(url)) return null;
  const existing = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.link_previews WHERE message_id = $1::uuid', [messageId]);
  if ((existing.rows[0]?.n ?? 0) >= LINK_PREVIEW_MAX_PER_MESSAGE) return null;
  const already = await tx.query('SELECT 1 FROM app.link_previews WHERE message_id = $1::uuid AND url = $2', [messageId, url]);
  if (already.rows.length > 0) return null; // a card, or the tombstone of one its author removed
  const rules = await loadRules(tx, workspaceId);
  const host = hostOf(url);
  if (host === null || refusedByRules(rules, host) !== null) return null;
  const setup = await loadEgressSetup(tx, workspaceId);
  const cached = (
    await tx.query<CacheRow>(
      'SELECT status, title, description, site_name, image_id FROM app.link_preview_cache WHERE workspace_id = $1::uuid AND url = $2 AND expires_at > now()',
      [workspaceId, url],
    )
  ).rows[0];
  return { message, rules, setup, cached };
}

/**
 * Keeps a fetched picture, within the workspace's byte cap. Over the cap, the oldest pictures that no card uses are dropped (a cache row that pointed at
 * one just loses its picture); if that frees too little the picture is not kept and the card has none. Answers the new picture's id, or null.
 */
export async function storeImage(tx: PluginTx, workspaceId: string, image: { bytes: Buffer; type: string }, cap: number = WORKSPACE_IMAGE_BYTES_MAX): Promise<string | null> {
  const used = Number(
    (await tx.query<{ n: string }>('SELECT coalesce(sum(octet_length(bytes)), 0)::text AS n FROM app.link_preview_images WHERE workspace_id = $1::uuid', [workspaceId])).rows[0]?.n ?? '0',
  );
  const over = used + image.bytes.length - cap;
  if (over > 0) {
    const freed = await tx.query<{ n: number }>(
      `WITH candidates AS (
         SELECT i.id, octet_length(i.bytes) AS n,
                sum(octet_length(i.bytes)) OVER (ORDER BY i.created_at, i.id) - octet_length(i.bytes) AS before
           FROM app.link_preview_images i
          WHERE i.workspace_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM app.link_previews p WHERE p.image_id = i.id))
       DELETE FROM app.link_preview_images d USING candidates c WHERE d.id = c.id AND c.before < $2::bigint RETURNING c.n::int AS n`,
      [workspaceId, over],
    );
    const total = freed.rows.reduce((sum, r) => sum + r.n, 0);
    if (total < over) return null;
  }
  const row = (
    await tx.query<{ id: string }>('INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1::uuid, $2, $3) RETURNING id', [workspaceId, image.type, image.bytes])
  ).rows[0];
  return row?.id ?? null;
}

/** Makes (or reuses) the card of one link of one message. */
async function fetchOne(ctx: PluginContext, inTx: InTx, deps: JobDeps, workspaceId: string, messageId: string, url: string): Promise<void> {
  const p = await inTx((tx) => plan(tx, workspaceId, messageId, url));
  if (p === null) return;
  const check = egressCheck(ctx, inTx, { workspaceId, teamId: p.message.team_id, rules: p.rules, setup: p.setup });

  let cached: CacheRow | FetchedPreview | undefined = p.cached;
  let fresh: FetchedPreview | null = null;
  if (cached) {
    // A result kept from earlier does not skip the guard: the address is judged again (the workspace's rules and the pre_egress chain as they are
    // now); only the network read is saved.
    if (cached.status !== 'ok') return;
    try {
      await check(new URL(url));
    } catch (err) {
      if (err instanceof SafeFetchError) return;
      throw err;
    }
  } else {
    fresh = await fetchPreview(url, check, deps.fetchDeps, { breaker: deps.breaker, ...(deps.overallMs !== undefined ? { overallMs: deps.overallMs } : {}) });
    cached = fresh;
  }

  await inTx(async (tx) => {
    // The network took seconds: look again at everything the card depends on, in the transaction that writes it.
    const live = await loadMessage(tx, workspaceId, messageId);
    if (!live || live.deleted || live.channel_kind === 'bot_conversation') return;
    const ordinal = extractLinks(live.body).indexOf(url);
    if (ordinal < 0) return;
    const rules = await loadRules(tx, workspaceId);
    const host = hostOf(url);
    if (host === null || refusedByRules(rules, host) !== null) return;

    let imageId: string | null = null;
    let row: { status: string; title: string | null; description: string | null; site_name: string | null; image_id: string | null };
    if (fresh) {
      if (fresh.image) imageId = await storeImage(tx, workspaceId, fresh.image);
      const ttl = fresh.status === 'ok' ? OK_TTL_MS : fresh.reason === 'host_cooling' ? COOLING_TTL_MS : FAIL_TTL_MS;
      await tx.query(
        `INSERT INTO app.link_preview_cache (workspace_id, url, status, reason, final_url, title, description, site_name, image_id, fetched_at, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, now(), now() + $10::float8 * interval '1 millisecond')
         ON CONFLICT (workspace_id, url) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, final_url = EXCLUDED.final_url, title = EXCLUDED.title,
           description = EXCLUDED.description, site_name = EXCLUDED.site_name, image_id = EXCLUDED.image_id, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [workspaceId, url, fresh.status, fresh.reason, fresh.finalUrl, fresh.title, fresh.description, fresh.siteName, imageId, ttl],
      );
      row = { status: fresh.status, title: fresh.title, description: fresh.description, site_name: fresh.siteName, image_id: imageId };
    } else {
      const c = cached as CacheRow;
      // the picture the cache row pointed at may have been dropped for space since the first look
      if (c.image_id) imageId = (await tx.query<{ id: string }>('SELECT id FROM app.link_preview_images WHERE id = $1::uuid', [c.image_id])).rows[0]?.id ?? null;
      row = { ...c, image_id: imageId };
    }
    if (row.status !== 'ok') return;

    const existing = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.link_previews WHERE message_id = $1::uuid', [messageId]);
    if ((existing.rows[0]?.n ?? 0) >= LINK_PREVIEW_MAX_PER_MESSAGE) return;
    // Conditional on the message being live and unchanged since it was read a line above: an edit or a delete that committed meanwhile makes this insert nothing.
    const inserted = await tx.query(
      `INSERT INTO app.link_previews (workspace_id, channel_id, message_id, url, ordinal, host, title, description, site_name, image_id)
       SELECT $1::uuid, m.channel_id, m.id, $4::text, $5::int, $6::text, $7::text, $8::text, $9::text, $10::uuid
         FROM app.messages m
        WHERE m.id = $3::uuid AND m.workspace_id = $1::uuid AND m.deleted_at IS NULL AND m.body = $2
       ON CONFLICT (message_id, url) DO NOTHING RETURNING id`,
      [workspaceId, live.body, messageId, url, ordinal, host.replace(/^www\./, ''), row.title, row.description, row.site_name, row.image_id],
    );
    if (inserted.rows.length > 0) await pushChanged(ctx, tx, live.channel_id, messageId);
  });
}

/**
 * The workspace's rules changed: cards and kept reads of a site the rules no longer allow go (all of them when the switch is off). Cards are judged by
 * the address they were made for, not the shortened host they show. A tombstone is left (it holds no content).
 */
export async function sweepWorkspace(ctx: PluginContext, tx: PluginTx, workspaceId: string): Promise<{ cards: number; cache: number }> {
  const rules = await loadRules(tx, workspaceId);
  const refusedAddress = (url: string): boolean => {
    const host = hostOf(url);
    return host === null || refusedByRules(rules, host) !== null;
  };
  const touched = new Map<string, string>(); // message id -> channel id
  let cards = 0;
  let cache = 0;
  for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
    const page = (
      await tx.query<{ id: string; url: string; message_id: string; channel_id: string }>(
        `SELECT id, url, message_id, channel_id FROM app.link_previews WHERE workspace_id = $1::uuid AND removed_at IS NULL AND id > $2::uuid ORDER BY id LIMIT 2000`,
        [workspaceId, after],
      )
    ).rows;
    if (page.length === 0) break;
    after = (page[page.length - 1] as { id: string }).id;
    const doomed = page.filter((r) => refusedAddress(r.url));
    if (doomed.length > 0) {
      await tx.query('DELETE FROM app.link_previews WHERE id = ANY ($1::uuid[])', [doomed.map((r) => r.id)]);
      cards += doomed.length;
      for (const r of doomed) touched.set(r.message_id, r.channel_id);
    }
  }
  for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
    const page = (
      await tx.query<{ id: string; url: string }>(`SELECT id, url FROM app.link_preview_cache WHERE workspace_id = $1::uuid AND id > $2::uuid ORDER BY id LIMIT 2000`, [workspaceId, after])
    ).rows;
    if (page.length === 0) break;
    after = (page[page.length - 1] as { id: string }).id;
    const doomed = page.filter((r) => refusedAddress(r.url));
    if (doomed.length > 0) {
      await tx.query('DELETE FROM app.link_preview_cache WHERE id = ANY ($1::uuid[])', [doomed.map((r) => r.id)]);
      cache += doomed.length;
    }
  }
  // readers learn at once (a bounded number: a sweep that touched thousands of messages leaves the rest to the next time a row is shown)
  for (const [messageId, channelId] of [...touched].slice(0, 200)) await pushChanged(ctx, tx, channelId, messageId);
  return { cards, cache };
}

/** The daily sweep: cache rows past their day go, cards of deleted messages go, and pictures no card and no cache row points at any more (older than an hour: an unfinished job's own). */
export async function purge(tx: PluginTx): Promise<{ cache: number; images: number; cards: number }> {
  const cache = await tx.query('DELETE FROM app.link_preview_cache WHERE expires_at < now() RETURNING id');
  const cards = await tx.query(
    'DELETE FROM app.link_previews p USING app.messages m WHERE m.id = p.message_id AND m.deleted_at IS NOT NULL RETURNING p.id',
  );
  const images = await tx.query(
    `DELETE FROM app.link_preview_images i
      WHERE i.created_at < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM app.link_preview_cache c WHERE c.image_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM app.link_previews p WHERE p.image_id = i.id)
      RETURNING i.id`,
  );
  return { cache: cache.rows.length, images: images.rows.length, cards: cards.rows.length };
}

export function registerJobs(ctx: PluginContext, deps: JobDeps = DEFAULT_JOB_DEPS): void {
  const onMessage = (dedupe: boolean) => async (raw: PluginEvent, tx: PluginTx): Promise<void> => {
    if (!deps.enabled()) return;
    const e = SyncPayload.safeParse({ workspaceId: raw.workspaceId, messageId: raw.messageId });
    if (!e.success) return;
    await ctx.jobs.enqueue(tx, SYNC_QUEUE, e.data, dedupe ? { dedupeKey: `sync:${e.data.messageId}` } : undefined);
  };
  // Only messages of channels, direct messages and bot conversations come through here. The team inbox (spec §12.2, PLAN D6) is files filed by a
  // drop, never a channel message, so a link in a dropped document is never read by this plugin.
  ctx.events.subscribe('channel.message.posted', onMessage(true));
  ctx.events.subscribe('channel.message.edited', onMessage(false));
  ctx.events.subscribe('channel.message.deleted', onMessage(false));

  ctx.jobs.register(SYNC_QUEUE, async (payload, tx, job) => {
    if (!deps.enabled()) return;
    const p = SyncPayload.parse(payload);
    await sync(ctx, tx, deps, job.log, p.workspaceId, p.messageId);
  });
  // `detached`: the page is read with no transaction open. One job per workspace at a time, two in the process.
  ctx.jobs.register(
    FETCH_QUEUE,
    async (payload, _tx, job) => {
      if (!deps.enabled()) return;
      const p = FetchPayload.parse(payload);
      await fetchOne(ctx, (fn) => job.transaction(fn), deps, p.workspaceId, p.messageId, p.url);
    },
    { concurrency: 2, maxAttempts: 2, detached: true, serialKey: 'workspaceId' },
  );
  // The rules changed (the settings route queues one): cards and kept reads that no longer pass are removed.
  ctx.jobs.register(SWEEP_QUEUE, async (payload, tx, job) => {
    const p = SweepPayload.parse(payload);
    const swept = await sweepWorkspace(ctx, tx, p.workspaceId);
    if (swept.cards + swept.cache > 0) job.log.info(`link-preview: the rules changed, ${swept.cards} card(s) and ${swept.cache} kept read(s) removed`);
  });
  ctx.jobs.register(
    PURGE_QUEUE,
    async (_payload, tx, job) => {
      const swept = await purge(tx);
      if (swept.cache + swept.images + swept.cards > 0) job.log.info(`link-preview: purged ${swept.cache} cache row(s), ${swept.cards} card(s) of deleted messages and ${swept.images} picture(s)`);
    },
    { cron: PURGE_CRON, maxAttempts: 1 },
  );
}
