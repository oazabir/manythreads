import { definePlugin } from '@manythreads/sdk';
import { createLocalBlobStorage, storageDirFromEnv } from './local-storage.ts';

export { createLocalBlobStorage, storageDirFromEnv, DEFAULT_STORAGE_DIR, type LocalBlobStorageOptions } from './local-storage.ts';

export default definePlugin({
  manifest: {
    name: 'storage-local',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.storage'],
    capabilities: [],
    events: { emits: [], consumes: [] },
  },
  register(ctx) {
    ctx.providers.register('storage', createLocalBlobStorage({ dir: storageDirFromEnv(process.env) }));
  },
});
