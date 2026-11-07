import { PANEL_PARAM } from '../../kernel/panel';

/*
 * The Files screen has two top levels: Personal (one person's own files) and Teams (one branch per team the person can read). A space is named by a
 * key: `~me` for Personal, a team's slug for a team. `~` is not a character a slug can hold, so the two never meet.
 */
export const PERSONAL = '~me';
export const isPersonalKey = (key: string): boolean => key === PERSONAL;

/** An admin looking into someone's Personal space during an audited open: the key carries the person. */
export const ADMIN_VIEW_PREFIX = '~person:';
export const adminViewKey = (personId: string): string => `${ADMIN_VIEW_PREFIX}${personId}`;
export const adminViewPerson = (key: string): string | null => (key.startsWith(ADMIN_VIEW_PREFIX) ? key.slice(ADMIN_VIEW_PREFIX.length) : null);

/**
 * A right-panel entry names a file by a repo path (a team's file), a file id (an attachment) or, for a Personal file, `~me/<path>`. The History
 * panel's id follows the same rule, so a Personal file's versions open in the panel that already shows a repo file's commits.
 */
const PERSONAL_PANEL = `${PERSONAL}/`;
export const personalPanelId = (path: string): string => `${PERSONAL_PANEL}${path}`;
export function parsePanelId(id: string): { space: 'personal' | 'team'; path: string } {
  return id.startsWith(PERSONAL_PANEL) ? { space: 'personal', path: id.slice(PERSONAL_PANEL.length) } : { space: 'team', path: id };
}

/** The Files link of a space. A team's lives under its own address (`/t/<team>/files`); Personal under `/files`. The route says which space is open, so no parameter does. */
export function spaceHref(space: string, opts: { folder?: string; open?: string; panel?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.folder) q.set('path', opts.folder);
  if (opts.open) q.set('open', opts.open);
  if (opts.panel) q.set(PANEL_PARAM, opts.panel);
  const s = q.toString();
  if (isPersonalKey(space)) return `/files${s ? `?${s}` : ''}`;
  return `/t/${encodeURIComponent(space)}/files${s ? `?${s}` : ''}`;
}
