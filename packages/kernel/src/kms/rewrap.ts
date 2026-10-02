import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { enqueue, type Job, type JobHandler } from '../jobs/index.ts';
import { withSystem, type Tx } from '../db/index.ts';
import { getKms, KmsError, openAesGcm, sealAesGcm, type Kms } from './kms.ts';

/** The job queue that carries master-key rotation (`kms.rewrap`). */
export const KMS_REWRAP_QUEUE = 'kms.rewrap';

export interface RewrapResult {
  /** Secrets moved to the current key in this call. */
  rewrapped: number;
  /** Secrets whose key id this Kms cannot unwrap (the old key is no longer in `previousKeys`); left untouched. */
  failed: number;
}

const aadFor = (secretId: string, keyId: string): Buffer => Buffer.from(`manythreads.secret:${secretId}:${keyId}`);

/**
 * Key rotation: every secret wrapped by an earlier master key is unwrapped with it (so it must still be in the Kms's
 * `previousKeys`), re-encrypted under a fresh data key bound to the new key id, and wrapped by the current key. The
 * plaintext is never stored, only held in memory for the duration of one row. Idempotent: a second run finds nothing.
 * System transaction only (nothing else can read `app.secrets`). A row it cannot unwrap is counted and skipped, not fatal,
 * so one lost key never blocks the rest.
 */
export async function rewrapSecrets(tx: Tx, kms: Kms = getKms(), options: { batchSize?: number } = {}): Promise<RewrapResult> {
  if (tx.actor.kind !== 'system') throw new KmsError('secrets can only be re-wrapped from a system transaction');
  const batchSize = options.batchSize ?? 100;
  const result: RewrapResult = { rewrapped: 0, failed: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = (
      await tx.query<{ id: string; ciphertext: Buffer; wrapped_key: Buffer; key_id: string }>(
        `SELECT id, ciphertext, wrapped_key, key_id FROM app.secrets
         WHERE key_id <> $1 AND id > $2 ORDER BY id LIMIT $3 FOR UPDATE`,
        [kms.keyId, after, batchSize],
      )
    ).rows;
    if (rows.length === 0) return result;
    for (const row of rows) {
      after = row.id;
      let plaintext: Buffer;
      try {
        const oldKey = await kms.unwrap(row.wrapped_key, row.key_id);
        try {
          plaintext = openAesGcm(oldKey, row.ciphertext, aadFor(row.id, row.key_id));
        } finally {
          oldKey.fill(0);
        }
      } catch (err) {
        if (!(err instanceof KmsError)) throw err;
        result.failed += 1;
        continue;
      }
      const dataKey = randomBytes(32);
      const ciphertext = sealAesGcm(dataKey, plaintext, aadFor(row.id, kms.keyId));
      const wrapped = await kms.wrap(dataKey);
      plaintext.fill(0);
      dataKey.fill(0);
      await tx.query('UPDATE app.secrets SET ciphertext = $2, wrapped_key = $3, key_id = $4 WHERE id = $1', [row.id, ciphertext, wrapped, kms.keyId]);
      result.rewrapped += 1;
    }
  }
}

/**
 * Handler for the `kms.rewrap` queue: one system transaction that re-wraps everything still on an old key. `pool` must be a
 * manythreads_system pool (default: the shared one); the server passes its own.
 */
export function createKmsRewrapHandler(kms?: Kms, options: { pool?: pg.Pool } = {}): JobHandler {
  return async () => {
    const result = await withSystem((tx) => rewrapSecrets(tx, kms ?? getKms()), options.pool ? { pool: options.pool } : {});
    if (result.failed > 0) throw new KmsError(`${result.failed} secret(s) are wrapped by a key this process does not hold`);
  };
}

/** Queues one re-wrap (deduplicated while one is waiting or running). Call after changing `MANYTHREADS_KMS_KEY`. */
export function enqueueKmsRewrap(tx: Tx): Promise<Job> {
  return enqueue(tx, KMS_REWRAP_QUEUE, {}, { dedupeKey: KMS_REWRAP_QUEUE });
}
