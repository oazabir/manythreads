import {
  KEYWORD_MAX_COUNT,
  KEYWORD_PROBLEM_TEXT,
  effectiveLevel,
  normalizeKeyword,
  type ChannelLevelEntry,
  type GetNotificationLevelsResponse,
  type NotificationLevel,
} from '@manythreads/shared';

/*
 * The rules behind the Notifications settings and the channel bell menu (PLAN P14-09), kept apart from the screens so they can be tested
 * without a browser: what a typed list of keywords turns into, which level applies to a channel, what the browser can do about push.
 */

// Keywords --------------------------------------------------------------------------------------------------------------------------

/** Splits what a person typed (commas or new lines between keywords) into stored keywords, with a sentence for each one that cannot be used. */
export function parseKeywordInput(text: string): { keywords: string[]; problems: string[] } {
  const keywords: string[] = [];
  const problems: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const piece = raw.trim();
    if (piece === '') continue;
    const one = normalizeKeyword(piece);
    if ('problem' in one) problems.push(`“${piece.slice(0, 30)}”: ${KEYWORD_PROBLEM_TEXT[one.problem]}`);
    else if (!keywords.includes(one.keyword)) keywords.push(one.keyword);
  }
  if (keywords.length > KEYWORD_MAX_COUNT) problems.push(`You can keep at most ${KEYWORD_MAX_COUNT} keywords.`);
  return { keywords: keywords.slice(0, KEYWORD_MAX_COUNT), problems };
}

/** Adds one keyword to a list (the "Add" box). Returns the new list or the reason it was refused. */
export function addKeyword(list: readonly string[], input: string): { keywords: string[] } | { problem: string } {
  const one = normalizeKeyword(input);
  if ('problem' in one) return { problem: KEYWORD_PROBLEM_TEXT[one.problem] };
  if (list.includes(one.keyword)) return { keywords: [...list] };
  if (list.length >= KEYWORD_MAX_COUNT) return { problem: `You can keep at most ${KEYWORD_MAX_COUNT} keywords.` };
  return { keywords: [...list, one.keyword].sort() };
}

// Levels ----------------------------------------------------------------------------------------------------------------------------

export const LEVEL_ORDER: readonly NotificationLevel[] = ['all', 'mentions', 'nothing'];

/** One line under each level, in plain words. */
export const LEVEL_HELP: Record<NotificationLevel, string> = {
  all: 'Every new message tells you.',
  mentions: 'Only when someone names you, uses one of your keywords, or replies in a thread you follow.',
  nothing: 'Nothing from this channel tells you, even a mention.',
};

/** The level that applies to a channel for this person, and whether it is their own choice. */
export function levelOf(levels: GetNotificationLevelsResponse | null, channelId: string, channelKind: string): { own: NotificationLevel | null; effective: NotificationLevel } {
  const workspaceDefault = levels?.workspaceDefault ?? 'mentions';
  const own = levels?.channels.find((c) => c.channelId === channelId)?.level ?? null;
  return { own, effective: effectiveLevel(own, channelKind, workspaceDefault) };
}

/** The levels after the person set one channel (`null` removes their choice). Their newest change comes first. */
export function withChannelLevel(levels: GetNotificationLevelsResponse, channel: Pick<ChannelLevelEntry, 'channelName' | 'channelKind'> & { channelId: string }, level: NotificationLevel | null): GetNotificationLevelsResponse {
  const others = levels.channels.filter((c) => c.channelId !== channel.channelId);
  return { ...levels, channels: level === null ? others : [{ ...channel, channelId: channel.channelId as ChannelLevelEntry['channelId'], level }, ...others] };
}

/** The title of a channel in the list of the person's own choices: `#name`, or "Direct message". */
export const channelTitle = (c: Pick<ChannelLevelEntry, 'channelName' | 'channelKind'>): string =>
  c.channelName ? `#${c.channelName.replace(/^#/, '')}` : c.channelKind === 'dm' ? 'Direct message' : 'Conversation';

// Browser push ----------------------------------------------------------------------------------------------------------------------

/** What this browser allows, as the settings screen needs it. */
export type PushSupport =
  | 'unsupported' // no service worker or push in this browser (an old WebView, a private window)
  | 'unavailable' // the server has no signing key, so it cannot send
  | 'blocked' // the person refused notifications in the browser's own settings
  | 'ready';

export function pushSupport(env: { serviceWorker: boolean; pushManager: boolean; permission: NotificationPermission | 'unsupported'; serverAvailable: boolean }): PushSupport {
  if (!env.serviceWorker || !env.pushManager || env.permission === 'unsupported') return 'unsupported';
  if (!env.serverAvailable) return 'unavailable';
  if (env.permission === 'denied') return 'blocked';
  return 'ready';
}

export const PUSH_SUPPORT_TEXT: Record<Exclude<PushSupport, 'ready'>, string> = {
  unsupported: 'This browser cannot receive push notifications.',
  unavailable: 'Push notifications are not set up on this server. Ask a workspace admin.',
  blocked: 'Notifications are blocked for this site in your browser’s settings. Allow them there, then come back.',
};

/** The server's public key (URL-safe base64) as the bytes `pushManager.subscribe` wants. */
export function keyBytes(key: string): Uint8Array {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=');
  const raw = atob(base64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/** Where a push click should land: only a path of this site that opens a message (`/open?...`), whatever the push said. */
export function safeOpenPath(url: string, origin: string): string {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin || parsed.pathname !== '/open') return '/';
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

/** A short label for a browser, for the list of devices (no identifiers, just the family). */
export function browserLabel(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Browser';
}
