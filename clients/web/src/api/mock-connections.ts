import {
  CONNECTION_ADMIN_ONLY,
  connectionKindInfo,
  createConnectionRoute,
  deleteConnectionRoute,
  listConnectionsRoute,
  listMyConnectionsRoute,
  putConnectionCredentialRoute,
  updateConnectionRoute,
} from '@manythreads/shared';

/*
 * The mock of the Connections pages (P8-06): the same routes, shapes and words the connections plugin answers with. A team's connections are readable by its members
 * and written by a workspace admin only. A credential goes in and is never handed back: the mock keeps only that one is stored. A person's own connections are
 * theirs alone; the server has no way to add one yet, so there are none until it does.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type ConnectionsMockHooks = {
  workspaceId: string;
  isAdmin(): boolean;
  /** The signed-in person’s actor id (the owner of a connection they make). */
  actorId(): string;
  /** The team behind a slug, as the signed-in person may see it (the same refusals as every team route). */
  team(slug: string | undefined): { id: string; slug: string };
  nextId(): string;
  now: string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

type Row = {
  id: string;
  workspaceId: string;
  teamId: string | null;
  slug: string;
  kind: string;
  name: string;
  scope: 'team' | 'person';
  ownerId: string;
  status: 'enabled' | 'disabled';
  environment: 'production' | 'staging' | 'development' | 'test';
  expiresAt: string | null;
  expired: boolean;
  hasCredentials: boolean;
  createdAt: string;
};

const created = (body: unknown): Reply => ({ status: 201, body });

export function installConnectionsMock(on: On, h: ConnectionsMockHooks): void {
  const rows: Row[] = [];
  const seeded = new Set<string>();
  /** The Engineering team starts with one mailbox that is on, so the page and the bot tab have something to show. */
  const seed = (team: { id: string; slug: string }): void => {
    if (seeded.has(team.slug)) return;
    seeded.add(team.slug);
    if (team.slug !== 'engineering') return;
    rows.push({
      id: h.nextId(), workspaceId: h.workspaceId, teamId: team.id, slug: 'support-mail', kind: 'email', name: 'Support mailbox', scope: 'team', ownerId: h.actorId(),
      status: 'enabled', environment: 'production', expiresAt: null, expired: false, hasCredentials: true, createdAt: h.now,
    });
  };
  const body = (r: Row): Row => ({ ...r, expired: r.expiresAt !== null && Date.parse(r.expiresAt) < Date.parse(h.now) });
  const find = (id: string | undefined): Row => {
    const r = rows.find((x) => x.id === id);
    if (!r) h.fail(404, 'not_found', 'No such connection.');
    return r;
  };
  /** A team’s connection is changed by a workspace admin; a person’s own by the person. Anyone else is told what to do, in plain words. */
  const mayChange = (r: Row): void => {
    if (r.scope === 'person') {
      if (r.ownerId !== h.actorId()) h.fail(404, 'not_found', 'No such connection.');
      return;
    }
    if (!h.isAdmin()) h.fail(403, 'forbidden', CONNECTION_ADMIN_ONLY);
  };
  const freeSlug = (teamId: string, base: string): string => {
    let slug = base;
    for (let n = 2; rows.some((r) => r.teamId === teamId && r.slug === slug); n++) slug = `${base.slice(0, 60)}-${String(n)}`;
    return slug;
  };

  on(listConnectionsRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    return { connections: rows.filter((r) => r.teamId === team.id && r.scope === 'team').map(body) };
  });
  on(listMyConnectionsRoute, () => ({ connections: rows.filter((r) => r.scope === 'person' && r.ownerId === h.actorId()).map(body) }));

  on(createConnectionRoute, ({ params, body: b }) => {
    const team = h.team(params['slug']);
    seed(team);
    if (!h.isAdmin()) h.fail(403, 'forbidden', CONNECTION_ADMIN_ONLY);
    const kind = connectionKindInfo(String(b['kind']));
    if (!kind) h.fail(400, 'validation_failed', 'That kind of connection does not exist.');
    if (!kind.available) h.fail(409, 'conflict', kind.unavailableReason ?? 'That kind of connection is not available yet.');
    const name = String(b['name'] ?? '').trim();
    if (name === '') h.fail(400, 'validation_failed', 'Give the connection a name.');
    const wanted = typeof b['slug'] === 'string' ? b['slug'] : null;
    if (wanted !== null && rows.some((r) => r.teamId === team.id && r.slug === wanted)) h.fail(409, 'conflict', 'This team already has a connection with that short name. Pick a different one.');
    const base = wanted ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'connection');
    const row: Row = {
      id: h.nextId(), workspaceId: h.workspaceId, teamId: team.id, slug: wanted ?? freeSlug(team.id, base), kind: kind.kind, name, scope: 'team', ownerId: h.actorId(), status: 'disabled',
      environment: (b['environment'] as Row['environment'] | undefined) ?? 'production', expiresAt: (b['expiresAt'] as string | null | undefined) ?? null, expired: false, hasCredentials: false, createdAt: h.now,
    };
    rows.push(row);
    return created({ connection: body(row) });
  });

  on(updateConnectionRoute, ({ params, body: b }) => {
    const r = find(params['id']);
    mayChange(r);
    if (b['status'] === 'enabled' && !r.hasCredentials) h.fail(409, 'conflict', 'Put the credential in first: a connection with nothing stored cannot be switched on.');
    if (typeof b['name'] === 'string') r.name = b['name'].trim();
    if (b['status'] === 'enabled' || b['status'] === 'disabled') r.status = b['status'];
    if (typeof b['environment'] === 'string') r.environment = b['environment'] as Row['environment'];
    if (b['expiresAt'] !== undefined) r.expiresAt = b['expiresAt'] as string | null;
    return { connection: body(r) };
  });

  on(putConnectionCredentialRoute, ({ params, body: b }) => {
    const r = find(params['id']);
    mayChange(r);
    const kind = connectionKindInfo(r.kind);
    if (!kind?.credentials.some((c) => c.name === params['name'])) h.fail(400, 'validation_failed', `A ${kind?.label.toLowerCase() ?? 'connection'} has no credential called "${params['name'] ?? ''}".`);
    if (typeof b['value'] !== 'string' || b['value'] === '') h.fail(400, 'validation_failed', 'The credential cannot be empty.');
    // the value is dropped here on purpose: only the fact that one is stored is kept
    r.hasCredentials = true;
    return { connection: body(r) };
  });

  on(deleteConnectionRoute, ({ params }) => {
    const r = find(params['id']);
    mayChange(r);
    rows.splice(rows.indexOf(r), 1);
    return { deleted: true };
  });
}
