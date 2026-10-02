import { PANEL_PARAM } from '../../kernel/panel';

/** `/t/<team>/files` with the folder in `?path=`, a file open in the centre in `?open=`, and optionally a panel entry. */
export function filesHref(slug: string, opts: { folder?: string; open?: string; panel?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.folder) q.set('path', opts.folder);
  if (opts.open) q.set('open', opts.open);
  if (opts.panel) q.set(PANEL_PARAM, opts.panel);
  const s = q.toString();
  return `/t/${encodeURIComponent(slug)}/files${s ? `?${s}` : ''}`;
}
