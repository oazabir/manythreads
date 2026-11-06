export const PENDING: 'PENDING';

export interface ModelFile {
  /** Path inside the repository or package. */
  path: string;
  /** Path under `/models/<name>/<revision>/` when it differs from `path`. */
  serve?: string;
  sha256: string;
  bytes: number | string;
}

export interface ModelSource {
  /** First folder under `/models/`. */
  name: string;
  kind: 'huggingface' | 'npm';
  repo?: string;
  package?: string;
  /** A commit (Hugging Face) or a version (npm); never a branch or a range. */
  revision: string;
  licence?: string;
  files: ModelFile[];
}

export interface ModelsLock {
  version: 1;
  sources: ModelSource[];
}

type Open = (url: string) => Promise<AsyncIterable<Uint8Array>>;

export function parseLock(raw: unknown): ModelsLock;
export function fileUrl(source: ModelSource, file: ModelFile, env?: Record<string, string | undefined>): string;
export function servedPath(source: ModelSource, file: ModelFile): string;
export function pendingFiles(lock: ModelsLock): string[];
export function hashFile(path: string): Promise<{ sha256: string; bytes: number }>;
export function openUrl(url: string): Promise<AsyncIterable<Uint8Array>>;
export function ensureFile(job: {
  url: string;
  dest: string;
  sha256: string;
  bytes: number | string;
  open: Open;
}): Promise<{ status: 'skipped' | 'fetched'; sha256: string; bytes: number }>;
export function fetchModels(options: {
  lockPath: string;
  outDir: string;
  pin?: boolean;
  open?: Open;
  log?: (line: string) => void;
  env?: Record<string, string | undefined>;
}): Promise<{ fetched: number; skipped: number; pinned: number }>;
export function parseArgs(argv: string[]): { lockPath: string; outDir: string; pin: boolean };
