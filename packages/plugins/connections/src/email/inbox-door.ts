import { conflict, forbidden, json, route, type PluginContext } from '@manythreads/sdk';
import { CONNECTION_ADMIN_ONLY, SetUpInboxMailResponse, setUpInboxMailRoute } from '@manythreads/shared';

// The workspace mailbox the teams' memory inboxes take mail on (PLAN P8-19). It is one `email` connection with workspace scope and the short name `inbox`; every
// team's address is made from it (`inbox+<team>@<mail domain>`, the memory-inbox plugin builds it). It holds no password: mail comes IN through the delivery door of
// the memory inbox (the mail transport pushes a received message there), so there is nothing to store and nothing to read back. This route only switches it on, once,
// and leaves the same audit line as any other change of a connection. docs/plugins/connections.md.

const MAILBOX = { slug: 'inbox', name: 'Team inbox mail' } as const;

interface Row extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
}

export function registerInboxDoorSetup(ctx: PluginContext): void {
  ctx.http.route({
    ...setUpInboxMailRoute,
    schema: { response: SetUpInboxMailResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden(CONNECTION_ADMIN_ONLY);
      const workspaceId = tx.actor.workspaceId;
      const find = async (): Promise<Row | undefined> =>
        (await tx.query<Row>(`SELECT id, workspace_id, kind, status FROM app.connections WHERE workspace_id = $1 AND scope = 'workspace' AND slug = $2`, [workspaceId, MAILBOX.slug])).rows[0];
      let row = await find();
      let created = false;
      if (row && row.kind !== 'email') throw conflict('The workspace already has a connection called “inbox” that is not a mailbox. Rename or remove it first.');
      if (!row) {
        row = (
          await tx.query<Row>(
            `INSERT INTO app.connections (workspace_id, team_id, slug, kind, name, scope, owner_id, status)
             VALUES ($1, NULL, $2, 'email', $3, 'workspace', $4, 'enabled')
             ON CONFLICT (workspace_id, slug) WHERE scope = 'workspace' DO NOTHING
             RETURNING id, workspace_id, kind, status`,
            [workspaceId, MAILBOX.slug, MAILBOX.name, tx.actor.id],
          )
        ).rows[0];
        created = row !== undefined;
        row = row ?? (await find());
      } else if (row.status !== 'enabled') {
        await tx.query(`UPDATE app.connections SET status = 'enabled', updated_at = now() WHERE id = $1`, [row.id]);
      }
      if (!row) throw conflict('The mailbox could not be set up. Try again.');
      if (created || row.status !== 'enabled') {
        await ctx.audit.emit(tx, {
          type: 'connections.connection.changed',
          workspaceId: row.workspace_id,
          teamId: null,
          connectionId: row.id,
          slug: MAILBOX.slug,
          kind: 'email',
          scope: 'workspace',
          change: created ? 'created' : 'switched',
          actorId: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      const domain = (process.env['MANYTHREADS_MAIL_DOMAIN'] ?? '').trim().toLowerCase();
      return json(SetUpInboxMailResponse.parse({ connection: MAILBOX, created, domain: /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ? domain : 'mail.manythreads.invalid' }), created ? 201 : 200);
    }),
  });
}
