import { ensureMemoryWorkspaceKey, readMemoryWorkspaceKey } from '@manythreads/sdk';

// The per-workspace key of the feed's keyed digests (`memory_workspace_keys`, system only). A key never changes once it exists (a changed key
// would make every retained document look edited), and it must exist BEFORE anything is retained under it: a key created inside a drain whose
// transaction then rolled back would leave documents in the engine named by a key no database has.
//
// So the drain never creates one. The event handlers do (`ensureWorkspaceKey`, in the transaction that marks a source: the key commits together
// with the work row that will need it), and the drain only reads (`readWorkspaceKey`, one read per workspace per drain; never kept past it). A row
// whose key is missing is put off, not retained.
//
// The two functions live in `@manythreads/sdk` (`memory-ledger.ts`) since P5-14: the git mirror names its documents under the same key.

/** Makes the workspace's key if there is none (idempotent: a second call, or a racing one, changes nothing). */
export const ensureWorkspaceKey = ensureMemoryWorkspaceKey;

/** The workspace's key, or null when none was made. `cache` is the caller's, for the length of one drain. */
export const readWorkspaceKey = readMemoryWorkspaceKey;
