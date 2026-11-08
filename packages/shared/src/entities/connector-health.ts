import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonId } from '../ids.ts';

// What a workspace admin sees of the connected apps (PLAN Bundle D, P16-11, docs/plugins/connections.md "Admin"): usage and health, who connected what, and the
// removal of a leaving person's connections. Content-blind: a count, a state, a service name; never a token, a mailbox address or what a call read.

/** One row of the admin page's Connectors tab. Each plugin that has the data answers its own route with rows of this shape; the page merges them. */
export const ConnectorHealthRow = z.object({
  /** The catalog id (`google`) or the plugin's own word (`telegram`, `zendesk`). */
  connector: z.string().min(1).max(40),
  /** Which plugin answered: the row's group on the page. */
  area: z.enum(['connections', 'webhooks', 'knowledge', 'bridges']),
  /** People who connected it (person grants), team connections, endpoints, sources or accounts, depending on the area. */
  people: z.number().int().min(0),
  shared: z.number().int().min(0),
  needsReconnect: z.number().int().min(0),
  /** Calls, deliveries, passes or messages in the last seven days, and how many of them failed or were refused. */
  calls7d: z.number().int().min(0),
  failures7d: z.number().int().min(0),
  /** Refused deliveries by reason, for the areas that have reasons; empty otherwise. */
  refused7d: z.record(z.string(), z.number().int().min(0)),
  lastUsedAt: IsoDateTime.nullable(),
  /** One plain sentence about the worst problem, or null. */
  problem: z.string().max(300).nullable(),
});
export type ConnectorHealthRow = z.infer<typeof ConnectorHealthRow>;

/** `ok`: the grant works. `needs_reconnect`: the provider refused it. `disabled`: switched off (a leaving person's, or by an admin). */
export const ConnectionPeopleState = z.enum(['ok', 'needs_reconnect', 'disabled']);
export type ConnectionPeopleState = z.infer<typeof ConnectionPeopleState>;

/** One connection of one person as an admin sees it: the service and the services granted, never the account address. */
export const ConnectionPersonRow = z.object({
  connectionId: z.uuid(),
  personId: PersonId,
  personName: z.string().max(120),
  connector: z.string().max(40),
  state: ConnectionPeopleState,
  /** The services granted (`drive`, `calendar`), by the catalog's ids. */
  services: z.array(z.string().max(40)).max(20),
  connectedAt: IsoDateTime,
  refreshedAt: IsoDateTime.nullable(),
  lastUsedOn: z.string().date().nullable(),
});
export type ConnectionPersonRow = z.infer<typeof ConnectionPersonRow>;

/** What removing a person's connections will do, before the admin confirms. */
export const OffboardPreview = z.object({
  personId: PersonId,
  personName: z.string().max(120),
  /** The person's own connections, by connector name. */
  own: z.array(z.object({ connector: z.string().max(40), services: z.array(z.string().max(40)).max(20) })).max(50),
  /** Team or workspace connections they set up, and who will own each from now on. */
  moving: z.array(z.object({ slug: z.string().max(80), connector: z.string().max(40), newOwnerName: z.string().max(120) })).max(50),
});
export type OffboardPreview = z.infer<typeof OffboardPreview>;

export const OffboardResult = z.object({
  /** True when the job was queued; the connections are switched off at once and removed within a minute. */
  queued: z.literal(true),
  disabled: z.number().int().min(0),
  moved: z.number().int().min(0),
});
export type OffboardResult = z.infer<typeof OffboardResult>;
