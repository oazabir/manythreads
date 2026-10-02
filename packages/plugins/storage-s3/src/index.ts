import { definePlugin } from '@manythreads/sdk';
import { createS3BlobStorage, createS3Client, s3ConfigFromEnv } from './s3-storage.ts';

export {
  createS3BlobStorage,
  createS3Client,
  ensureBucket,
  s3ConfigFromEnv,
  DEFAULT_PREFIX,
  PART_SIZE,
  QUEUE_SIZE,
  type S3BlobStorageOptions,
  type S3Config,
} from './s3-storage.ts';

/**
 * The S3 `provider.storage` plugin: attachment bytes in an S3-compatible bucket (AWS, MinIO, R2, Ceph). The server loads it instead of
 * storage-local when `MANYTHREADS_STORAGE=s3` (exactly one `storage` provider is registered). docs/plugins/storage-s3.md.
 */
export default definePlugin({
  manifest: {
    name: 'storage-s3',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.storage'],
    capabilities: [],
    events: { emits: [], consumes: [] },
  },
  register(ctx) {
    const config = s3ConfigFromEnv(process.env);
    ctx.providers.register('storage', createS3BlobStorage({ client: createS3Client(config), bucket: config.bucket, prefix: config.prefix }));
  },
});
