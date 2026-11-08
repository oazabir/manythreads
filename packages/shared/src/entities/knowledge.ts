import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { TeamId } from '../ids.ts';
import { KnowledgeConnectorProvider, KnowledgeSourceStatus } from './connector-source.ts';
import { SpaceRef } from './space.ts';

// A team's knowledge (SPEC §12.4, PLAN P8-07): a knowledge base is a named folder of documents (manuals, runbooks, policies) that bots search and
// cite. Each document is uploaded as a file, converted to text, cut into passages (chunks) and indexed. The original file stays in blob storage; the
// converted text is also a Markdown file in the team repo (`knowledge/<base>/<name>.md`), so the base shows in the Files tree and in git.

export const KnowledgeBaseId = z.uuid().brand<'KnowledgeBaseId'>();
export type KnowledgeBaseId = z.infer<typeof KnowledgeBaseId>;
export const KnowledgeDocumentId = z.uuid().brand<'KnowledgeDocumentId'>();
export type KnowledgeDocumentId = z.infer<typeof KnowledgeDocumentId>;
export const KnowledgeChunkId = z.uuid().brand<'KnowledgeChunkId'>();
export type KnowledgeChunkId = z.infer<typeof KnowledgeChunkId>;

/** A base's slug: its folder under `knowledge/` and the name `BOT.md` uses in `knowledge:`. */
export const KnowledgeBaseSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, starting with a letter or digit');
export type KnowledgeBaseSlug = z.infer<typeof KnowledgeBaseSlug>;
export const KnowledgeBaseName = z.string().trim().min(1).max(120);

/** What kind of file a document came from. The kinds the text extractor reads; `docx`, `xlsx` and `pptx` come only from connector sources (an upload still refuses them). */
export const KnowledgeDocumentKind = z.enum(['markdown', 'text', 'csv', 'pdf', 'docx', 'xlsx', 'pptx']);
export type KnowledgeDocumentKind = z.infer<typeof KnowledgeDocumentKind>;

/** `indexed`: its passages are searchable. `failed`: the file could not be read; `reason` says why in plain words. */
export const KnowledgeDocumentStatus = z.enum(['indexed', 'failed']);
export type KnowledgeDocumentStatus = z.infer<typeof KnowledgeDocumentStatus>;

/**
 * `upload`: a file a person uploaded. `repo`: a Markdown or text file someone put in the base's folder in the team repo. `url`: one public web page or
 * file (a docs-site page, a PDF) the platform fetches again on a rhythm. `connector`: a folder, space, site or database at a connected app (Drive, OneDrive, SharePoint,
 * Notion, Confluence, Dropbox, Box), read with a person's connection and kept up to date by the app's own change token (Bundle D, P16-08).
 */
export const KnowledgeSourceKind = z.enum(['upload', 'repo', 'url', 'connector']);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

/** How the base is searched. `lexical` is word matching (always available); `hybrid` adds meaning-based matching once a workspace has an embedding model. */
export const KnowledgeSearchMode = z.enum(['lexical', 'hybrid']);
export type KnowledgeSearchMode = z.infer<typeof KnowledgeSearchMode>;

/** The state of a base as a person reads it: no documents yet, all searchable, or some documents could not be read. */
export const KnowledgeBaseState = z.enum(['empty', 'ready', 'attention']);
export type KnowledgeBaseState = z.infer<typeof KnowledgeBaseState>;

/** What became of a question no base could answer: posted to the team's #kb-updates, or not (no such channel, no bot to write it). */
export const KnowledgeGapOutcome = z.enum(['posted', 'no_channel', 'no_author']);
export type KnowledgeGapOutcome = z.infer<typeof KnowledgeGapOutcome>;

/** How often a source is read again, in minutes; null means only when someone presses Re-sync. */
export const KnowledgeSyncMinutes = z.number().int().min(15).max(10080);

/** One place a base's documents come from, with how often it is read again and how the last read went. */
export const KnowledgeSource = z.object({
  id: z.uuid(),
  kind: KnowledgeSourceKind,
  /** For a `url` source: the address and the name its document shows; null for the others. */
  url: z.string().max(2048).nullable(),
  label: z.string().max(120).nullable(),
  syncMinutes: KnowledgeSyncMinutes.nullable(),
  lastSyncedAt: IsoDateTime.nullable(),
  /** Why the last read failed, in plain words; null when it did not. */
  error: z.string().max(400).nullable(),
  // The fields below are present for a `connector` source (Bundle D, P16-08) and absent for the others.
  provider: KnowledgeConnectorProvider.nullable().optional(),
  status: KnowledgeSourceStatus.optional(),
  /** The name of the folder, space, site or database the source reads (`label` carries it too). */
  remoteRoot: z.string().max(1024).nullable().optional(),
  /** Whose connection it is read with, as the workspace shows the name: "Nadia's Google Drive". Null when that person is gone. */
  readWith: z.string().max(200).nullable().optional(),
  /** Documents the last pass left out because not everyone on the team can open them at the app. A count only. */
  skippedLimited: z.number().int().min(0).optional(),
  documentCount: z.number().int().min(0).optional(),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeBase = z.object({
  id: KnowledgeBaseId,
  teamId: TeamId,
  slug: KnowledgeBaseSlug,
  name: KnowledgeBaseName,
  state: KnowledgeBaseState,
  documentCount: z.number().int().min(0),
  indexedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  chunkCount: z.number().int().min(0),
  /** The newest time a document of the base was indexed; null while nothing has been. */
  lastIndexedAt: IsoDateTime.nullable(),
  /** Where the base lives in the team repo, and so in the Files tree. */
  repoFolder: z.string(),
  createdAt: IsoDateTime,
});
export type KnowledgeBase = z.infer<typeof KnowledgeBase>;

export const KnowledgeDocument = z.object({
  id: KnowledgeDocumentId,
  baseId: KnowledgeBaseId,
  name: z.string().min(1).max(200),
  kind: KnowledgeDocumentKind,
  source: KnowledgeSourceKind,
  /** Bytes of the original file. */
  size: z.number().int().min(0),
  /** The first 12 characters of the original's SHA-256 (the whole value is on the server and in the converted file's header). */
  shortHash: z.string().regex(/^[0-9a-f]{12}$/),
  /** Starts at 1 and goes up by one each time the file's content changes; an upload of the same content keeps it. */
  version: z.number().int().min(1),
  status: KnowledgeDocumentStatus,
  /** For a failed document: why, in plain words. For an indexed one: a caution (only the start was read, no copy in the repo), or null. */
  reason: z.string().max(400).nullable(),
  chunkCount: z.number().int().min(0),
  /** The converted Markdown file in the team repo; null when it could not be written (too large, or the repo refused). */
  repoPath: z.string().nullable(),
  indexedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

/** One passage found by a search, with everything a reader needs to check it: which document, which version, where in it. */
export const KnowledgeHit = z.object({
  chunkId: KnowledgeChunkId,
  baseSlug: KnowledgeBaseSlug,
  documentId: KnowledgeDocumentId,
  documentName: z.string(),
  documentKind: KnowledgeDocumentKind,
  /** The version of the document this passage was cut from. */
  version: z.number().int().min(1),
  /** The version the document is at now. */
  currentVersion: z.number().int().min(1),
  /** True when the document has changed since this passage was indexed: the passage may no longer be true. */
  sourceChanged: z.boolean(),
  /** The heading, page or rows the passage sits under; null when the document has none. */
  section: z.string().nullable(),
  /** Character positions of the passage in the converted text. */
  offsetStart: z.number().int().min(0),
  offsetEnd: z.number().int().min(0),
  text: z.string(),
  /** 0 to 1, higher is a better match; comparable only within one answer. */
  score: z.number().min(0).max(1),
  /** The converted file in the team repo, which a citation can link to. */
  repoPath: z.string().nullable(),
  /** The space the passage was found in (`team:<id>` or `person:<id>`); absent from a team-only search. */
  space: SpaceRef.optional(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;
