import { randomBytes } from 'node:crypto';
import { SecretId } from '@manythreads/shared';
import type { Tx } from '../db/index.ts';
import { getKms, KmsError, openAesGcm, sealAesGcm, type Kms } from './kms.ts';

/**
 * Stores a secret (envelope: a random data key encrypts it, the Kms wraps the data key) and returns its id.
 * Callable by a workspace admin's transaction or by system code: `app.put_secret` enforces that in the database,
 * because `manythreads_app` has no privilege on `app.secrets`. The ciphertext is bound to the secret id (AAD), so a blob
 * copied to another row does not decrypt.
 */
export async function putSecret(tx: Tx, plaintext: string | Uint8Array, kms: Kms = getKms()): Promise<SecretId> {
  const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id;
  if (!id) throw new KmsError('could not allocate a secret id');
  const dataKey = randomBytes(32);
  const keyId = kms.keyId;
  const ciphertext = sealAesGcm(dataKey, Buffer.from(plaintext), aadFor(id, keyId));
  const wrapped = await kms.wrap(dataKey);
  dataKey.fill(0);
  await tx.query('SELECT app.put_secret($1, $2, $3, $4)', [id, ciphertext, wrapped, keyId]);
  return SecretId.parse(id);
}

/**
 * Reads and decrypts a secret. System context only (a transaction on the manythreads_system pool): no other role can
 * SELECT `app.secrets`, and there is deliberately no API route, event or mapper that carries the plaintext to a client.
 */
export async function getSecretBytes(tx: Tx, secretId: SecretId | string, kms: Kms = getKms()): Promise<Buffer> {
  if (tx.actor.kind !== 'system') throw new KmsError('secrets can only be read from a system transaction');
  const res = await tx.query<{ ciphertext: Buffer; wrapped_key: Buffer; key_id: string }>(
    'SELECT ciphertext, wrapped_key, key_id FROM app.secrets WHERE id = $1',
    [secretId],
  );
  const row = res.rows[0];
  if (!row) throw new KmsError(`secret ${secretId} not found`);
  const dataKey = await kms.unwrap(row.wrapped_key, row.key_id);
  try {
    return openAesGcm(dataKey, row.ciphertext, aadFor(secretId, row.key_id));
  } finally {
    dataKey.fill(0);
  }
}

/** getSecretBytes decoded as UTF-8. */
export async function getSecret(tx: Tx, secretId: SecretId | string, kms: Kms = getKms()): Promise<string> {
  return (await getSecretBytes(tx, secretId, kms)).toString('utf8');
}

/** Deletes a secret (admin or system; the database decides). Returns false when it did not exist. */
export async function deleteSecret(tx: Tx, secretId: SecretId | string): Promise<boolean> {
  const res = await tx.query<{ deleted: boolean }>('SELECT app.delete_secret($1) AS deleted', [secretId]);
  return res.rows[0]?.deleted ?? false;
}

const aadFor = (secretId: string, keyId: string): Buffer => Buffer.from(`manythreads.secret:${secretId}:${keyId}`);
