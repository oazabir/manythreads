import { Connection } from '@manythreads/shared';

// Database rows and how they become the API's shape. The one mapper for `app.connections`: it names every column it reads, so a column added later (a
// credential, say) is not returned by accident, and the answer is parsed by the strict `Connection` schema, which has no field a secret could ride in.

export type ConnectionRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  slug: string;
  kind: string;
  name: string;
  scope: 'team' | 'person' | 'workspace';
  owner_id: string;
  status: 'enabled' | 'disabled';
  environment: 'production' | 'staging' | 'development' | 'test';
  expires_at: Date | null;
  expired: boolean;
  has_credentials: boolean;
  created_at: Date;
  [key: string]: unknown;
};

/** The columns of a connection, with `expired` worked out by the database's clock (the one clock every expiry check uses). */
export const CONNECTION_COLUMNS = `c.id, c.workspace_id, c.team_id, c.slug, c.kind, c.name, c.scope, c.owner_id, c.status, c.environment, c.expires_at,
  (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired, c.has_credentials, c.created_at`;

export function toConnection(row: ConnectionRow): Connection {
  return Connection.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    ownerId: row.owner_id,
    status: row.status,
    environment: row.environment,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    expired: row.expired,
    hasCredentials: row.has_credentials,
    createdAt: row.created_at.toISOString(),
  });
}

/** True when a connection may be used right now: switched on, a credential stored, and not past its end. Every place that decides "usable" asks this one function. */
export const isUsable = (row: Pick<ConnectionRow, 'status' | 'expired' | 'has_credentials'>): boolean =>
  row.status === 'enabled' && !row.expired && row.has_credentials;
