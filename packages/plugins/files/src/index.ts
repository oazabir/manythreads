import { definePlugin } from '@manythreads/sdk';
import { registerFileRoutes } from './routes.ts';
import { registerFileLinks } from './links.ts';
import { registerTreeRoute } from './tree.ts';
import { BLOB_GC_CRON, BLOB_GC_QUEUE, blobGcHandler } from './gc.ts';

export { sanitizeFileName, numberedName } from './names.ts';
export { decideMime, sniffMime } from './mime.ts';
export { BLOB_GC_CRON, BLOB_GC_QUEUE, blobGcConfigFromEnv, runBlobGc, type BlobGcConfig, type BlobGcOptions, type BlobGcReport } from './gc.ts';

/**
 * Files: attachments of channels in the storage provider (`storage-local` by default) with the channel's ACL checked on every read
 * (SPEC section 5.2, principle 8; PLAN P3-08). docs/plugins/files.md has the routes, limits and the message link.
 */
export default definePlugin({
  manifest: {
    name: 'files',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['files.file.uploaded', 'files.file.deleted'], consumes: [] },
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerFileRoutes(ctx);
    registerFileLinks(ctx);
    registerTreeRoute(ctx);
    // Daily: delete the rows of long-hidden deleted-message files, then the blobs nothing references (docs/plugins/files.md, "Blob garbage collection").
    ctx.jobs.register(BLOB_GC_QUEUE, blobGcHandler(ctx), { cron: BLOB_GC_CRON, maxAttempts: 3 });
  },
});
