import type { PluginContext, ResolvedEntity } from '@manythreads/sdk';

const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** `2.1 MB`: binary megabytes, one decimal from 1 KB up. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * The entity-link resolver for `file` (`[[file]]` chips, links from messages and tasks): runs as the caller, so a file in a channel they
 * cannot read resolves to nothing. The href opens the file panel of the channel that holds it (`?panel=file:<id>`); a DM file has none.
 */
export function registerFileLinks(ctx: PluginContext): void {
  ctx.links.registerResolver('file', async (tx, id): Promise<ResolvedEntity | null> => {
    if (!isUuid(id)) return null;
    const res = await tx.query<{ name: string; size: string; channel_name: string | null; channel_kind: string | null; team_slug: string | null }>(
      `SELECT f.name, f.size, c.name AS channel_name, c.kind AS channel_kind,
              (SELECT t.slug FROM app.teams t WHERE t.id = f.team_id) AS team_slug
         FROM app.files f LEFT JOIN app.channels c ON c.id = f.channel_id WHERE f.id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    const where = r.channel_kind === 'channel' && r.channel_name ? `#${r.channel_name} · ` : '';
    return {
      title: r.name,
      subtitle: `${where}${humanSize(Number(r.size))}`,
      href:
        r.channel_kind === 'channel' && r.team_slug && r.channel_name
          ? `/t/${r.team_slug}/c/${encodeURIComponent(r.channel_name)}?panel=file:${id}`
          : null,
    };
  });
}
