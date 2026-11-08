import { z } from 'zod';

// Document sources that ride on a person's connection (PLAN Bundle D, P16-08, plugin `knowledge`, docs/plugins/knowledge.md). Enums match the SQL CHECKs in
// plugins/knowledge/migrations/0005 exactly.

/** The services a document source can read: Notion, Confluence, Google Drive, SharePoint, OneDrive, Dropbox and Box. */
export const KnowledgeConnectorProvider = z.enum(['notion', 'confluence', 'google_drive', 'sharepoint', 'onedrive', 'dropbox', 'box']);
export type KnowledgeConnectorProvider = z.infer<typeof KnowledgeConnectorProvider>;

/** `ready`: read on its rhythm. `attention`: the last read failed (the source says why). `paused`: the connection it reads with is gone or needs signing in again. */
export const KnowledgeSourceStatus = z.enum(['ready', 'attention', 'paused']);
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatus>;

/** The connection (catalog id) a provider's documents are read with. */
export const CONNECTOR_SOURCE_CONNECTOR: Readonly<Record<KnowledgeConnectorProvider, string>> = {
  notion: 'notion',
  confluence: 'confluence',
  google_drive: 'google',
  sharepoint: 'microsoft',
  onedrive: 'microsoft',
  dropbox: 'dropbox',
  box: 'box',
};

/** Most connector sources one base holds. */
export const CONNECTOR_SOURCES_PER_BASE_MAX = 10;
/** A pass reads at most this many documents and this many bytes of them. */
export const CONNECTOR_PASS_MAX_DOCUMENTS = 100;
export const CONNECTOR_PASS_MAX_BYTES = 20 * 1024 * 1024;
/** One document is at most this large (bytes). */
export const CONNECTOR_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** A source is read again every this many minutes unless a person sets another rhythm (15..10080). */
export const CONNECTOR_DEFAULT_SYNC_MINUTES = 60;

/** A folder, space, site or database a person can pick as the root of a source. */
export const ConnectorRoot = z.object({
  /** The provider's id of it: what `remoteRoot` stores. */
  id: z.string().min(1).max(1024),
  name: z.string().min(1).max(200),
  /** What it is, in the provider's words: `folder`, `space`, `site`, `drive`, `database`, `workspace`. */
  kind: z.string().min(1).max(32),
  /** The parent shown above it (a site for a drive), when there is one. */
  parent: z.string().max(200).nullable(),
});
export type ConnectorRoot = z.infer<typeof ConnectorRoot>;

/**
 * Who may open a document at the provider, as far as the provider says. `anyone`: a public link. `domains`: everyone at these email domains. `users`: these email
 * addresses (lower case). `groups`: true when it is shared with a group (or the answer could not be read): the team rule then treats it as NOT everyone.
 */
export const DocumentAccess = z.object({
  anyone: z.boolean(),
  domains: z.array(z.string().max(255)).max(100),
  users: z.array(z.string().max(320)).max(500),
  groups: z.boolean(),
});
export type DocumentAccess = z.infer<typeof DocumentAccess>;
