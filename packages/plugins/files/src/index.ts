import { definePlugin } from '@manythreads/sdk';
import { registerFileRoutes } from './routes.ts';
import { registerFileLinks } from './links.ts';
import { registerTreeRoute } from './tree.ts';
import { registerPersonalAdminRoutes } from './personal-admin.ts';
import { registerPersonalRoutes } from './personal-routes.ts';
import { registerPersonalShareRoutes } from './personal-share.ts';
import { filesReadFor } from './read.ts';
import { BLOB_GC_CRON, BLOB_GC_QUEUE, blobGcHandler } from './gc.ts';

export { sanitizeFileName, numberedName } from './names.ts';
export { decideMime, sniffMime } from './mime.ts';
export { BLOB_GC_CRON, BLOB_GC_QUEUE, blobGcConfigFromEnv, runBlobGc, type BlobGcConfig, type BlobGcOptions, type BlobGcReport } from './gc.ts';

/**
 * Files: attachments of channels, and a person's own Personal files (P20-02), in the storage provider (`storage-local` by default) with the channel's ACL checked on every read
 * (SPEC section 5.2, principle 8; PLAN P3-08). docs/plugins/files.md has the routes, limits and the message link.
 */
export default definePlugin({
  manifest: {
    name: 'files',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register', 'hook.pre_egress'],
    events: { emits: ['files.file.uploaded', 'files.file.deleted', 'files.file.restored', 'personal.space.opened', 'personal.space.exported'], consumes: [] },
    capabilities: [{ name: 'files.read', destructive: false }],
    // app.run_space_context() (bots) says which Personal space and which teams a run may read
    dependsOn: ['channels', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerFileRoutes(ctx);
    registerFileLinks(ctx);
    registerTreeRoute(ctx);
    registerPersonalRoutes(ctx);
    registerPersonalShareRoutes(ctx);
    registerPersonalAdminRoutes(ctx);
    // `files.read`: a bot reads a Personal file of the asker, or a team file, inside the spaces its run may read (P20-08).
    ctx.capabilities.register('files.read', filesReadFor(ctx));
    // Daily: delete the rows of long-hidden deleted-message files, then the blobs nothing references (docs/plugins/files.md, "Blob garbage collection").
    ctx.jobs.register(BLOB_GC_QUEUE, blobGcHandler(ctx), { cron: BLOB_GC_CRON, maxAttempts: 3 });
  },
});
