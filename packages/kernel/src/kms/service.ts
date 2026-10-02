import type { PluginTx, SecretService } from '@manythreads/sdk';
import type { Tx } from '../db/index.ts';
import { getKms, type Kms } from './kms.ts';
import { deleteSecret, getSecret, putSecret } from './secrets.ts';

/**
 * `ctx.secrets` for plugins: putSecret / getSecret / deleteSecret behind the SDK interface. The Kms is resolved on
 * first use, so a server without a configured master key only warns when a secret is actually stored.
 */
export function createSecretService(kms?: Kms): SecretService {
  const resolve = (): Kms => kms ?? getKms();
  return {
    put: async (tx: PluginTx, plaintext: string) => putSecret(tx as unknown as Tx, plaintext, resolve()),
    get: (tx: PluginTx, secretId: string) => getSecret(tx as unknown as Tx, secretId, resolve()),
    delete: (tx: PluginTx, secretId: string) => deleteSecret(tx as unknown as Tx, secretId),
  };
}
