import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { MemoryConceptSummary } from '../../entities/memory.ts';
import type { ApiRoute } from '../client/route.ts';

// A person's own Memory (P20-05, D10): an OKF bundle kept as rows by the memory plugin (no git), checked by the same validator as a team's
// `memory/`. Only its owner reads and writes it; a workspace admin reads it only during a live audited open (kernel 0016), and it is never
// shared (memory-share refuses a person's bundle). Paths are relative to the bundle's root (`people/nadia.md`), not `memory/people/nadia.md`.
// docs/plugins/memory.md.

/** The most versions the store keeps per file, and the longest a concept may be (the bundle's own file cap). */
export const PERSONAL_MEMORY_MAX_VERSIONS = 50;
export const PERSONAL_MEMORY_MAX_FILES = 2_000;

/** A path inside the person's bundle. The full rules (`.md`, no `..`, not `index.md`) are the OKF write check's; this is the cheap shape. */
export const PersonalMemoryPath = z.string().min(1).max(300);
export type PersonalMemoryPath = z.infer<typeof PersonalMemoryPath>;

export const PersonalMemoryPathQuery = z.object({ path: PersonalMemoryPath });
export type PersonalMemoryPathQuery = z.infer<typeof PersonalMemoryPathQuery>;

export const ListPersonalMemoryResponse = z.object({ items: z.array(MemoryConceptSummary) });
export type ListPersonalMemoryResponse = z.infer<typeof ListPersonalMemoryResponse>;
export const listPersonalMemoryRoute = { method: 'GET', path: '/api/me/memory/concepts' } as const satisfies ApiRoute;

/** One file: its text and the version it is at. */
export const PersonalMemoryFile = z.object({
  path: PersonalMemoryPath,
  content: z.string(),
  versionNo: z.number().int().min(1),
  sizeBytes: z.number().int().min(0),
  updatedAt: IsoDateTime,
});
export type PersonalMemoryFile = z.infer<typeof PersonalMemoryFile>;
export const GetPersonalMemoryFileResponse = z.object({ file: PersonalMemoryFile });
export type GetPersonalMemoryFileResponse = z.infer<typeof GetPersonalMemoryFileResponse>;
export const getPersonalMemoryFileRoute = { method: 'GET', path: '/api/me/memory/file' } as const satisfies ApiRoute;

/** Write (create or replace) a concept. `baseVersion` is the version the edit started from; a file that moved since is refused with 409. Null: the file must not exist yet. */
export const WritePersonalMemoryRequest = z.strictObject({
  path: PersonalMemoryPath,
  content: z.string().min(1).max(1_000_000),
  baseVersion: z.number().int().min(1).nullable().optional(),
});
export type WritePersonalMemoryRequest = z.infer<typeof WritePersonalMemoryRequest>;
export const WritePersonalMemoryResponse = z.object({ file: PersonalMemoryFile, concept: MemoryConceptSummary });
export type WritePersonalMemoryResponse = z.infer<typeof WritePersonalMemoryResponse>;
export const writePersonalMemoryRoute = { method: 'PUT', path: '/api/me/memory/file' } as const satisfies ApiRoute;

export const DeletePersonalMemoryResponse = z.object({ removed: z.literal(true) });
export type DeletePersonalMemoryResponse = z.infer<typeof DeletePersonalMemoryResponse>;
export const deletePersonalMemoryRoute = { method: 'DELETE', path: '/api/me/memory/file' } as const satisfies ApiRoute;

/** Who made a version: the person, a bot of a run the person asked, or the platform (the Archivist filing an inbox item). */
export const PersonalMemoryAuthorKind = z.enum(['person', 'bot', 'system']);
export type PersonalMemoryAuthorKind = z.infer<typeof PersonalMemoryAuthorKind>;
export const PersonalMemoryVersion = z.object({
  versionNo: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(0),
  authorKind: PersonalMemoryAuthorKind,
  createdAt: IsoDateTime,
});
export type PersonalMemoryVersion = z.infer<typeof PersonalMemoryVersion>;
export const ListPersonalMemoryVersionsResponse = z.object({ items: z.array(PersonalMemoryVersion) });
export type ListPersonalMemoryVersionsResponse = z.infer<typeof ListPersonalMemoryVersionsResponse>;
export const listPersonalMemoryVersionsRoute = { method: 'GET', path: '/api/me/memory/versions' } as const satisfies ApiRoute;

/** Bring an older version back as a new version (the history keeps going forward). */
export const RestorePersonalMemoryRequest = z.strictObject({ path: PersonalMemoryPath, versionNo: z.number().int().min(1) });
export type RestorePersonalMemoryRequest = z.infer<typeof RestorePersonalMemoryRequest>;
export const restorePersonalMemoryRoute = { method: 'POST', path: '/api/me/memory/restore' } as const satisfies ApiRoute;
