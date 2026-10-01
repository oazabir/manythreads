import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@majlis/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresKms,
  createSystemPool,
  getSecret,
  getSecretBytes,
  KmsError,
  masterKeyFromEnv,
  openAesGcm,
  putSecret,
  sealAesGcm,
  withSystem,
} from '../src/index.ts';

describe('AES-256-GCM envelope primitives', () => {
  const key = randomBytes(32);
  const aad = Buffer.from('context');

  it('round-trips and uses a fresh nonce each time', () => {
    const a = sealAesGcm(key, Buffer.from('hello'), aad);
    const b = sealAesGcm(key, Buffer.from('hello'), aad);
    expect(a.equals(b)).toBe(false);
    expect(openAesGcm(key, a, aad).toString()).toBe('hello');
  });

  it('detects tampering with ciphertext, tag, nonce, aad and key', () => {
    const sealed = sealAesGcm(key, Buffer.from('hello world'), aad);
    for (const i of [0, 5, 12, 20, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      expect(() => openAesGcm(key, bad, aad), `byte ${i}`).toThrow(KmsError);
    }
    expect(() => openAesGcm(key, sealed, Buffer.from('other'))).toThrow(KmsError);
    expect(() => openAesGcm(randomBytes(32), sealed, aad)).toThrow(KmsError);
    expect(() => openAesGcm(key, Buffer.alloc(5), aad)).toThrow(/too short/);
  });
});

describe('Postgres-key Kms', () => {
  it('wraps and unwraps a data key; the wrapped form hides it', async () => {
    const kms = createPostgresKms({ masterKey: randomBytes(32) });
    const dataKey = randomBytes(32);
    const wrapped = await kms.wrap(dataKey);
    expect(wrapped.includes(dataKey)).toBe(false);
    expect((await kms.unwrap(wrapped, kms.keyId)).equals(dataKey)).toBe(true);
    expect(kms.keyId).toMatch(/^pg:[0-9a-f]{12}$/);
  });

  it('rejects an unknown key id and a tampered wrapped key; accepts old keys after rotation', async () => {
    const oldKey = randomBytes(32);
    const oldKms = createPostgresKms({ masterKey: oldKey });
    const dataKey = randomBytes(32);
    const wrapped = await oldKms.wrap(dataKey);
    const newKms = createPostgresKms({ masterKey: randomBytes(32), previousKeys: [oldKey] });
    expect(newKms.keyId).not.toBe(oldKms.keyId);
    expect((await newKms.unwrap(wrapped, oldKms.keyId)).equals(dataKey)).toBe(true);
    await expect(createPostgresKms({ masterKey: randomBytes(32) }).unwrap(wrapped, oldKms.keyId)).rejects.toThrow(/unknown KMS key id/);
    const bad = Buffer.from(wrapped);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(oldKms.unwrap(bad, oldKms.keyId)).rejects.toThrow(KmsError);
    expect(() => createPostgresKms({ masterKey: Buffer.alloc(16) })).toThrow(/32 bytes/);
  });

  it('reads the master key from MANYTHREADS_KMS_KEY, derives a dev key when unset, refuses that in production', () => {
    const key = randomBytes(32);
    expect(masterKeyFromEnv({ MANYTHREADS_KMS_KEY: key.toString('base64') }).equals(key)).toBe(true);
    expect(() => masterKeyFromEnv({ MANYTHREADS_KMS_KEY: Buffer.alloc(8).toString('base64') })).toThrow(/32 bytes/);
    const dev = masterKeyFromEnv({});
    expect(dev).toHaveLength(32);
    expect(masterKeyFromEnv({}).equals(dev)).toBe(true);
    expect(() => masterKeyFromEnv({ NODE_ENV: 'production' })).toThrow(/required in production/);
  });
});

describe('putSecret / getSecret on the database', () => {
  let db: TestDatabase;
  let pool: ReturnType<typeof createSystemPool>;
  const kms = createPostgresKms({ masterKey: randomBytes(32) });

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createSystemPool(db.systemUrl, 3);
  }, 60_000);
  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(db);
  });

  const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]) => withSystem(fn, { pool });

  it('round-trips text and bytes; the stored row holds no plaintext', async () => {
    const id = await sys((tx) => putSecret(tx, 'sk-live-0123456789', kms));
    expect(await sys((tx) => getSecret(tx, id, kms))).toBe('sk-live-0123456789');
    const bytes = randomBytes(40);
    const id2 = await sys((tx) => putSecret(tx, bytes, kms));
    expect((await sys((tx) => getSecretBytes(tx, id2, kms))).equals(bytes)).toBe(true);
    const row = await sys((tx) =>
      tx.query<{ ciphertext: Buffer; wrapped_key: Buffer; key_id: string }>('SELECT * FROM secrets WHERE id = $1', [id]),
    );
    expect(row.rows[0]?.ciphertext.includes(Buffer.from('sk-live'))).toBe(false);
    expect(row.rows[0]?.key_id).toBe(kms.keyId);
  });

  it('detects a modified ciphertext, a modified wrapped key and a blob moved to another row', async () => {
    const id = await sys((tx) => putSecret(tx, 'top secret', kms));
    const other = await sys((tx) => putSecret(tx, 'something else', kms));
    await sys((tx) => tx.query(`UPDATE secrets SET ciphertext = set_byte(ciphertext, 20, get_byte(ciphertext, 20) # 1) WHERE id = $1`, [id]));
    await expect(sys((tx) => getSecret(tx, id, kms))).rejects.toThrow(KmsError);

    const id2 = await sys((tx) => putSecret(tx, 'top secret', kms));
    await sys((tx) => tx.query(`UPDATE secrets SET wrapped_key = set_byte(wrapped_key, 40, get_byte(wrapped_key, 40) # 1) WHERE id = $1`, [id2]));
    await expect(sys((tx) => getSecret(tx, id2, kms))).rejects.toThrow(KmsError);

    const id3 = await sys((tx) => putSecret(tx, 'top secret', kms));
    await sys((tx) =>
      tx.query(
        `UPDATE secrets s SET ciphertext = o.ciphertext, wrapped_key = o.wrapped_key FROM secrets o WHERE s.id = $1 AND o.id = $2`,
        [id3, other],
      ),
    );
    await expect(sys((tx) => getSecret(tx, id3, kms))).rejects.toThrow(KmsError);
  });

  it('a missing secret and the wrong master key fail', async () => {
    await expect(sys((tx) => getSecret(tx, randomUUID(), kms))).rejects.toThrow(/not found/);
    const id = await sys((tx) => putSecret(tx, 'x', kms));
    await expect(sys((tx) => getSecret(tx, id, createPostgresKms({ masterKey: randomBytes(32) })))).rejects.toThrow(/unknown KMS key id/);
  });
});
