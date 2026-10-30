import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { PluginContext } from '@manythreads/sdk';

// The key that signs a workspace's audit exports. One ed25519 key pair per workspace, made the first time it is needed. The public half sits in
// `audit_signing_keys` (an auditor fetches it from `GET /api/admin/audit/signing-key`); the private half is a sealed secret (`ctx.secrets`, the same
// envelope encryption as a model provider's API key) that only the system role can read back, and no route returns it.

export interface SigningKey {
  keyId: string;
  publicKeyPem: string;
  createdAt: Date;
}

/** A short, stable name for a public key: the first 16 hex characters of the SHA-256 of its DER encoding. */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

type KeyRow = {
  key_id: string;
  public_key_pem: string;
  secret_id: string;
  created_at: Date;
};

/** The workspace's public key, made on first use. */
export async function signingKey(ctx: PluginContext, workspaceId: string): Promise<SigningKey> {
  return ctx.db.system(
    async (tx) => {
      const found = (await tx.query<KeyRow>('SELECT key_id, public_key_pem, secret_id, created_at FROM app.audit_signing_keys WHERE workspace_id = $1', [workspaceId])).rows[0];
      if (found) return { keyId: found.key_id, publicKeyPem: found.public_key_pem, createdAt: found.created_at };
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const secretId = await ctx.secrets.put(tx, privatePem);
      const inserted = (
        await tx.query<KeyRow>(
          `INSERT INTO app.audit_signing_keys (workspace_id, key_id, public_key_pem, secret_id) VALUES ($1, $2, $3, $4::uuid)
           ON CONFLICT (workspace_id) DO NOTHING RETURNING key_id, public_key_pem, secret_id, created_at`,
          [workspaceId, keyIdOf(publicPem), publicPem, secretId],
        )
      ).rows[0];
      if (inserted) return { keyId: inserted.key_id, publicKeyPem: inserted.public_key_pem, createdAt: inserted.created_at };
      // another request made the key first: drop the secret just sealed and use theirs
      await ctx.secrets.delete(tx, secretId);
      const winner = (await tx.query<KeyRow>('SELECT key_id, public_key_pem, secret_id, created_at FROM app.audit_signing_keys WHERE workspace_id = $1', [workspaceId])).rows[0]!;
      return { keyId: winner.key_id, publicKeyPem: winner.public_key_pem, createdAt: winner.created_at };
    },
    { workspaceId },
  );
}

/** Signs `bytes` with the workspace's key; the signature is base64 (a raw ed25519 signature, 64 bytes). */
export async function signBytes(ctx: PluginContext, workspaceId: string, bytes: Buffer): Promise<{ keyId: string; signature: string }> {
  const key = await signingKey(ctx, workspaceId);
  const privatePem = await ctx.db.system(
    async (tx) => {
      const row = (await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.audit_signing_keys WHERE workspace_id = $1', [workspaceId])).rows[0]!;
      return ctx.secrets.get(tx, row.secret_id);
    },
    { workspaceId },
  );
  const signature = sign(null, bytes, createPrivateKey(privatePem)).toString('base64');
  return { keyId: key.keyId, signature };
}
