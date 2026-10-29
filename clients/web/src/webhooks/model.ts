import type { Webhook } from '@manythreads/shared';

/** "just now", "5 minutes ago", "3 days ago" -- plain words for when a webhook was last used. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** What the "last used" line says for a webhook. */
export function useLine(h: Pick<Webhook, 'lastUsedAt' | 'lastStatus' | 'postedCount'>, now: number = Date.now()): string {
  if (h.lastUsedAt === null) return 'Never used yet';
  const when = ago(h.lastUsedAt, now);
  const posted = `${h.postedCount} ${h.postedCount === 1 ? 'message' : 'messages'} posted`;
  if (h.lastStatus === 'failed') return `Last call ${when} could not be posted · ${posted}`;
  if (h.lastStatus === 'ignored') return `Last call ${when} was skipped (an event this webhook does not show) · ${posted}`;
  return `Last used ${when} · ${posted}`;
}

/** A copy-and-paste example for the address `url` (the real one just after it is made, a placeholder otherwise). */
export function curlExample(url: string): string {
  return [`curl -X POST '${url}' \\`, `  -H 'Content-Type: application/json' \\`, `  -d '{"title": "Build finished", "text": "All checks passed on main", "status": "success", "url": "https://ci.example.com/runs/42"}'`].join('\n');
}

export const PLACEHOLDER_URL = 'https://your-site.example/hooks/<id>/<secret>';
