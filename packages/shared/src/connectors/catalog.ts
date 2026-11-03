import { z } from 'zod';
import { CONNECTION_KIND_TOOLS, CONNECTION_KINDS } from '../entities/connection-kinds.ts';
import { ConnectionKind, ConnectionToolName } from '../entities/connection.ts';

// The connector catalog (PLAN P16-01): ONE list of every outside service manythreads can be connected to, what it is signed in with, what a bot may do through it and
// what it may start or fill. The Add connection gallery, the connections plugin (its OAuth sign-in reads its services and scopes from here) and the docs all read
// this list; none of them keeps a second one. An entry is data: a connector whose tools are not built yet is listed with `status: 'planned'` and a plain reason, and
// offers nothing until the task named in `phase` builds it.
//
// What lives elsewhere and why:
//   * `entities/connection-kinds.ts` still says what a person is TOLD and ASKED when adding a mailbox, an SSH or a Kubernetes connection (its labels, sentences and
//     credential fields). This file builds those three entries FROM it, so there is one description of each.
//   * How a provider's sign-in differs (addresses, how the app proves itself, extra parameters) is behaviour, not catalog data: it stays in the connections plugin's
//     `oauth/providers.ts`, which reads the services and scopes below.
//
// NOTHING IN THIS FILE IS A SECRET. An OAuth app's client id and secret are entered by a workspace admin and stored sealed; they are never part of the catalog.

/** The nine shelves of the gallery, in the order it shows them. */
export const CONNECTOR_CATEGORIES = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'files', label: 'Files' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'crm', label: 'CRM' },
  { id: 'code', label: 'Code' },
  { id: 'chat', label: 'Chat' },
  { id: 'finance', label: 'Finance' },
  { id: 'design', label: 'Design' },
] as const;
export const ConnectorCategory = z.enum(['mail', 'calendar', 'files', 'tickets', 'crm', 'code', 'chat', 'finance', 'design']);
export type ConnectorCategory = z.infer<typeof ConnectorCategory>;

/** How a connector is signed in to: the person (or an admin) agrees on the provider's own page (`oauth`), an admin installs an app at the provider (`app_install`), or a key is pasted (`api_key`). */
export const ConnectorAuth = z.enum(['oauth', 'app_install', 'api_key']);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

/** Built by manythreads (`first_party`), or a ready-made piece of the connector service Activepieces (`activepieces`). */
export const ConnectorSource = z.enum(['first_party', 'activepieces']);
export type ConnectorSource = z.infer<typeof ConnectorSource>;

/** Whose it is: one person's own account, or a team's. A connector may be both. */
export const ConnectorHolder = z.enum(['person', 'team']);
export type ConnectorHolder = z.infer<typeof ConnectorHolder>;

/** What a connector's data can be copied into: a knowledge base, memory, or the meetings folder. */
export const ConnectorSyncTarget = z.enum(['knowledge', 'memory', 'meetings']);
export type ConnectorSyncTarget = z.infer<typeof ConnectorSyncTarget>;

const Word = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and underscores, starting with a letter');

/** One thing a person agrees to separately (Drive, Gmail drafts, ...): the provider's own scope names and what the words mean. Its tools are asked for together. */
export const ConnectorService = z.strictObject({
  id: Word,
  label: z.string().min(1).max(80),
  /** Plain words: what a bot can do with it. */
  description: z.string().min(1).max(300),
  /** The provider's own scope names, as the consent page asks for them. Notion has none of its own and lists `notion`. */
  scopes: z.array(z.string().min(1).max(200)).max(8),
  /** False while no tool of it is built: it is not offered on a sign-in. */
  available: z.boolean(),
});
export type ConnectorService = z.infer<typeof ConnectorService>;

export const ConnectorTool = z.strictObject({
  name: ConnectionToolName,
  label: z.string().min(1).max(80),
  /** `write` changes something outside, so every use waits for a person to approve it. */
  access: z.enum(['read', 'write']),
  /** Deletes or cannot be undone. A destructive tool is never offered through a connection: it is listed so a person can see what is deliberately left out. */
  destructive: z.boolean(),
  /** The service whose scopes this tool needs (`ConnectorService.id`); null for a connector with no scopes. */
  service: Word.nullable(),
  /** Built and offered to bots. */
  available: z.boolean(),
});
export type ConnectorTool = z.infer<typeof ConnectorTool>;

/** Something that happens at the provider and can start work here (a new ticket, new mail in a label). */
export const ConnectorTrigger = z.strictObject({
  id: Word,
  label: z.string().min(1).max(80),
  available: z.boolean(),
});
export type ConnectorTrigger = z.infer<typeof ConnectorTrigger>;

export const ConnectorStatus = z.enum(['available', 'planned']);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const ConnectorEntry = z.strictObject({
  /** Short name, unique in the catalog; the gallery and the docs use it as an address. */
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().min(1).max(80),
  /** The company or product behind it (several connectors can share one provider and one sign-in: Google Workspace is mail, calendar and files). */
  provider: z.string().min(1).max(40),
  /** The first is the main shelf. */
  categories: z.array(ConnectorCategory).min(1).max(3),
  description: z.string().min(1).max(400),
  source: ConnectorSource,
  auth: ConnectorAuth,
  heldBy: z.array(ConnectorHolder).min(1).max(2),
  /** The kind a team connection is created with, when the Add connection flow creates one (`email`, `ssh`, `kubernetes`); null for a person's sign-in or a connector with no team form yet. */
  kind: ConnectionKind.nullable(),
  services: z.array(ConnectorService).max(12),
  tools: z.array(ConnectorTool).max(24),
  triggers: z.array(ConnectorTrigger).max(8),
  syncTargets: z.array(ConnectorSyncTarget).max(3),
  status: ConnectorStatus,
  /** Why it cannot be used yet, in words for the person who asked. Present exactly when `status` is `planned`. */
  reason: z.string().max(300).nullable(),
  /** The plan task that builds it; null for what already exists. */
  phase: z.string().max(40).nullable(),
});
export type ConnectorEntry = z.infer<typeof ConnectorEntry>;

// ---- builders (plain functions that return plain data) ------------------------------------------------------------------------------------------------

const svc = (id: string, label: string, description: string, scopes: string[], available = true): ConnectorService => ({ id, label, description, scopes, available });
const tool = (name: string, label: string, access: 'read' | 'write', service: string | null, available = true): ConnectorTool => ({
  name,
  label,
  access,
  destructive: false,
  service,
  available,
});
/** A tool that deletes or cannot be undone: listed, tagged, and never offered. */
const dangerous = (name: string, label: string, service: string | null): ConnectorTool => ({ name, label, access: 'write', destructive: true, service, available: false });
const trig = (id: string, label: string, available = false): ConnectorTrigger => ({ id, label, available });

const soon = (phase: string, reason: string): Pick<ConnectorEntry, 'status' | 'reason' | 'phase'> => ({ status: 'planned', reason, phase });
const built = (phase: string | null = null): Pick<ConnectorEntry, 'status' | 'reason' | 'phase'> => ({ status: 'available', reason: null, phase });

const GOOGLE = 'https://www.googleapis.com/auth';

// ---- the connections the Add connection flow creates for a team today (built from entities/connection-kinds.ts) -----------------------------------------

const NATIVE_SHELF: Readonly<Record<string, ConnectorCategory>> = { email: 'mail', ssh: 'code', kubernetes: 'code' };
const NATIVE_WRITES: ReadonlySet<string> = new Set(['email.draft', 'email.send', 'ssh.run']);
const NATIVE_LABELS: Readonly<Record<string, string>> = {
  'email.read': 'Read mail',
  'email.draft': 'Draft a reply',
  'email.send': 'Send a reply (waits for approval)',
  'ssh.run': 'Run a listed command',
  'kubernetes.get': 'Look at the cluster (read only)',
};

const nativeEntries: ConnectorEntry[] = CONNECTION_KINDS.map((k) => ({
  id: k.kind,
  label: k.label,
  provider: k.kind === 'email' ? 'Mail server' : k.kind === 'ssh' ? 'SSH' : 'Kubernetes',
  categories: [NATIVE_SHELF[k.kind] ?? 'code'],
  description: k.description,
  source: 'first_party' as const,
  auth: 'api_key' as const,
  heldBy: ['team' as const],
  kind: k.kind,
  services: [],
  tools: (CONNECTION_KIND_TOOLS[k.kind] ?? []).map((name) => tool(name, NATIVE_LABELS[name] ?? name, NATIVE_WRITES.has(name) ? 'write' : 'read', null, k.available)),
  triggers: k.kind === 'email' ? [trig('inbox_mail', 'New mail in the inbox', true)] : [],
  syncTargets: [],
  ...(k.available ? built() : soon('P8-06', k.unavailableReason ?? 'Not available yet.')),
}));

// ---- a person's own sign-ins: Google, Microsoft 365, Notion (built in P8-02; the rest of their tools in P16-03 and P16-04) --------------------------------

const google: ConnectorEntry = {
  id: 'google',
  label: 'Google Workspace',
  provider: 'Google',
  categories: ['mail', 'calendar', 'files'],
  description: 'Gmail, Google Calendar and Google Drive, each person signing in to their own account. A bot works through it only when that person is the one asking.',
  source: 'first_party',
  auth: 'oauth',
  heldBy: ['person'],
  kind: null,
  services: [
    svc('drive', 'Google Drive (read)', 'Search your files and read the text of a document or sheet.', [`${GOOGLE}/drive.readonly`]),
    svc('gmail', 'Gmail (read)', 'Search your mail and read a message.', [`${GOOGLE}/gmail.readonly`]),
    svc('gmail_drafts', 'Gmail drafts', 'Save a draft in your mailbox. Nothing is sent, and each draft waits for your approval.', [`${GOOGLE}/gmail.compose`]),
    svc('calendar', 'Google Calendar (read)', 'List your upcoming events.', [`${GOOGLE}/calendar.events.readonly`]),
    svc('calendar_write', 'Google Calendar (add and change events)', 'Add an event to your calendar, or change one. Each change waits for your approval.', [`${GOOGLE}/calendar.events`]),
    svc('gmail_labels', 'Gmail labels', 'Put labels on a message and take them off, to sort your mail. Each change waits for your approval.', [`${GOOGLE}/gmail.modify`]),
    svc('gmail_send', 'Gmail (send)', 'Send a message from your mailbox. Each one waits for a team lead to approve it.', [`${GOOGLE}/gmail.send`]),
    svc('calendar_free_busy', 'Google Calendar (free and busy)', 'See when you and others are free, without the details of events.', [`${GOOGLE}/calendar.freebusy`]),
    svc('meet', 'Google Meet transcripts', 'Bring the transcript of a meeting you held into manythreads.', [`${GOOGLE}/meetings.space.readonly`], false),
  ],
  tools: [
    tool('google_drive.search', 'Search Drive', 'read', 'drive'),
    tool('google_drive.read', 'Read a Drive file', 'read', 'drive'),
    tool('gmail.search', 'Search mail', 'read', 'gmail'),
    tool('gmail.read', 'Read a message', 'read', 'gmail'),
    tool('gmail.draft', 'Save a draft', 'write', 'gmail_drafts'),
    tool('google_calendar.list_events', 'List events', 'read', 'calendar'),
    tool('google_calendar.create_event', 'Add an event', 'write', 'calendar_write'),
    tool('gmail.list_labels', 'List labels', 'read', 'gmail'),
    tool('gmail.label', 'Label a message', 'write', 'gmail_labels'),
    tool('gmail.send', 'Send a message', 'write', 'gmail_send'),
    tool('google_calendar.update_event', 'Change an event', 'write', 'calendar_write'),
    tool('google_calendar.free_busy', 'Find free time', 'read', 'calendar_free_busy'),
    dangerous('google_drive.delete', 'Delete a Drive file', 'drive'),
  ],
  triggers: [trig('gmail_label_mail', 'New mail in a label')],
  syncTargets: ['knowledge', 'meetings'],
  ...built('P8-02'),
};

const microsoft: ConnectorEntry = {
  id: 'microsoft',
  label: 'Microsoft 365',
  provider: 'Microsoft',
  categories: ['mail', 'calendar', 'files'],
  description: 'Outlook mail and calendar and OneDrive, each person signing in to their own account. A bot works through it only when that person is the one asking.',
  source: 'first_party',
  auth: 'oauth',
  heldBy: ['person'],
  kind: null,
  services: [
    svc('onedrive', 'OneDrive (read)', 'Search your files and read the text of a file.', ['Files.Read']),
    svc('mail', 'Outlook mail (read)', 'Search your mail and read a message.', ['Mail.Read']),
    svc('mail_drafts', 'Outlook drafts', 'Save a draft in your mailbox. Nothing is sent, and each draft waits for your approval.', ['Mail.ReadWrite']),
    svc('calendar', 'Outlook calendar (read)', 'List your upcoming events.', ['Calendars.Read']),
    svc('calendar_write', 'Outlook calendar (add events)', 'Add an event to your calendar. Each event waits for your approval.', ['Calendars.ReadWrite']),
    svc('mail_send', 'Outlook (send)', 'Send a message from your mailbox. Each one waits for your approval.', ['Mail.Send'], false),
    svc('sharepoint', 'SharePoint (read)', 'Search and read the sites you can open.', ['Sites.Read.All'], false),
    svc('teams_transcripts', 'Teams meeting transcripts', 'Bring the transcript of a meeting you held into manythreads.', ['OnlineMeetingTranscript.Read.All'], false),
  ],
  tools: [
    tool('onedrive.search', 'Search OneDrive', 'read', 'onedrive'),
    tool('onedrive.read', 'Read a OneDrive file', 'read', 'onedrive'),
    tool('outlook.search', 'Search mail', 'read', 'mail'),
    tool('outlook.read', 'Read a message', 'read', 'mail'),
    tool('outlook.draft', 'Save a draft', 'write', 'mail_drafts'),
    tool('outlook_calendar.list_events', 'List events', 'read', 'calendar'),
    tool('outlook_calendar.create_event', 'Add an event', 'write', 'calendar_write'),
    tool('outlook.send', 'Send a message', 'write', 'mail_send', false),
    tool('sharepoint.search', 'Search SharePoint', 'read', 'sharepoint', false),
    dangerous('onedrive.delete', 'Delete a OneDrive file', 'onedrive'),
  ],
  triggers: [trig('outlook_folder_mail', 'New mail in a folder')],
  syncTargets: ['knowledge', 'meetings'],
  ...built('P8-02'),
};

const notion: ConnectorEntry = {
  id: 'notion',
  label: 'Notion',
  provider: 'Notion',
  categories: ['files'],
  description: 'Search and read the Notion pages a person shares with the connection, and add a page under one of them.',
  source: 'first_party',
  auth: 'oauth',
  heldBy: ['person'],
  kind: null,
  services: [
    // Notion has no scope names: what the integration may do is set where it is made, and what it may see is chosen by the person on the consent page.
    svc('notion', 'Notion', 'Search the pages you shared with the connection, read them, and add a page under one of them (each new page waits for your approval).', ['notion']),
  ],
  tools: [
    tool('notion.search', 'Search pages', 'read', 'notion'),
    tool('notion.read_page', 'Read a page', 'read', 'notion'),
    tool('notion.create_page', 'Add a page', 'write', 'notion'),
  ],
  triggers: [],
  syncTargets: ['knowledge'],
  ...built('P8-02'),
};

// ---- connectors whose tools are not built yet: catalog data only ---------------------------------------------------------------------------------------

const planned = (e: Omit<ConnectorEntry, 'kind' | 'syncTargets' | 'triggers' | 'services'> & Partial<Pick<ConnectorEntry, 'syncTargets' | 'triggers' | 'services'>>): ConnectorEntry => ({
  kind: null,
  syncTargets: [],
  triggers: [],
  services: [],
  ...e,
});

const PLANNED_ENTRIES: ConnectorEntry[] = [
  planned({
    id: 'jira',
    label: 'Jira',
    provider: 'Atlassian',
    categories: ['tickets'],
    description: 'Link a board card to a Jira issue both ways, and create an issue from a message.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('issues', 'Issues', 'Search and read issues, and create or change one with approval.', ['read:jira-work', 'write:jira-work', 'offline_access'], false)],
    tools: [
      tool('jira.search_issues', 'Search issues', 'read', 'issues', false),
      tool('jira.read_issue', 'Read an issue', 'read', 'issues', false),
      tool('jira.create_issue', 'Create an issue', 'write', 'issues', false),
      tool('jira.comment', 'Comment on an issue', 'write', 'issues', false),
      dangerous('jira.delete_issue', 'Delete an issue', 'issues'),
    ],
    triggers: [trig('issue_changed', 'An issue changes')],
    ...soon('P16-06', 'Work trackers arrive in a later phase.'),
  }),
  planned({
    id: 'linear',
    label: 'Linear',
    provider: 'Linear',
    categories: ['tickets'],
    description: 'Link a board card to a Linear issue both ways, and create an issue from a message.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('issues', 'Issues', 'Search and read issues, and create one with approval.', ['read', 'issues:create'], false)],
    tools: [
      tool('linear.search_issues', 'Search issues', 'read', 'issues', false),
      tool('linear.create_issue', 'Create an issue', 'write', 'issues', false),
    ],
    triggers: [trig('issue_changed', 'An issue changes')],
    ...soon('P16-06', 'Work trackers arrive in a later phase.'),
  }),
  planned({
    id: 'github',
    label: 'GitHub',
    provider: 'GitHub',
    categories: ['code', 'tickets'],
    description: 'Issues and pull requests of the repositories the app is installed on. An admin installs the app once; its access tokens last an hour.',
    source: 'first_party',
    auth: 'app_install',
    heldBy: ['team'],
    services: [svc('issues', 'Issues and pull requests', 'Read issues and pull requests, and open an issue with approval.', ['issues:write', 'pull_requests:read'], false)],
    tools: [
      tool('github.search_issues', 'Search issues', 'read', 'issues', false),
      tool('github.create_issue', 'Open an issue', 'write', 'issues', false),
    ],
    triggers: [trig('issue_opened', 'An issue is opened'), trig('pull_request_changed', 'A pull request changes')],
    ...soon('P8-03', 'The GitHub app connection is not built yet.'),
  }),
  planned({
    id: 'gitlab',
    label: 'GitLab',
    provider: 'GitLab',
    categories: ['code', 'tickets'],
    description: 'Projects, issues and merge requests, through a service account an admin creates.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [tool('gitlab.search_issues', 'Search issues', 'read', null, false), tool('gitlab.create_issue', 'Open an issue', 'write', null, false)],
    triggers: [trig('issue_opened', 'An issue is opened')],
    ...soon('P8-03', 'The GitLab connection is not built yet.'),
  }),
  planned({
    id: 'asana',
    label: 'Asana',
    provider: 'Asana',
    categories: ['tickets'],
    description: 'Link a board card to an Asana task both ways, and create a task from a message.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('tasks', 'Tasks', 'Search and read tasks, and create one with approval.', ['default'], false)],
    tools: [tool('asana.search_tasks', 'Search tasks', 'read', 'tasks', false), tool('asana.create_task', 'Create a task', 'write', 'tasks', false)],
    triggers: [trig('task_changed', 'A task changes')],
    ...soon('P16-06', 'Work trackers arrive in a later phase.'),
  }),
  planned({
    id: 'zendesk',
    label: 'Zendesk',
    provider: 'Zendesk',
    categories: ['tickets', 'crm'],
    description: 'A new ticket starts your support bot, which can look up the customer and draft a reply. Every change waits for a person.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('tickets', 'Tickets', 'Read tickets and customers, and reply or update with approval.', ['read', 'write'], false)],
    tools: [
      tool('zendesk.search_tickets', 'Search tickets', 'read', 'tickets', false),
      tool('zendesk.read_ticket', 'Read a ticket', 'read', 'tickets', false),
      tool('zendesk.reply', 'Reply to a ticket', 'write', 'tickets', false),
      dangerous('zendesk.delete_ticket', 'Delete a ticket', 'tickets'),
    ],
    triggers: [trig('ticket_created', 'A new ticket arrives')],
    ...soon('P16-07', 'Support and CRM connectors arrive in a later phase.'),
  }),
  planned({
    id: 'freshdesk',
    label: 'Freshdesk',
    provider: 'Freshworks',
    categories: ['tickets'],
    description: 'A new ticket starts your support bot. Replies wait for a person.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [tool('freshdesk.search_tickets', 'Search tickets', 'read', null, false), tool('freshdesk.reply', 'Reply to a ticket', 'write', null, false)],
    triggers: [trig('ticket_created', 'A new ticket arrives')],
    ...soon('P16-07', 'Support and CRM connectors arrive in a later phase.'),
  }),
  planned({
    id: 'intercom',
    label: 'Intercom',
    provider: 'Intercom',
    categories: ['tickets', 'chat'],
    description: 'A new conversation starts your support bot. Replies wait for a person.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('conversations', 'Conversations', 'Read conversations and customers, and reply with approval.', [], false)],
    tools: [tool('intercom.search_conversations', 'Search conversations', 'read', 'conversations', false), tool('intercom.reply', 'Reply to a conversation', 'write', 'conversations', false)],
    triggers: [trig('conversation_created', 'A new conversation starts')],
    ...soon('P16-07', 'Support and CRM connectors arrive in a later phase.'),
  }),
  planned({
    id: 'hubspot',
    label: 'HubSpot',
    provider: 'HubSpot',
    categories: ['crm'],
    description: 'Look up a customer inside an answer. Changes to a record wait for a person.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('contacts', 'Contacts and companies', 'Look up contacts and companies, and update one with approval.', ['crm.objects.contacts.read', 'crm.objects.contacts.write'], false)],
    tools: [tool('hubspot.find_contact', 'Find a contact', 'read', 'contacts', false), tool('hubspot.update_contact', 'Update a contact', 'write', 'contacts', false)],
    ...soon('P16-07', 'Support and CRM connectors arrive in a later phase.'),
  }),
  planned({
    id: 'salesforce',
    label: 'Salesforce',
    provider: 'Salesforce',
    categories: ['crm'],
    description: 'Look up a customer inside an answer. Changes to a record wait for a person.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('records', 'Accounts and contacts', 'Look up accounts and contacts, and update one with approval.', ['api', 'refresh_token'], false)],
    tools: [tool('salesforce.find_account', 'Find an account', 'read', 'records', false), tool('salesforce.update_record', 'Update a record', 'write', 'records', false)],
    ...soon('P16-07', 'Support and CRM connectors arrive in a later phase.'),
  }),
  planned({
    id: 'confluence',
    label: 'Confluence',
    provider: 'Atlassian',
    categories: ['files'],
    description: 'Pages as a knowledge source, kept up to date as they change. A page is added to a team base only when everyone on the team may read it there.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('pages', 'Pages (read)', 'Search and read pages.', ['read:confluence-content.all', 'offline_access'], false)],
    tools: [tool('confluence.search', 'Search pages', 'read', 'pages', false), tool('confluence.read_page', 'Read a page', 'read', 'pages', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
  planned({
    id: 'dropbox',
    label: 'Dropbox',
    provider: 'Dropbox',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('files', 'Files (read)', 'Search and read files.', ['files.metadata.read', 'files.content.read'], false)],
    tools: [tool('dropbox.search', 'Search files', 'read', 'files', false), tool('dropbox.read', 'Read a file', 'read', 'files', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
  planned({
    id: 'box',
    label: 'Box',
    provider: 'Box',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('files', 'Files (read)', 'Search and read files.', ['root_readonly'], false)],
    tools: [tool('box.search', 'Search files', 'read', 'files', false), tool('box.read', 'Read a file', 'read', 'files', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
  planned({
    id: 'slack',
    label: 'Slack',
    provider: 'Slack',
    categories: ['chat'],
    description: 'A two-way bridge to a Slack channel for the move-in period. Messages show who wrote them and where.',
    source: 'first_party',
    auth: 'app_install',
    heldBy: ['team'],
    services: [svc('bridge', 'Channel bridge', 'Read and post in the channels the app is added to.', ['channels:history', 'chat:write'], false)],
    tools: [],
    triggers: [trig('message_posted', 'A message is posted')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
  planned({
    id: 'telegram',
    label: 'Telegram',
    provider: 'Telegram',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Telegram chat, and a way to reach your own assistant from your phone. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
  planned({
    id: 'whatsapp',
    label: 'WhatsApp Business',
    provider: 'Meta',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and WhatsApp, and a way to reach your own assistant from your phone. Only linked people get through.',
    source: 'first_party',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [],
    triggers: [trig('message_received', 'A message arrives')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
  planned({
    id: 'teams',
    label: 'Microsoft Teams',
    provider: 'Microsoft',
    categories: ['chat'],
    description: 'A two-way bridge between a channel and a Teams channel, and a way to reach your own assistant from Teams.',
    source: 'first_party',
    auth: 'app_install',
    heldBy: ['team'],
    services: [svc('bridge', 'Channel bridge', 'Read and post in the channels the app is added to.', ['ChannelMessage.Send'], false)],
    tools: [],
    triggers: [trig('message_posted', 'A message is posted')],
    ...soon('P16-09', 'Chat bridges arrive in a later phase.'),
  }),
  // Ready-made pieces of the connector service (Activepieces) for what no first-party connector covers.
  planned({
    id: 'stripe',
    label: 'Stripe',
    provider: 'Stripe',
    categories: ['finance'],
    description: 'Look up customers, payments and subscriptions through a restricted key.',
    source: 'activepieces',
    auth: 'api_key',
    heldBy: ['team'],
    tools: [tool('stripe.find_customer', 'Find a customer', 'read', null, false), tool('stripe.list_payments', 'List payments', 'read', null, false)],
    ...soon('P8-03', 'The connector service that runs ready-made pieces is not set up yet.'),
  }),
  planned({
    id: 'quickbooks',
    label: 'QuickBooks',
    provider: 'Intuit',
    categories: ['finance'],
    description: 'Look up invoices and customers.',
    source: 'activepieces',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('accounting', 'Accounting (read)', 'Read invoices and customers.', ['com.intuit.quickbooks.accounting'], false)],
    tools: [tool('quickbooks.find_invoice', 'Find an invoice', 'read', 'accounting', false)],
    ...soon('P8-03', 'The connector service that runs ready-made pieces is not set up yet.'),
  }),
  planned({
    id: 'xero',
    label: 'Xero',
    provider: 'Xero',
    categories: ['finance'],
    description: 'Look up invoices and contacts.',
    source: 'activepieces',
    auth: 'oauth',
    heldBy: ['team'],
    services: [svc('accounting', 'Accounting (read)', 'Read invoices and contacts.', ['accounting.transactions.read', 'accounting.contacts.read', 'offline_access'], false)],
    tools: [tool('xero.find_invoice', 'Find an invoice', 'read', 'accounting', false)],
    ...soon('P8-03', 'The connector service that runs ready-made pieces is not set up yet.'),
  }),
  planned({
    id: 'figma',
    label: 'Figma',
    provider: 'Figma',
    categories: ['design'],
    description: 'Read a design file and its comments.',
    source: 'activepieces',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('files', 'Files (read)', 'Read design files and comments.', ['file_read'], false)],
    tools: [tool('figma.read_file', 'Read a design file', 'read', 'files', false), tool('figma.list_comments', 'List comments', 'read', 'files', false)],
    ...soon('P8-03', 'The connector service that runs ready-made pieces is not set up yet.'),
  }),
  planned({
    id: 'canva',
    label: 'Canva',
    provider: 'Canva',
    categories: ['design'],
    description: 'Find a design and export it.',
    source: 'activepieces',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('designs', 'Designs (read)', 'Find and export designs.', ['design:content:read'], false)],
    tools: [tool('canva.find_design', 'Find a design', 'read', 'designs', false)],
    ...soon('P8-03', 'The connector service that runs ready-made pieces is not set up yet.'),
  }),
];

/** Every connector, in the order the gallery shows them: what works today first, then what is planned. */
export const CONNECTOR_CATALOG: readonly ConnectorEntry[] = [...nativeEntries, google, microsoft, notion, ...PLANNED_ENTRIES];

// ---- reading the catalog -----------------------------------------------------------------------------------------------------------------------------------

export const connectorEntry = (id: string): ConnectorEntry | undefined => CONNECTOR_CATALOG.find((e) => e.id === id);

export const connectorCategoryLabel = (id: ConnectorCategory): string => CONNECTOR_CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** The tools a connector offers to bots right now (the others are listed in the gallery but never offered). */
export const availableTools = (entry: ConnectorEntry): ConnectorTool[] => (entry.status === 'available' ? entry.tools.filter((t) => t.available && !t.destructive) : []);

/** The services of a connector that a sign-in can ask for, in the order a screen shows them. */
export const availableServices = (entry: ConnectorEntry): ConnectorService[] => (entry.status === 'available' ? entry.services.filter((s) => s.available) : []);

/** Every tool name the catalog offers to bots, across all connectors. */
export const catalogToolNames = (): string[] => CONNECTOR_CATALOG.flatMap((e) => availableTools(e).map((t) => t.name));

/** The tools whose service is `serviceId`, by name. */
export const toolsOfService = (entry: ConnectorEntry, serviceId: string): string[] => availableTools(entry).filter((t) => t.service === serviceId).map((t) => t.name);

/**
 * The provider's scope names that the named tools need, without repeats: what a sign-in asks for when a person turns exactly these tools on. A tool that is not in
 * the entry, is not built or is destructive contributes nothing.
 */
export function scopesForTools(entry: ConnectorEntry, toolNames: readonly string[]): string[] {
  const wanted = new Set(toolNames);
  const out = new Set<string>();
  for (const t of availableTools(entry)) {
    if (!wanted.has(t.name) || t.service === null) continue;
    for (const s of entry.services.find((x) => x.id === t.service && x.available)?.scopes ?? []) out.add(s);
  }
  return [...out];
}

/** The scopes of the named services, without repeats (an unknown or unbuilt service contributes nothing). */
export function scopesForServices(entry: ConnectorEntry, serviceIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of serviceIds) for (const s of entry.services.find((x) => x.id === id && x.available)?.scopes ?? []) out.add(s);
  return [...out];
}

export interface ConnectorSearch {
  /** Words to look for; every word must match somewhere in the connector's name, provider, shelf, description or tool names. Empty matches all. */
  query?: string;
  category?: ConnectorCategory | null;
}

const haystack = (e: ConnectorEntry): string =>
  [e.label, e.provider, e.description, ...e.categories.map(connectorCategoryLabel), ...e.tools.map((t) => `${t.label} ${t.name}`), ...e.triggers.map((t) => t.label)].join(' ').toLowerCase();

/**
 * The gallery's search: connectors that are on the chosen shelf (any of their shelves) and hold every word of the query, with the ones whose name matches first and
 * what works today before what is planned. Linear time in the catalog and the query (no pattern is built from the query).
 */
export function searchConnectors(search: ConnectorSearch = {}, entries: readonly ConnectorEntry[] = CONNECTOR_CATALOG): ConnectorEntry[] {
  const words = (search.query ?? '').toLowerCase().split(/\s+/).filter((w) => w !== '').slice(0, 8);
  const rank = (e: ConnectorEntry): number => {
    const name = `${e.label} ${e.provider}`.toLowerCase();
    return (words.length > 0 && words.every((w) => name.includes(w)) ? 0 : 2) + (e.status === 'available' ? 0 : 1);
  };
  return entries
    .filter((e) => (search.category ? e.categories.includes(search.category) : true))
    .filter((e) => {
      const text = haystack(e);
      return words.every((w) => text.includes(w));
    })
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
}

/** How many connectors are on each shelf (a connector on two shelves counts on both). */
export const categoryCounts = (entries: readonly ConnectorEntry[] = CONNECTOR_CATALOG): Record<ConnectorCategory, number> => {
  const out = Object.fromEntries(CONNECTOR_CATEGORIES.map((c) => [c.id, 0])) as Record<ConnectorCategory, number>;
  for (const e of entries) for (const c of new Set(e.categories)) out[c] += 1;
  return out;
};
