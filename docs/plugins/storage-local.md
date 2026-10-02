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

The directory must be on persistent storage. Compose and Helm will mount a volume (a PVC on k3s) at this path in a later
task; until then a container restart loses blobs. With more than one server replica the volume must be shared
(ReadWriteMany) or the deployment must use an object-storage provider instead.

## Not here

The size limit policy (`maxBytes` comes from the caller), content-type checks, the `files` table, ACL checks and
upload/download routes belong to the files task, which calls this provider.
