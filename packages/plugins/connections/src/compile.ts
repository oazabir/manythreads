import type { PluginTx } from '@manythreads/sdk';
import { z } from 'zod';
import { kindServes, TOOLS } from './kinds.ts';

// Compile what a bot's BOT.md asks of its connections into rows (PLAN P8-28). The bots loader projects `capabilities.connections` into `app.bots.connections`;
// this runs when a bot is loaded (and when a connection appears that a definition was waiting for) and writes, in the same transaction:
//
//   connection_grants   the bot, the connection, the tool, whether it waits for a person (this plugin's own table, which the source reads);
//   capability_grants   the broker's row for the same tool, with `constraints: { connection: <slug> }` so a reader can see where it came from.
//
// What it refuses, quietly and by name (the `skipped` list, never a thrown error: one bad line must not stop the others, and the definition was already accepted
// by the loader): a connection that does not exist on the bot's own team, a tool the connection's kind does not serve, a tool nobody declared, a destructive
// tool (the broker never grants one, and a connection must not be a way around that), and a wildcard. `person:*` (the asking person's own connections) is not
// compiled here: it grants nothing until the person-connection work lands. Idempotent: running it twice leaves the same rows.

const Projection = z.array(
  z.object({
    connection: z.string(),
    tools: z.array(z.string()),
    needsApproval: z.array(z.string()).optional(),
  }),
);

export interface Skipped {
  connection: string;
  tool: string | null;
  reason: 'no_such_connection' | 'person_connections_not_built' | 'tool_not_served' | 'tool_not_declared' | 'tool_destructive' | 'wildcard';
}

export interface CompileResult {
  granted: Array<{ tool: string; connection: string; needsApproval: boolean }>;
  skipped: Skipped[];
}

/** The capabilities this plugin's manifest declares, with their destructive tag: the one list a grant may name. */
export type Declared = ReadonlyMap<string, { destructive: boolean }>;

const OWN_TOOLS = new Set(TOOLS.map((t) => t.name));

/** Compiles one bot's connection list. `tx` is a system transaction (the event consumer's). Returns what it granted and what it refused. */
export async function compileBot(tx: PluginTx, declared: Declared, ids: { workspaceId: string; teamId: string; botId: string }): Promise<CompileResult> {
  const bot = (
    await tx.query<{ connections: unknown; actor_id: string }>(
      `SELECT b.connections, a.id AS actor_id
         FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
        WHERE b.id = $1 AND b.team_id = $2 AND b.workspace_id = $3`,
      [ids.botId, ids.teamId, ids.workspaceId],
    )
  ).rows[0];
  const result: CompileResult = { granted: [], skipped: [] };
  if (!bot) return result; // the bot is gone: `dropBot` clears what it had
  const parsed = Projection.safeParse(bot.connections ?? []);
  // A projection this code cannot read grants nothing and removes what was there: fail closed.
  const asked = parsed.success ? parsed.data : [];

  const connections = new Map(
    (
      await tx.query<{ id: string; slug: string; kind: string }>(
        `SELECT id, slug, kind FROM app.connections WHERE team_id = $1 AND workspace_id = $2 AND scope = 'team'`,
        [ids.teamId, ids.workspaceId],
      )
    ).rows.map((c) => [c.slug, c]),
  );

  const wanted = new Map<string, { connectionId: string; slug: string; needsApproval: boolean }>();
  for (const entry of asked) {
    if (entry.connection === 'person:*') {
      result.skipped.push({ connection: entry.connection, tool: null, reason: 'person_connections_not_built' });
      continue;
    }
    const connection = connections.get(entry.connection);
    if (!connection) {
      result.skipped.push({ connection: entry.connection, tool: null, reason: 'no_such_connection' });
      continue;
    }
    for (const tool of entry.tools) {
      const skip = (reason: Skipped['reason']): void => void result.skipped.push({ connection: entry.connection, tool, reason });
      if (tool.includes('*')) skip('wildcard');
      else if (!declared.has(tool) || !OWN_TOOLS.has(tool)) skip('tool_not_declared');
      else if (declared.get(tool)!.destructive) skip('tool_destructive');
      else if (!kindServes(connection.kind, tool)) skip('tool_not_served');
      else if (wanted.has(tool)) continue; // the definition names it twice; the first wins (the shared parser refuses this earlier)
      else wanted.set(tool, { connectionId: connection.id, slug: connection.slug, needsApproval: (entry.needsApproval ?? []).includes(tool) });
    }
  }

  const tools = [...wanted.keys()];
  // what the bot had and no longer asks for goes first (a tool, or the same tool through another connection, is replaced below)
  await tx.query('DELETE FROM app.connection_grants WHERE actor_id = $1 AND tool <> ALL ($2::text[])', [bot.actor_id, tools]);
  await tx.query(`DELETE FROM app.capability_grants WHERE actor_id = $1 AND constraints ? 'connection' AND capability <> ALL ($2::text[])`, [bot.actor_id, tools]);
  for (const [tool, want] of wanted) {
    await tx.query(
      `INSERT INTO app.connection_grants (workspace_id, connection_id, team_id, actor_id, tool, needs_approval)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (actor_id, tool) DO UPDATE SET connection_id = EXCLUDED.connection_id, needs_approval = EXCLUDED.needs_approval`,
      [ids.workspaceId, want.connectionId, ids.teamId, bot.actor_id, tool, want.needsApproval],
    );
    await tx.query(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (actor_id, capability) DO UPDATE SET team_id = EXCLUDED.team_id, needs_approval = EXCLUDED.needs_approval, constraints = EXCLUDED.constraints`,
      [ids.teamId, bot.actor_id, tool, want.needsApproval, JSON.stringify({ connection: want.slug })],
    );
    result.granted.push({ tool, connection: want.slug, needsApproval: want.needsApproval });
  }
  return result;
}

/** Compiles every bot of a team that asks for connections: for when a connection appears that a definition was waiting for. */
export async function compileTeam(tx: PluginTx, declared: Declared, ids: { workspaceId: string; teamId: string }): Promise<void> {
  const bots = await tx.query<{ id: string }>(
    `SELECT id FROM app.bots WHERE team_id = $1 AND workspace_id = $2 AND connections IS NOT NULL AND jsonb_array_length(connections) > 0`,
    [ids.teamId, ids.workspaceId],
  );
  for (const bot of bots.rows) await compileBot(tx, declared, { ...ids, botId: bot.id });
}

/** A bot's definition was deleted: whatever it held through connections goes (the loader already removed its membership, which cascades; this makes it certain). */
export async function dropBot(tx: PluginTx, ids: { workspaceId: string; botId: string }): Promise<void> {
  const actors = `SELECT id FROM app.actors WHERE kind = 'bot' AND workspace_id = $1 AND ref_id = $2`;
  await tx.query(`DELETE FROM app.connection_grants WHERE actor_id IN (${actors})`, [ids.workspaceId, ids.botId]);
  await tx.query(`DELETE FROM app.capability_grants WHERE constraints ? 'connection' AND actor_id IN (${actors})`, [ids.workspaceId, ids.botId]);
}
