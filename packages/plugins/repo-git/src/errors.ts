import type { ErrorCode, RepoConflict } from '@manythreads/shared';

/** A refusal of the repo service. The HTTP layer maps `status` and `code` onto the error envelope; `conflicts` rides along on a 409. */
export class RepoError extends Error {
  override readonly name = 'RepoError';
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 500,
    readonly code: ErrorCode,
    message: string,
    readonly conflicts: readonly RepoConflict[] = [],
  ) {
    super(message);
  }
}

export const repoForbidden = (message: string): RepoError => new RepoError(403, 'forbidden', message);
export const repoNotFound = (message: string): RepoError => new RepoError(404, 'not_found', message);
export const repoInvalid = (message: string): RepoError => new RepoError(400, 'validation_failed', message);
export const notInRepo = (message: string): RepoError => new RepoError(422, 'attachment_not_in_repo', message);
