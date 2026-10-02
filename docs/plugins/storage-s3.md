# storage-s3

The `provider.storage` plugin for an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Ceph, ...): attachment bytes, one object per blob. It implements the same `BlobStorage`
interface as [storage-local](./storage-local.md) (`put` streaming with `maxBytes`, `get`, `head`, `delete`, `list`), so the composer, the `files` plugin and the blob GC do not know which
one is loaded. Code: `packages/plugins/storage-s3`. Built on `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`.

## Choosing the store

The server registers **one** `storage` provider. `MANYTHREADS_STORAGE` decides which plugin loads; the other is not loaded at all:

| `MANYTHREADS_STORAGE` | Plugin | Needs |
|---|---|---|
| `local` (default, or unset) | `storage-local` | `MANYTHREADS_STORAGE_DIR` (a persistent volume) |
| `s3` | `storage-s3` | `MANYTHREADS_S3_BUCKET` at least |

Any other value stops the server at start ("must be local or s3"): a typo must not pick a store. `startServer({ storage: 's3' })` does the same for embedded use and tests
(`startTestServer` always means `local` unless a test asks, so the environment cannot change a test's store). **Switching stores does not move blobs**: files uploaded to the old one
stay there and their downloads answer 404/500; copy the objects (`<key[0..2]>/<key>` on disk to `<prefix><key>` in the bucket) before switching a deployment that has data.

## Configuration

| Variable | Default | |
|---|---|---|
| `MANYTHREADS_S3_BUCKET` | required | The bucket must exist: the plugin never creates it. |
| `MANYTHREADS_S3_ENDPOINT` | AWS | URL of MinIO, R2, Ceph, ... (`http://minio:9000`). |
| `MANYTHREADS_S3_REGION` | `us-east-1` | Many S3-compatible stores ignore it, but the signer needs one. |
| `MANYTHREADS_S3_ACCESS_KEY`, `MANYTHREADS_S3_SECRET_KEY` | AWS default chain | Both or neither: with neither, the AWS credential chain applies (environment, shared config, an instance or pod role); one without the other stops the start. |
| `MANYTHREADS_S3_FORCE_PATH_STYLE` | `false` | `true`/`1`/`yes`/`on`: `http://host/bucket/key` instead of `http://bucket.host/key`. MinIO and most self-hosted stores need it. |
| `MANYTHREADS_S3_PREFIX` | `blobs/` | Key prefix of every object. `list` sees only this prefix, so a bucket can be shared; a trailing `/` is added. |

The server will not start with `MANYTHREADS_STORAGE=s3` and no bucket (the plugin throws while loading). Credentials and endpoint are not logged.

## Behaviour

- **Keys** are the provider's: 128 random bits as 32 lower-case hex characters, never derived from content, exactly as in storage-local; the object is `<prefix><key>`. `get`, `head` and
  `delete` accept only that shape (`InvalidBlobKeyError` otherwise, before any network call). `list` returns only keys of that shape, so a README someone uploaded under the prefix is
  not ours to collect.
- **`put`** streams through one pipeline: source, a transform that counts bytes (rejecting with `BlobTooLargeError` at the first byte over `maxBytes`, which destroys the source
  and stops reading), hashes SHA-256, and the multipart uploader (`@aws-sdk/lib-storage`: a body of one part, 8 MiB, is one `PutObject`; larger is a multipart upload, 4 parts in flight,
  so memory stays near 32 MiB per upload however large the file is). Any failure (cap, source error, client abort, store error) aborts the multipart upload, deletes any object,
  and rethrows the cause; nothing is left behind. An object is visible only when complete.
- **`delete`** answers `true` only if the object existed (S3 says 204 either way, so it asks `HEAD` first). Two uploads of the same bytes are two objects.
- **`list`** is `ListObjectsV2` with `StartAfter`: ascending by key, `limit` up to 1,000 per page, `modifiedAt` from `LastModified`. The blob GC pages through it.
- **Checksums** are requested only where S3 requires them (`requestChecksumCalculation: WHEN_REQUIRED`): the SDK's default trailing CRC32 on every upload is refused by older MinIO and by
  some other stores.
- **Incomplete multipart uploads** that a crashed server leaves are invisible and cost storage until aborted: add a bucket lifecycle rule "abort incomplete multipart uploads after 1 day"
  (the AWS console's default for new buckets; MinIO: `mc ilm rule add --expire-delete-marker`/`--noncurrent...` do not cover it, MinIO cleans them itself).
- **Access control stays in the application**: the bucket must be private. The browser never sees an object URL; `GET /api/files/:id/content` re-checks the channel ACL on every read
  and streams the object through the server (spec principle 8), so a presigned URL would bypass that rule and is not used.

## Tests

`packages/plugins/storage-s3/test/s3-storage.test.ts`. Config parsing, the plugin and key rejection always run. The **provider contract** (the shared suite
`@manythreads/test-utils/blob-contract`, the same cases storage-local runs: put/get/head/delete, size cap and abort mid-stream, failures leave nothing, keys, 40 concurrent
puts, a 13 MiB multipart body, `list` paging) and the S3-specific cases (prefix isolation, foreign objects, no leftover multipart uploads) need an endpoint and run when
`MANYTHREADS_TEST_S3=1`:

```
pnpm s3:up                                      # MinIO from deploy/compose (profile s3): API :9000, console :9001, minio / manythreads-secret
MANYTHREADS_TEST_S3=1 pnpm --filter @manythreads/plugin-storage-s3 exec vitest run
pnpm s3:down
```

`MANYTHREADS_TEST_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY}` override `http://localhost:9000`, `manythreads-test` (created if missing), `manythreads`, `manythreads-secret`. Each run uses a prefix of
its own and empties it afterwards. CI starts the same MinIO image next to Postgres and sets `MANYTHREADS_TEST_S3=1` for `pnpm test` (`.github/workflows/ci.yml`; a `docker run` step, because
a GitHub service container cannot pass the `server /data` arguments). The image is the last community MinIO release, pinned (`ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`), since MinIO
no longer publishes images to Docker Hub or quay.io.

## The seed's attachments

`pnpm seed` (seed v3 and v4, `packages/test-utils/src/seed-storage.ts`) writes its attachments (the Deploy plan PDF, a PNG, an MP4 and an Office file in `#dev`) **through the storage provider**,
not into a directory: `MANYTHREADS_STORAGE=s3` (read like the server reads it) puts the bytes in the bucket named by the same `MANYTHREADS_S3_*` variables, with the provider's own random key
on the `files` row. A row whose bytes are still in the store is left alone; a row whose bytes are gone (new bucket or volume) gets them put again under a new key. Tested against
MinIO in `packages/test-utils/test/seed-repo.test.ts` (`MANYTHREADS_TEST_S3=1`) and with a non-local fake provider that runs always.

## Not here

Presigned downloads, server-side encryption options, multi-region and storage classes, a migration tool between stores (copy the objects yourself), bucket creation.
