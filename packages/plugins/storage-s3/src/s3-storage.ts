import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  InvalidBlobKeyError,
  type BlobHead,
  type BlobListItem,
  type BlobListPage,
  type BlobPutResult,
  type BlobStorage,
} from '@manythreads/sdk';

/** 128 random bits, lower-case hex: the same key shape as storage-local, and the only one `get`, `head` and `delete` accept. */
const KEY = /^[0-9a-f]{32}$/;

/** Multipart part size and parallelism of `put`: a body under one part is a single PutObject, a larger one streams in parts (S3 minimum 5 MiB). */
export const PART_SIZE = 8 * 1024 * 1024;
export const QUEUE_SIZE = 4;

export interface S3Config {
  /** Absent for AWS itself; the URL of MinIO, R2, Ceph, ... */
  endpoint?: string;
  bucket: string;
  region: string;
  /** Both or neither: with neither, the AWS default credential chain applies (environment, shared config, instance role). */
  accessKey?: string;
  secretKey?: string;
  /** `http://host/bucket/key` instead of `http://bucket.host/key`: needed by MinIO and most self-hosted stores. */
  forcePathStyle: boolean;
  /** Key prefix of every object, ending in `/` (or empty). `list` sees only this prefix, so a bucket can be shared. */
  prefix: string;
}

export const DEFAULT_PREFIX = 'blobs/';

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

/**
 * `MANYTHREADS_S3_{ENDPOINT,BUCKET,REGION,ACCESS_KEY,SECRET_KEY,FORCE_PATH_STYLE,PREFIX}`. The bucket is required (the server does not start
 * without it when `MANYTHREADS_STORAGE=s3`); the region defaults to `us-east-1`; the prefix to `blobs/`.
 */
export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3Config {
  const get = (name: string): string | undefined => env[`MANYTHREADS_S3_${name}`]?.trim() || undefined;
  const bucket = get('BUCKET');
  if (!bucket) throw new Error('MANYTHREADS_STORAGE=s3 needs MANYTHREADS_S3_BUCKET');
  const accessKey = get('ACCESS_KEY');
  const secretKey = get('SECRET_KEY');
  if ((accessKey === undefined) !== (secretKey === undefined)) {
    throw new Error('MANYTHREADS_S3_ACCESS_KEY and MANYTHREADS_S3_SECRET_KEY go together: set both, or neither to use the default AWS credential chain');
  }
  const rawPrefix = env['MANYTHREADS_S3_PREFIX']?.trim();
  const prefix = rawPrefix === undefined || rawPrefix === '' ? DEFAULT_PREFIX : rawPrefix.replace(/^\/+/, '').replace(/\/*$/, '/');
  const endpoint = get('ENDPOINT');
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    bucket,
    region: get('REGION') ?? 'us-east-1',
    ...(accessKey !== undefined && secretKey !== undefined ? { accessKey, secretKey } : {}),
    forcePathStyle: truthy(env['MANYTHREADS_S3_FORCE_PATH_STYLE']),
    prefix,
  };
}

export function createS3Client(config: S3Config): S3Client {
  const options: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    // Checksums only where S3 requires them: the default (CRC32 trailers on every upload) is refused by older MinIO and some other stores.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.accessKey !== undefined && config.secretKey !== undefined
      ? { credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } }
      : {}),
  };
  return new S3Client(options);
}

export interface S3BlobStorageOptions {
  client: S3Client;
  bucket: string;
  /** Ends in `/` or is empty; default `blobs/`. */
  prefix?: string;
}

type Destroyable = { destroy?: (error?: Error) => unknown };

const statusOf = (err: unknown): number | undefined => (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const isMissing = (err: unknown): boolean => {
  const name = (err as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound' || statusOf(err) === 404;
};

/**
 * Blobs as S3 objects `<prefix><key>` with random keys (never content-derived, as in storage-local). `put` streams: a body of one part
 * or less is one PutObject, a larger one is a multipart upload with bounded memory (`QUEUE_SIZE` parts of `PART_SIZE` in flight), and the
 * size cap, the SHA-256 and the abort-on-error are enforced by one transform in front of the uploader, so an unbounded source is never drained.
 * A multipart upload that fails is aborted; an object is only visible once it is complete, so a reader never sees a partial blob.
 */
export function createS3BlobStorage(options: S3BlobStorageOptions): BlobStorage {
  const { client, bucket } = options;
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  const objectKey = (blobKey: string): string => {
    if (typeof blobKey !== 'string' || !KEY.test(blobKey)) throw new InvalidBlobKeyError();
    return `${prefix}${blobKey}`;
  };

  const head = async (blobKey: string): Promise<BlobHead | null> => {
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(blobKey) }));
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      if (err instanceof InvalidBlobKeyError) throw err;
      if (isMissing(err)) return null;
      throw err;
    }
  };

  return {
    id: 's3',

    async put(stream, { maxBytes }): Promise<BlobPutResult> {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
      const blobKey = randomBytes(16).toString('hex');
      const key = objectKey(blobKey);
      const hash = createHash('sha256');
      let size = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > maxBytes) return callback(new BlobTooLargeError(maxBytes));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const body = new PassThrough();
      const upload = new Upload({
        client,
        queueSize: QUEUE_SIZE,
        partSize: PART_SIZE,
        leavePartsOnError: false,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: 'application/octet-stream' },
      });
      let uploadFailed = false;
      const uploading = upload.done();
      // If the store refuses the upload, nobody reads `body` any more: closing it ends the pipeline instead of leaving it waiting for a drain.
      uploading.catch(() => {
        uploadFailed = true;
        body.destroy();
      });
      const piping = pipeline(stream as unknown as Readable, guard, body);
      const [piped, uploaded] = await Promise.allSettled([piping, uploading]);
      if (piped.status === 'fulfilled' && uploaded.status === 'fulfilled') return { blobKey, size, sha256: hash.digest('hex') };

      // Failure: stop everything, make sure nothing stays in the bucket, and report the cause (the source's or the cap's error, else the store's).
      (stream as Destroyable).destroy?.();
      body.destroy();
      await upload.abort().catch(() => undefined);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
      if (uploadFailed && uploaded.status === 'rejected') throw uploaded.reason;
      throw piped.status === 'rejected' ? piped.reason : (uploaded as PromiseRejectedResult).reason;
    },

    async get(blobKey) {
      const Key = objectKey(blobKey);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
        if (!res.Body) throw new BlobNotFoundError();
        return res.Body as Readable;
      } catch (err) {
        if (isMissing(err)) throw new BlobNotFoundError();
        throw err;
      }
    },

    async delete(blobKey) {
      const Key = objectKey(blobKey);
      // S3 answers 204 whether or not the object existed, so ask first: the contract says `true` only when something was removed.
      if ((await head(blobKey)) === null) return false;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      return true;
    },

    head,

    async list({ after, limit }): Promise<BlobListPage> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000');
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: limit,
          ...(after !== undefined && after !== '' ? { StartAfter: `${prefix}${after}` } : {}),
        }),
      );
      const items: BlobListItem[] = [];
      for (const o of res.Contents ?? []) {
        const blobKey = (o.Key ?? '').slice(prefix.length);
        // Only what this provider issued: anything else under the prefix (a console upload, a lifecycle marker) is not ours to garbage-collect.
        if (!KEY.test(blobKey)) continue;
        items.push({ blobKey, size: o.Size ?? 0, modifiedAt: o.LastModified ?? new Date(0) });
      }
      const last = res.Contents?.at(-1)?.Key;
      return { items, next: res.IsTruncated === true && last !== undefined ? last.slice(prefix.length) : null };
    },
  };
}
