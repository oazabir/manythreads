import type { DeployOutcome, DeployScope, DeployStep, PluginContext, PluginTx } from '@manythreads/sdk';
import { CONNECTION_COLUMNS, isUsable, type ConnectionRow } from './rows.ts';
import { CREDENTIAL_FIRST, enableConnection } from './routes.ts';

// The connection step of the bot page's Deploy action (PLAN P8-34): "enable the connection" is what `PATCH /api/connections/:id { status: 'enabled' }` does, with the same rules: a
// workspace admin's act, refused until a credential is stored. Nothing is created and no credential is set here. A connection that is already on and usable is `unchanged`; the
// connection's state stays `connections.status` and nothing else.

const quoted = (slug: string): string => `“${slug}”`;

async function connectionOf(tx: PluginTx, teamId: string, slug: string): Promise<ConnectionRow | undefined> {
  return (await tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM app.connections c WHERE c.scope = 'team' AND c.team_id = $1::uuid AND c.slug = $2`, [teamId, slug])).rows[0];
}

/** Why this connection cannot be on after a deploy, or null. Reads only. */
async function problemWith(tx: PluginTx, teamId: string, slug: string, isAdmin: boolean): Promise<string | null> {
  const row = await connectionOf(tx, teamId, slug);
  if (!row) return `This team has no connection called ${quoted(slug)}. A workspace admin adds it on the team's Connections page.`;
  if (isUsable(row)) return null;
  if (row.expired) return `The connection ${quoted(slug)} has expired. A workspace admin renews it on the team's Connections page.`;
  if (!row.has_credentials) return `The connection ${quoted(slug)} has no credential stored. ${CREDENTIAL_FIRST}`;
  if (!isAdmin) return `The connection ${quoted(slug)} is switched off, and only a workspace admin can switch it on.`;
  return null;
}

async function isWorkspaceAdmin(tx: PluginTx): Promise<boolean> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  return role === 'owner' || role === 'admin';
}

export function createConnectionDeployStep(ctx: PluginContext): DeployStep {
  return {
    id: 'connection',

    async check(tx: PluginTx, scope: DeployScope): Promise<string | null> {
      if (scope.connections.length === 0) return null;
      const admin = await isWorkspaceAdmin(tx);
      for (const slug of scope.connections) {
        const problem = await problemWith(tx, scope.team.id, slug, admin);
        if (problem !== null) return problem;
      }
      return null;
    },

    async apply(tx: PluginTx, scope: DeployScope): Promise<DeployOutcome> {
      if (scope.connections.length === 0) return { state: 'not_used', message: 'This bot uses no connection, so there is nothing to switch on.' };
      const admin = await isWorkspaceAdmin(tx);
      let changed = false;
      const lines: string[] = [];
      for (const slug of scope.connections) {
        const problem = await problemWith(tx, scope.team.id, slug, admin);
        if (problem !== null) return { state: 'refused', message: problem };
        const row = (await connectionOf(tx, scope.team.id, slug)) as ConnectionRow;
        if (isUsable(row)) {
          lines.push(`The connection ${quoted(slug)} is already on.`);
          continue;
        }
        await enableConnection(ctx, tx, row);
        changed = true;
        lines.push(`The connection ${quoted(slug)} is switched on.`);
      }
      return { state: changed ? 'changed' : 'unchanged', message: lines.join(' ') };
    },
  };
}
