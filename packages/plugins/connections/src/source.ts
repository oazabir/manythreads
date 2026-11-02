import { forbidden, invalid, type BotRunHandle, type PluginTx, type ToolSource } from '@manythreads/sdk';
import { inputProblem, kindOf, kindServes, TOOLS } from './kinds.ts';
import { CONNECTION_COLUMNS, isUsable, type ConnectionRow } from './rows.ts';
import { readConnectionSecret, type SecretDeps } from './secrets.ts';

// The connections plugin as a source of tools (PLAN P8-28, the `ToolSource` seam of P8-01). The gateway asks `offered` which tools a bot's grants let it list, and
// hands `call` the tool a bot (or the person who asked) invoked AFTER the capability broker said yes. The two checks are independent and both must pass:
//
//   the broker      is the tool granted to this bot (a `capability_grants` row the compile wrote), is it destructive, does it wait for a person;
//   this source     is there a grant row for this bot and tool, on a connection of the bot's own team, that is switched on, not expired and holds a credential.
//
// Both run in the transaction the gateway chose, under the caller's own row-level security: a bot's transaction for a write and a listing, the ASKING PERSON's
// transaction for a read. So what a read can reach is the bot's grant intersected with what that person may see: a person who has left the team sees no grant
// row, and the call is refused. Nothing here widens a transaction or reads as the system role except the one credential, and only inside the kind that needs it.

/** The grant of a bot to a tool, with the connection it goes through. One row at most: a bot has one connection per tool (unique actor + tool). */
const GRANTED = `
  SELECT ${CONNECTION_COLUMNS}
    FROM app.connection_grants g
    JOIN app.connections c ON c.id = g.connection_id AND c.team_id = g.team_id
   WHERE g.actor_id = $1 AND g.team_id = $2 AND g.tool = $3 AND c.scope = 'team'`;

export function createConnectionsSource(deps: SecretDeps): ToolSource {
  return {
    id: 'connections',
    tools: TOOLS,

    async offered(tx: PluginTx, run: BotRunHandle): Promise<readonly string[]> {
      const rows = await tx.query<Pick<ConnectionRow, 'status' | 'expired' | 'has_credentials' | 'kind'> & { tool: string }>(
        `SELECT g.tool, c.kind, c.status, c.has_credentials, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired
           FROM app.connection_grants g
           JOIN app.connections c ON c.id = g.connection_id AND c.team_id = g.team_id
          WHERE g.actor_id = $1 AND g.team_id = $2 AND c.scope = 'team'`,
        [run.botActorId, run.teamId],
      );
      return rows.rows.filter((r) => isUsable(r) && kindServes(r.kind, r.tool)).map((r) => r.tool);
    },

    async call(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<unknown> {
      const granted = (await tx.query<ConnectionRow>(GRANTED, [run.botActorId, run.teamId, tool])).rows[0];
      // The same answer for "no grant", "a grant you may not see" and "a connection of another team": a refusal never says which of them it was.
      if (!granted) throw forbidden(`“${tool}” is not available to this bot through any connection you may use.`);
      if (!isUsable(granted)) throw forbidden(`The connection “${granted.slug}” is switched off, has expired or has no credential, so “${tool}” cannot run.`);
      const kind = kindOf(granted.kind);
      if (!kind || !kind.tools.includes(tool)) throw forbidden(`The connection “${granted.slug}” cannot serve “${tool}”.`);
      // The arguments are the model's: they are held to the schema the model was shown before a kind sees them (a refusal names the fields, never a value).
      const problem = inputProblem(tool, input);
      if (problem !== null) throw invalid(`The arguments of “${tool}” are not valid: ${problem}`);
      return kind.call({
        tool,
        input,
        connection: granted,
        tx,
        run,
        credential: (name) => readConnectionSecret(deps, { workspaceId: run.workspaceId, connectionId: granted.id, name }),
      });
    },
  };
}
