import type { PersonProviderId } from '@manythreads/shared';
import { forbidden, invalid, type BotRunHandle, type PluginTx, type ToolApprovalCard, type ToolSource } from '@manythreads/sdk';
import { inputProblem, kindOf, kindServes, TOOLS } from './kinds.ts';
import { createProviderApi, ProviderError } from './oauth/api.ts';
import { appInstance } from './oauth/apps.ts';
import { PROVIDERS, serviceDef } from './oauth/providers.ts';
import { ConnectionProblem, usablePersonConnection, type OAuthDeps } from './oauth/store.ts';
import { providersOf } from './person-kit.ts';
import { PERSON_TOOLS, personToolDef } from './person-tools.ts';
import { CONNECTION_COLUMNS, isUsable, type ConnectionRow } from './rows.ts';
import { readConnectionSecret } from './secrets.ts';
import { countToolCall, isFailedAnswer } from './usage.ts';

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

/** Only a run that a person started in conversation (a conversation or a mention) may use that person's own connections. Mirrors the broker's rule for `person:*`. */
const PERSON_TRIGGERS: ReadonlySet<string> = new Set(['conversation', 'mention']);

/** What the person tools of one provider answer when the person's connection cannot serve the call: the model reads it, the person never sees a token. */
const unavailable = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });

export function createConnectionsSource(deps: OAuthDeps): ToolSource {
  /** The person tools this run's bot holds a grant for AND whose service the run's asker has connected and agreed to. Empty for a run nobody asked. */
  async function personToolsOffered(tx: PluginTx, run: BotRunHandle): Promise<string[]> {
    const granted = await tx.query<{ tool: string }>('SELECT tool FROM app.person_connection_grants WHERE actor_id = $1 AND team_id = $2', [run.botActorId, run.teamId]);
    if (granted.rows.length === 0 || !run.askerActorId || !PERSON_TRIGGERS.has(run.trigger)) return [];
    const out: string[] = [];
    const connections = new Map<string, Awaited<ReturnType<typeof usablePersonConnection>>>();
    for (const { tool } of granted.rows) {
      const def = personToolDef(tool);
      if (!def) continue;
      // a tool that works through more than one provider is offered when any of them is connected with the service agreed
      for (const providerId of providersOf(def)) {
        if (!connections.has(providerId)) connections.set(providerId, await usablePersonConnection(deps, { workspaceId: run.workspaceId, ownerId: run.askerActorId, provider: providerId }));
        const connection = connections.get(providerId);
        const service = serviceDef(PROVIDERS[providerId], def.service);
        if (connection && service && service.scopes.every((scope) => connection.scopes.includes(scope))) {
          out.push(tool);
          break;
        }
      }
    }
    return out;
  }

  /** A call to a person tool: the bot's grant, the run's asker, the asker's own usable connection and the service they agreed to, in that order. */
  async function callPersonTool(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<unknown> {
    const def = personToolDef(tool)!;
    const grant = await tx.query('SELECT 1 FROM app.person_connection_grants WHERE actor_id = $1 AND team_id = $2 AND tool = $3', [run.botActorId, run.teamId, tool]);
    // the same answer for "no grant" and "a grant you may not see": a refusal never says which of them it was
    if (grant.rows.length === 0) throw forbidden(`“${tool}” is not available to this bot through any connection you may use.`);
    if (!run.askerActorId || !PERSON_TRIGGERS.has(run.trigger)) throw forbidden(`“${tool}” uses the connection of the person who asked, and in this run nobody asked.`);
    // a read runs as the person who asked: it must really be their transaction, so what they cannot see is out of reach (a person who left the team sees no grant row above)
    if (def.kind === 'read' && tx.actor.id !== run.askerActorId) throw forbidden(`“${tool}” can only be read as the person who asked.`);
    const problem = inputProblem(tool, input);
    if (problem !== null) throw invalid(`The arguments of “${tool}” are not valid: ${problem}`);
    // the first provider (the tool's own, then the others it works through) the asker has connected AND agreed the service on
    let chosen: { providerId: PersonProviderId; connection: NonNullable<Awaited<ReturnType<typeof usablePersonConnection>>> } | null = null;
    let connectedWithoutService: { providerId: PersonProviderId; label: string } | null = null;
    for (const providerId of providersOf(def)) {
      const connection = await usablePersonConnection(deps, { workspaceId: run.workspaceId, ownerId: run.askerActorId, provider: providerId });
      if (!connection) continue;
      const service = serviceDef(PROVIDERS[providerId], def.service);
      if (service && service.scopes.every((scope) => connection.scopes.includes(scope))) {
        chosen = { providerId, connection };
        break;
      }
      connectedWithoutService ??= { providerId, label: service?.label ?? def.service };
    }
    if (!chosen) {
      if (connectedWithoutService) {
        return unavailable('not_agreed', `The person who asked has not allowed “${connectedWithoutService.label}” on their ${PROVIDERS[connectedWithoutService.providerId].label} connection, so “${tool}” cannot run. They can add it from their connections page.`);
      }
      const labels = providersOf(def).map((p) => PROVIDERS[p].label).join(' or ');
      return unavailable('not_connected', `The person who asked has not connected ${labels} (or it needs to be connected again), so “${tool}” cannot run. Ask them to connect it from their connections page.`);
    }
    const { providerId, connection } = chosen;
    // one call is counted (a day, the connection, worked or not; never what it read), also when it threw: the admin page shows these sums
    let failed = true;
    try {
      // Zendesk and Salesforce: the account's address comes from the workspace's app, read here (never from the tool's arguments)
      const instance = await appInstance(deps, run.workspaceId, providerId);
      const answer = await def.run(createProviderApi(deps, { id: connection.id, workspaceId: run.workspaceId, provider: providerId, instance }), input, { provider: providerId, tx, run });
      failed = isFailedAnswer(answer);
      return answer;
    } catch (err) {
      if (err instanceof ProviderError) return unavailable(err.status === 401 || err.status === 403 ? 'provider_refused' : err.status === 404 ? 'not_found' : 'provider_unavailable', err.message);
      if (err instanceof ConnectionProblem) return unavailable(err.code, err.message);
      throw err;
    } finally {
      await countToolCall(deps, { workspaceId: run.workspaceId, connectionId: connection.id, failed });
    }
  }

  return {
    id: 'connections',
    tools: [...TOOLS, ...PERSON_TOOLS],

    async offered(tx: PluginTx, run: BotRunHandle): Promise<readonly string[]> {
      const rows = await tx.query<Pick<ConnectionRow, 'status' | 'expired' | 'has_credentials' | 'kind'> & { tool: string }>(
        `SELECT g.tool, c.kind, c.status, c.has_credentials, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired
           FROM app.connection_grants g
           JOIN app.connections c ON c.id = g.connection_id AND c.team_id = g.team_id
          WHERE g.actor_id = $1 AND g.team_id = $2 AND c.scope = 'team'`,
        [run.botActorId, run.teamId],
      );
      const team = rows.rows.filter((r) => isUsable(r) && kindServes(r.kind, r.tool)).map((r) => r.tool);
      return [...team, ...(await personToolsOffered(tx, run))];
    },

    async approval(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<ToolApprovalCard | null> {
      // a write through a person's own connection waits whatever the definition says (the compile sets it); here the approver is shown what will really be sent or changed
      const person = personToolDef(tool);
      if (person) {
        if (person.kind !== 'write' || !person.card || inputProblem(tool, input) !== null) return null;
        const card = person.card(input);
        if (!person.where || !run.askerActorId) return card;
        // the place the change goes to (a Jira site) is asked of the provider now, so the approver reads it; a failure here only leaves it off, the call itself answers on its own
        try {
          const connection = await usablePersonConnection(deps, { workspaceId: run.workspaceId, ownerId: run.askerActorId, provider: person.provider });
          const place = connection ? await person.where(createProviderApi(deps, { id: connection.id, workspaceId: run.workspaceId, provider: person.provider })) : null;
          if (place === null) return card;
          const suffix = ` on ${place.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
          return { summary: `${card.summary.slice(0, 300 - suffix.length)}${suffix}`, preview: { ...card.preview, site: place.replace(/\s+/g, ' ').trim().slice(0, 150) } };
        } catch {
          return card;
        }
      }
      const granted = (await tx.query<ConnectionRow>(GRANTED, [run.botActorId, run.teamId, tool])).rows[0];
      if (!granted || !isUsable(granted) || inputProblem(tool, input) !== null) return null; // the call itself is refused for that reason
      const kind = kindOf(granted.kind);
      return kind?.approval ? kind.approval({ tool, input, connection: granted, tx, run }) : null;
    },

    async call(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<unknown> {
      if (personToolDef(tool)) return callPersonTool(tx, run, tool, input);
      const granted = (await tx.query<ConnectionRow>(GRANTED, [run.botActorId, run.teamId, tool])).rows[0];
      // The same answer for "no grant", "a grant you may not see" and "a connection of another team": a refusal never says which of them it was.
      if (!granted) throw forbidden(`“${tool}” is not available to this bot through any connection you may use.`);
      if (!isUsable(granted)) throw forbidden(`The connection “${granted.slug}” is switched off, has expired or has no credential, so “${tool}” cannot run.`);
      const kind = kindOf(granted.kind);
      if (!kind || !kind.tools.includes(tool)) throw forbidden(`The connection “${granted.slug}” cannot serve “${tool}”.`);
      // The arguments are the model's: they are held to the schema the model was shown before a kind sees them (a refusal names the fields, never a value).
      const problem = inputProblem(tool, input);
      if (problem !== null) throw invalid(`The arguments of “${tool}” are not valid: ${problem}`);
      // one call is counted (a day, the connection, worked or not; never what it read), also when it threw
      let failed = true;
      try {
        const answer = await kind.call({
          tool,
          input,
          connection: granted,
          tx,
          run,
          credential: (name) => readConnectionSecret(deps, { workspaceId: run.workspaceId, connectionId: granted.id, name }),
        });
        failed = isFailedAnswer(answer);
        return answer;
      } finally {
        await countToolCall(deps, { workspaceId: run.workspaceId, connectionId: granted.id, failed });
      }
    },
  };
}
