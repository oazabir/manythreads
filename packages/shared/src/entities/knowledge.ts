import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { TeamId } from '../ids.ts';

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

/** What kind of file a document came from. The kinds the text extractor reads today; the list grows as extractors are added. */
export const KnowledgeDocumentKind = z.enum(['markdown', 'text', 'csv', 'pdf']);
export type KnowledgeDocumentKind = z.infer<typeof KnowledgeDocumentKind>;

/** `indexed`: its passages are searchable. `failed`: the file could not be read; `reason` says why in plain words. */
export const KnowledgeDocumentStatus = z.enum(['indexed', 'failed']);
export type KnowledgeDocumentStatus = z.infer<typeof KnowledgeDocumentStatus>;

/** `upload`: a file a person uploaded. `repo`: a Markdown or text file someone put in the base's folder in the team repo. */
export const KnowledgeSourceKind = z.enum(['upload', 'repo']);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

/** How the base is searched. `lexical` is word matching (always available); `semantic` needs an embedding model, which this workspace has not been given. */
export const KnowledgeSearchMode = z.enum(['lexical']);
export type KnowledgeSearchMode = z.infer<typeof KnowledgeSearchMode>;

/** The state of a base as a person reads it: no documents yet, all searchable, or some documents could not be read. */
export const KnowledgeBaseState = z.enum(['empty', 'ready', 'attention']);
export type KnowledgeBaseState = z.infer<typeof KnowledgeBaseState>;

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
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;
