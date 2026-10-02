import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * `provider.kms` (SPEC §15): wraps and unwraps data keys. Envelope encryption keeps the master key out of the
 * database: `app.secrets` holds only ciphertext and a wrapped data key. Implementations: the Postgres-key one below
 * (master key from the environment), later OpenBao or a cloud KMS behind the same interface.
 */
export interface Kms {
  /** Identifies the key that `wrap` uses now; stored beside every wrapped key so rotation can find the old one. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<Buffer>;
  /** Throws KmsError when the key id is unknown or the wrapped key was tampered with. */
  unwrap(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

export class KmsError extends Error {
  override readonly name = 'KmsError';
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM, output `iv(12) | tag(16) | ciphertext`. `aad` binds the blob to its context (key id, secret id). */
export function sealAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Inverse of sealAesGcm; throws (GCM authentication failure) when the blob or `aad` differs from what was sealed. */
export function openAesGcm(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new KmsError('sealed blob is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch (cause) {
    throw new KmsError('authentication failed: the sealed data was modified or the key is wrong', { cause });
  }
}

const fingerprint = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 12);

export interface PostgresKmsOptions {
  /** The 32-byte master key that wraps data keys. */
  masterKey: Buffer;
  /** Earlier master keys, still accepted by `unwrap` after a rotation. */
  previousKeys?: readonly Buffer[];
}

/**
 * The default Kms: AES-256-GCM key wrapping with a master key held by the process (env `MANYTHREADS_KMS_KEY`), not by the
 * database it protects. The key id is `pg:<fingerprint of the key>`.
 */
export function createPostgresKms(options: PostgresKmsOptions): Kms {
  const keys = new Map<string, Buffer>();
  for (const key of [options.masterKey, ...(options.previousKeys ?? [])]) {
    if (key.length !== 32) throw new KmsError('master key must be 32 bytes');
    keys.set(`pg:${fingerprint(key)}`, key);
  }
  const keyId = `pg:${fingerprint(options.masterKey)}`;
  return {
    keyId,
    wrap: async (dataKey) => sealAesGcm(options.masterKey, dataKey, Buffer.from(keyId)),
    unwrap: async (wrapped, id) => {
      const key = keys.get(id);
      if (!key) throw new KmsError(`unknown KMS key id "${id}"`);
      return openAesGcm(key, wrapped, Buffer.from(id));
    },
  };
}

const DEV_KEY_SEED = 'manythreads-dev-kms-key-NOT-FOR-PRODUCTION';
let warnedDevKey = false;

/**
 * Master key from `MANYTHREADS_KMS_KEY` (base64, 32 bytes). Unset: a fixed key derived from a public seed, with a one-time
 * warning, so dev and test databases work; refused when NODE_ENV=production.
 */
export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['MANYTHREADS_KMS_KEY'];
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new KmsError('MANYTHREADS_KMS_KEY must be base64 of exactly 32 bytes');
    return key;
  }
  if (env['NODE_ENV'] === 'production') throw new KmsError('MANYTHREADS_KMS_KEY is required in production');
  if (!warnedDevKey && env['NODE_ENV'] !== 'test') {
    warnedDevKey = true;
    process.emitWarning('MANYTHREADS_KMS_KEY is not set; using the insecure development KMS key', { code: 'MANYTHREADS_KMS_DEV_KEY' });
  }
  return createHash('sha256').update(DEV_KEY_SEED).digest();
}

/**
 * Earlier master keys from `MANYTHREADS_KMS_PREVIOUS_KEYS` (comma-separated base64, 32 bytes each): after rotating
 * `MANYTHREADS_KMS_KEY` they still unwrap what is stored, which is what the `kms.rewrap` job needs to move it to the new key.
 * Drop a key from the list once `admin kms-rewrap` has finished and nothing is wrapped by it.
 */
export function previousKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const raw = env['MANYTHREADS_KMS_PREVIOUS_KEYS'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const key = Buffer.from(part, 'base64');
      if (key.length !== 32) throw new KmsError('MANYTHREADS_KMS_PREVIOUS_KEYS must hold base64 of exactly 32 bytes per key');
      return key;
    });
}

let defaultKms: Kms | undefined;

/** The process-wide Kms built from the environment (cached). */
export function getKms(): Kms {
  return (defaultKms ??= createPostgresKms({ masterKey: masterKeyFromEnv(), previousKeys: previousKeysFromEnv() }));
}

/** Test hook: forget the cached Kms and the dev-key warning. */
export function resetKms(): void {
  defaultKms = undefined;
  warnedDevKey = false;
}
