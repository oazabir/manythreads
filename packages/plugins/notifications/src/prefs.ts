import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefs, type NotificationKind } from '@manythreads/shared';

/**
 * Settings as stored, made whole: a document written by an older or newer version (a missing kind, an extra key, a wrong type)
 * falls back to the defaults for what it does not say properly, never to an error.
 */
export function normalizePrefs(raw: unknown): NotificationPrefs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_NOTIFICATION_PREFS;
  const stored = raw as Record<string, unknown>;
  const merged = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const kind of ['mention', 'reply', 'dm'] as const) {
    const one = NotificationPrefs.shape[kind].safeParse(stored[kind]);
    if (one.success) merged[kind] = one.data;
  }
  const muted = NotificationPrefs.shape.mutedChannels.safeParse(stored['mutedChannels']);
  if (muted.success) merged.mutedChannels = muted.data;
  return merged;
}

/** Does a person with these settings want `kind` for a message in `channelId`, in the app? */
export function wantsInApp(prefs: NotificationPrefs, kind: NotificationKind, channelId: string): boolean {
  return prefs[kind].inApp && !prefs.mutedChannels.some((id) => id === channelId);
}
