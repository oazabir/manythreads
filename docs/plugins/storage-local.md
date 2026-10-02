# storage-local

The default `provider.storage` plugin: attachment bytes on local disk. It stores and serves blobs and knows nothing
about people, channels or files; the `files` table and the upload/download routes (which check the channel ACL on every
read, spec principle 8) sit above it and call this interface.

## Interface (`BlobStorage` in `@manythreads/sdk`)

| Method | Behaviour |
|---|---|
| `put(stream, { maxBytes })` | Streams to disk, hashing as it goes. Returns `{ blobKey, size, sha256 }`. More than `maxBytes` arriving rejects with `BlobTooLargeError` at once: the source is destroyed, the partial file removed, nothing stored. Any other failure (source error, client abort) also leaves nothing behind. |
| `get(blobKey)` | A readable stream (a Node `Readable`). `BlobNotFoundError` when nothing is stored. |
| `head(blobKey)` | `{ size }` or `null`. |
| `delete(blobKey)` | `true` when something was removed, `false` when nothing was there. |
| `list({ after?, limit })` | Every finished blob, ascending by key, `limit` (1 to 1000) per page: `{ items: [{ blobKey, size, modifiedAt }], next }` (`next` is the key to pass as `after`, null at the end). Skips `.tmp`, directories and files that are not keys. Only the blob GC calls it ([files.md](./files.md)). |

`stream` is any `AsyncIterable<Uint8Array>`. The plugin calls `ctx.providers.register('storage', impl)`; the impl has `id: 'local'`.

## Keys and layout

Keys are 128 random bits as 32 lower-case hex characters, never derived from content: two uploads of the same bytes
are two blobs, so deleting one `files` row cannot break another. `get`, `head` and `delete` accept only that shape and
throw `InvalidBlobKeyError` for anything else (separators, dots, `..`, other length or case, NUL), so a key can never
leave the storage directory.

```
$MANYTHREADS_STORAGE_DIR/
  .tmp/<key>.part      uploads in progress; moved into place with an atomic rename once complete
  ab/abcdef...         finished blobs, sharded by the first two characters of the key
```

A reader never sees a partial blob. A crash mid-upload leaves a `.part` file in `.tmp`; it is safe to delete any `.part`
file older than a few minutes.

## Configuration

| Variable | Default | |
|---|---|---|
| `MANYTHREADS_STORAGE_DIR` | `./data/blobs` | Root directory, created on first upload. Relative paths resolve against the server's working directory. |

The directory must be on persistent storage. The Helm chart mounts the PVC `manythreads-blobs` (local-path, 5Gi by default,
`server.blobs.persistence` in values) at `/data/blobs` and sets this variable to it; the server Deployment uses the `Recreate`
strategy because the volume is ReadWriteOnce, and the demo seed Job mounts the same claim (on the server's node) so the seeded
attachment is where the server looks (docs/deploy.md). With more than one server replica the volume must be shared
(ReadWriteMany) or the deployment must use an object-storage provider instead. Compose dev uses `./data/blobs`.

The same contract suite (`@manythreads/test-utils/blob-contract`, one set of cases) runs against this provider and against [storage-s3](./storage-s3.md); `test/local-storage.test.ts`
adds what only a directory has (layout, `.tmp`, traversal on disk, `list` ignoring strays). Which of the two loads is `MANYTHREADS_STORAGE` (default `local`, see storage-s3.md).

## Not here

The size limit policy (`maxBytes` comes from the caller), content-type checks, the `files` table, ACL checks and
upload/download routes belong to the files task, which calls this provider.
