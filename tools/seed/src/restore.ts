// Saved starting points for the persona journeys (PLAN P12-02, Bundle E decision E29). A snapshot is a seeded database kept as a Postgres template plus a tar of
// the stack's repository and file folders; restoring one is `CREATE DATABASE ... TEMPLATE ...` and an untar, not a re-seed.
//
// STUB (Bundle E WP-0): the signature is the contract e2e/fixtures/stack-server.ts calls when `MANYTHREADS_STACK_SNAPSHOT` is set; WP-P1 fills the body.
// It refuses rather than falls back to seeding, so a spec that asks for a snapshot never runs on the wrong data.

export interface RestoreSnapshotOptions {
  /** `day-1` or `week-2`. */
  name: string;
  /** The stack's fresh, empty (migrated or not) database, from `createTestDatabase`. */
  database: { name: string; ownerUrl: string };
  /** The folders the stack points `MANYTHREADS_REPO_DIR` and `MANYTHREADS_STORAGE_DIR` at; the tar is unpacked into them. */
  repoDir: string;
  storageDir: string;
}

export async function restoreSnapshot(options: RestoreSnapshotOptions): Promise<void> {
  throw new Error(`MANYTHREADS_STACK_SNAPSHOT=${options.name}: snapshots are not built yet (WP-P1, tools/seed)`);
}
