import type { DocumentAccess, ConnectorRoot, KnowledgeConnectorProvider, ScheduledMeetingProvider } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// Two doors onto a person's own connection (PLAN Bundle D, decision D3). The connections plugin owns the grant and its sealed tokens; it registers one provider of each
// kind, and the plugins that need calendar or document data look them up in their own job or route (`ctx.providers.get<CalendarConnector>('connector.calendar')`),
// never in `register`. Neither plugin imports connections.
//
// Every call names whose grant it rides on (`personId`) and uses that person's grant only: there is no workspace-wide token and no bot grant behind these doors.
// A call never throws for what a provider can say; it answers an error with one of the codes below, and the caller decides what to tell the person.

/**
 * Why a connector call did not give data.
 *  `not_connected`  the person has no live connection for the service (never made, signed out, revoked, or the grant needs signing in again);
 *  `scope_missing`  the connection exists but was made without the permission this call needs (the caller offers the incremental-consent link);
 *  `provider_down`  the service did not answer in time, answered an error, or limited the calls (the caller retries later);
 *  `not_found`      the event, document or folder is not there (any more) for this person.
 */
export const CONNECTOR_ERROR_CODES = ['not_connected', 'scope_missing', 'provider_down', 'not_found'] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export type ConnectorResult<T> = { ok: true; value: T } | { ok: false; code: ConnectorErrorCode; message: string };

/** The person and service every call names. */
export interface ConnectorCaller {
  workspaceId: string;
  /** Whose grant the call rides on. */
  personId: string;
}

// --- connector.calendar ---------------------------------------------------------------------------------------------------------------------------------------

/** A calendar event as the door sees it. Attendee addresses go out and come back; the meetings plugin keeps only a count of the outside ones. */
export interface CalendarEvent {
  /** The service's id of the event. */
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  /** The description as typed at the calendar: outside text, data only. */
  description: string;
  /** True when the event was deleted or the organizer cancelled it. */
  cancelled: boolean;
  /** The service's own link to the event, when it gives one. */
  url: string | null;
  /** The service's version tag, to see that something changed. */
  version: string | null;
}

export interface CalendarEventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  /** The agenda plus the join link, already composed by the caller. */
  description: string;
  /** The join link, also set as the event's location. */
  location: string;
  /** Email addresses to invite (people of the workspace by their workspace email, and typed outside addresses). */
  attendeeEmails: string[];
}

export interface CalendarSummary {
  /** The service's id of one calendar of the person. */
  id: string;
  name: string;
  primary: boolean;
}

/** One stretch of time when someone is busy. Titles are never part of it. */
export interface BusySpan {
  startsAt: string;
  endsAt: string;
}

export interface FreeBusyAnswer {
  /** The address asked about. */
  email: string;
  /** False when the calendar is not shared with the asker: the caller says "can't see" and never guesses. */
  visible: boolean;
  busy: BusySpan[];
}

/**
 * The calendar door (kind `connector.calendar`, registered by connections). Google and Microsoft. Writes (`createEvent`, `updateEvent`, `cancelEvent`) are the
 * person's own click, with their own grant and the write scope; a missing scope answers `scope_missing`.
 */
export interface CalendarConnector extends ProviderImpl {
  /** Which services are connected for this person right now (`google`, `microsoft`), in the order they connected. */
  connectedProviders(tx: PluginTx, caller: ConnectorCaller): Promise<ScheduledMeetingProvider[]>;
  calendarsOf(tx: PluginTx, caller: ConnectorCaller & { provider: ScheduledMeetingProvider }): Promise<ConnectorResult<CalendarSummary[]>>;
  createEvent(tx: PluginTx, caller: ConnectorCaller & { provider: ScheduledMeetingProvider; calendarId?: string; event: CalendarEventInput }): Promise<ConnectorResult<CalendarEvent>>;
  updateEvent(
    tx: PluginTx,
    caller: ConnectorCaller & { provider: ScheduledMeetingProvider; calendarId?: string; eventId: string; changes: Partial<CalendarEventInput> },
  ): Promise<ConnectorResult<CalendarEvent>>;
  cancelEvent(tx: PluginTx, caller: ConnectorCaller & { provider: ScheduledMeetingProvider; calendarId?: string; eventId: string }): Promise<ConnectorResult<null>>;
  getEvent(tx: PluginTx, caller: ConnectorCaller & { provider: ScheduledMeetingProvider; calendarId?: string; eventId: string }): Promise<ConnectorResult<CalendarEvent>>;
  /** Busy times of the person and of the other addresses (only those who share their calendar with them) between two instants. */
  freeBusy(
    tx: PluginTx,
    caller: ConnectorCaller & { provider: ScheduledMeetingProvider; emails: string[]; from: string; to: string },
  ): Promise<ConnectorResult<FreeBusyAnswer[]>>;
}

// --- connector.documents --------------------------------------------------------------------------------------------------------------------------------------

/** What kind of file a fetched document is, as far as the reader of it is concerned (a page of Notion or Confluence comes back as markdown). */
export type FetchedDocumentKind = 'md' | 'text' | 'csv' | 'pdf' | 'docx' | 'xlsx' | 'pptx';

/** One document in a list of changes. */
export interface RemoteDocument {
  /** The service's id of it: what the knowledge document stores as `remote_id`. */
  remoteId: string;
  name: string;
  kind: FetchedDocumentKind;
  /** The service's version tag or modified time: a document whose version did not change is not fetched again. */
  version: string;
  url: string | null;
  /** True when it was deleted, trashed, or moved out of the root. */
  removed: boolean;
}

export interface RemoteChanges {
  items: RemoteDocument[];
  /** More changes wait behind this page: pass `next` as the page token of the next call; null when this was the last page. */
  next: string | null;
  /** The cursor to store once the whole pass has been taken in (a pass stops at 100 documents, so it may be the cursor of an earlier point). */
  cursor: string;
}

export interface FetchedDocument {
  /** At most 10 MB. */
  bytes: Uint8Array;
  kind: FetchedDocumentKind;
}

/**
 * The documents door (kind `connector.documents`, registered by connections). Notion, Confluence, Google Drive, SharePoint, OneDrive, Dropbox and Box. Read only: no
 * call here writes at the service. `access` is what the team rule is made of (decision D14): a document goes into a team base only when everyone on the team may
 * open it at the service, and an answer that could not be read is `groups: true`, never "open to all".
 */
export interface DocumentsConnector extends ProviderImpl {
  /** The folders, spaces, sites or databases the person can pick as a root. */
  listRoots(tx: PluginTx, caller: ConnectorCaller & { provider: KnowledgeConnectorProvider }): Promise<ConnectorResult<ConnectorRoot[]>>;
  /** What changed under a root since `cursor` (null: everything). One page; follow `next` until it is null. */
  listChanges(
    tx: PluginTx,
    caller: ConnectorCaller & { provider: KnowledgeConnectorProvider; root: string; cursor: string | null; pageToken?: string | null },
  ): Promise<ConnectorResult<RemoteChanges>>;
  fetch(tx: PluginTx, caller: ConnectorCaller & { provider: KnowledgeConnectorProvider; remoteId: string }): Promise<ConnectorResult<FetchedDocument>>;
  access(tx: PluginTx, caller: ConnectorCaller & { provider: KnowledgeConnectorProvider; remoteId: string }): Promise<ConnectorResult<DocumentAccess>>;
}
