import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

// A connection (SPEC §11, PLAN P8-01): a team's, a person's or the workspace's link to an outside service (a mailbox, a code host). It is the place where
// a credential lives and where a bot's tools that reach outside come from. A bot reaches a connection only through a grant (`connection_grants`), which
// the connections plugin compiles from the `capabilities.connections` list of the bot's BOT.md.
//
// NOTHING IN THIS FILE CARRIES A SECRET. The credential is a row of `connection_secrets` that points at the platform's encrypted secret store; no schema,
// route, event or audit row has a field for its value, and none for its id either.

export const ConnectionId = z.uuid().brand<'ConnectionId'>();
export type ConnectionId = z.infer<typeof ConnectionId>;
export const ConnectionGrantId = z.uuid().brand<'ConnectionGrantId'>();
export type ConnectionGrantId = z.infer<typeof ConnectionGrantId>;

/** The name a `BOT.md` uses (`capabilities.connections[].name`) and the URL uses: unique among a team's connections. */
export const ConnectionSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, starting with a letter or digit');
export type ConnectionSlug = z.infer<typeof ConnectionSlug>;

/** What kind of outside service it is (`email`, later `github`, ...). Free text so a new kind needs no migration; a kind no plugin knows offers no tools. */
export const ConnectionKind = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and underscores, starting with a letter');
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ConnectionName = z.string().trim().min(1).max(120);

/**
 * Who the connection belongs to and who may see it. `team`: the people of one team (a bot of that team may be granted its tools). `person`: one person's
 * own (nobody else sees it; it is used only for that person's own conversations). `workspace`: the whole workspace's, seen by its admins.
 */
export const ConnectionScope = z.enum(['team', 'person', 'workspace']);
export type ConnectionScope = z.infer<typeof ConnectionScope>;

/** `disabled` until someone switches it on (a connection set up but not yet live offers no tools); `enabled` once it is. */
export const ConnectionStatus = z.enum(['enabled', 'disabled']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** A tag that says what the connection touches, so a staging mailbox is never mistaken for the real one. It decides nothing by itself. */
export const ConnectionEnvironment = z.enum(['production', 'staging', 'development', 'test']);
export type ConnectionEnvironment = z.infer<typeof ConnectionEnvironment>;

/** The name a credential is stored under on a connection (`password`, `access_token`, ...). */
export const ConnectionSecretName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and underscores, starting with a letter');
export type ConnectionSecretName = z.infer<typeof ConnectionSecretName>;

/** A tool name a grant allows (`email.send`): exactly `namespace.verb`, never a wildcard (a grant names each tool it allows). */
export const ConnectionToolName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a tool name like email.send');
export type ConnectionToolName = z.infer<typeof ConnectionToolName>;

/** A connection as a person reads it. No credential, and no way to ask for one: `hasCredentials` says only that something is stored. */
export const Connection = z.strictObject({
  id: ConnectionId,
  workspaceId: WorkspaceId,
  /** The team of a team connection; null for a person's or the workspace's. */
  teamId: TeamId.nullable(),
  slug: ConnectionSlug,
  kind: ConnectionKind,
  name: ConnectionName,
  scope: ConnectionScope,
  ownerId: ActorId,
  status: ConnectionStatus,
  environment: ConnectionEnvironment,
  expiresAt: IsoDateTime.nullable(),
  /** True once `expiresAt` has passed: an expired connection offers no tools until its credential is renewed. */
  expired: z.boolean(),
  hasCredentials: z.boolean(),
  createdAt: IsoDateTime,
});
export type Connection = z.infer<typeof Connection>;

/** One tool a bot may call through a connection (a row of `connection_grants`). */
export const ConnectionGrant = z.strictObject({
  id: ConnectionGrantId,
  connectionId: ConnectionId,
  botActorId: ActorId,
  tool: ConnectionToolName,
  /** The call waits in Approvals for a person before it runs. */
  needsApproval: z.boolean(),
});
export type ConnectionGrant = z.infer<typeof ConnectionGrant>;
