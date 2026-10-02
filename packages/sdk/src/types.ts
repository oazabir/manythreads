import type { ErrorCode, ExtensionPoint, PluginManifest, TeamTemplate } from '@manythreads/shared';
import type { ZodType } from 'zod';

/** What a plugin sees of a database transaction: queries inside one actor transaction, nothing else. */
export interface PluginTx {
  readonly actor: { readonly kind: 'person' | 'bot' | 'system'; readonly id: string; readonly workspaceId: string };
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** An event as stored: the registry-validated envelope plus its payload fields. */
export interface PluginEvent {
  type: string;
  schemaVersion: number;
  [field: string]: unknown;
}

export type EventHandler = (event: PluginEvent, tx: PluginTx) => void | Promise<void>;

/** The kernel's `emit(tx, event)`, as plugins see it. Validation against the event registry happens there. */
export type EmitEvent = (tx: PluginTx, event: PluginEvent) => Promise<unknown>;

export interface HookInput {
  /** Event type for pre_persist; destination (`channel`, `email`, ...) for pre_egress. */
  subject: string;
  payload: Record<string, unknown>;
}
/** Return a replacement input to rewrite, nothing to pass through, or throw to block. */
export type Hook = (input: HookInput, tx: PluginTx) => HookInput | void | Promise<HookInput | void>;

export const PROVIDER_KINDS = [
  'identity',
  'memory',
  'bot_runtime',
  'storage',
  'llm',
  'knowledge',
  'viewer',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export interface ProviderImpl {
  id: string;
  [member: string]: unknown;
}

export interface CommandDefinition {
  /** Slash-command name without the slash. */
  name: string;
  description?: string;
  run(args: string, tx: PluginTx): void | Promise<void>;
}

export interface TriggerDefinition {
  /** Trigger type a bot can bind to (spec §7.2). */
  name: string;
  description?: string;
}

export interface ComponentDefinition {
  name: string;
  description?: string;
  /** JSON Schema of the component's props (declarative, never code). */
  schema: Record<string, unknown>;
}

/** Declarative surface: client plugins describe screens, they do not ship run-time JS. */
export interface SurfaceDefinition {
  id: string;
  title: string;
  /** Sidebar order for nav items (Files 10, Boards 20, ...). */
  order?: number;
  route?: string;
  schema?: Record<string, unknown>;
}

export interface SettingsPageDefinition {
  id: string;
  title: string;
  schema: Record<string, unknown>;
}

export interface ComposerActionDefinition {
  id: string;
  label: string;
  /** Command name or capability the action invokes. */
  invokes: string;
}

/** Who is calling a route: set when the request carries a valid session cookie (or, in tests, a dev actor). */
export interface HttpCaller {
  /** The `actors` row id (what `tx.actor.id` is for a route that runs as the caller). */
  actorId: string;
  kind: 'person' | 'bot';
  workspaceId: string;
  /** The person behind the actor; null for a bot or a dev-header actor. */
  personId: string | null;
  /** The session the request arrived on; null when the request is not cookie-authenticated. */
  sessionId: string | null;
}
export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  /** Lower-cased header names; repeated headers are joined by the server. */
  headers: Record<string, string | undefined>;
  /** Client address as the server sees it (honours the server's trustProxy setting). */
  ip: string;
  /** The authenticated caller, or null on a public route reached anonymously. */
  caller: HttpCaller | null;
}
export interface HttpResponse {
  status?: number;
  body?: unknown;
  /** Extra response headers (e.g. `retry-after`). */
  headers?: Record<string, string>;
  /** Start a session: the server sets the session and CSRF cookies from an `identity.sessions.issue` result. */
  setSession?: IssuedSession;
  /** End the browser's session: the server clears both cookies. */
  clearSession?: boolean;
}

/**
 * Thrown from a route handler to answer with a status and the standard error envelope. Throwing rolls the route's
 * transaction back; to keep writes (audit events) while failing, return `{ status, body }` instead.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;
  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
export interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute API path, mounted as declared (e.g. `/api/channels/:channelId/messages`). Duplicate method+path across plugins fails at load. */
  path: string;
  /** Zod schemas the server validates with; a failure is a 400 `validation_failed` with the field path. Use `z.strictObject` for bodies. */
  schema?: {
    body?: ZodType;
    query?: ZodType;
    /** Shape of a 200 response; a handler that returns something else is a 500 (a bug), never sent to the client. */
    response?: ZodType;
  };
  /** Per-key limit for this route, counted in the server process (per replica). Keyed by actor, else client IP. */
  rateLimit?: { limit: number; windowMs: number };
  /**
   * Reachable without an actor (sign-in, health-like or test routes). Default false: the route answers 401 unless the
   * request carries a valid session cookie (or, only under NODE_ENV=test, a dev-header actor).
   */
  public?: boolean;
  /**
   * Skip the double-submit CSRF check that unsafe methods otherwise get on cookie-authenticated requests. Only for
   * routes that must work with a stale or missing token (none of the built-in ones need it).
   */
  csrfExempt?: boolean;
  handler(request: HttpRequest, tx: PluginTx): HttpResponse | Promise<HttpResponse>;
}

export type CapabilityHandler = (input: Record<string, unknown>, tx: PluginTx) => unknown | Promise<unknown>;

export type ScopeType = 'workspace' | 'team' | 'person';
export interface StorageScope {
  type: ScopeType;
  id: string;
}
/** Scoped key-value storage (one namespace per plugin). */
export interface ScopedKv {
  get(scope: StorageScope, key: string): Promise<unknown>;
  set(scope: StorageScope, key: string, value: unknown): Promise<void>;
  delete(scope: StorageScope, key: string): Promise<boolean>;
}

/**
 * What `register(ctx)` receives. Every method that maps to an extension point throws if the manifest's
 * `extends` does not list it; `events.*` also checks the manifest's `events.emits` / `events.consumes`.
 */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly events: {
    subscribe(type: string, handler: EventHandler): void;
    emit(tx: PluginTx, event: PluginEvent): Promise<void>;
  };
  readonly hooks: {
    prePersist(hook: Hook): void;
    preEgress(hook: Hook): void;
  };
  readonly providers: { register(kind: ProviderKind, impl: ProviderImpl): void };
  readonly commands: { register(definition: CommandDefinition): void };
  readonly triggers: { register(definition: TriggerDefinition): void };
  readonly components: { register(definition: ComponentDefinition): void };
  readonly surfaces: {
    nav(definition: SurfaceDefinition): void;
    screen(definition: SurfaceDefinition): void;
    card(definition: SurfaceDefinition): void;
    panel(definition: SurfaceDefinition): void;
  };
  readonly settings: { page(definition: SettingsPageDefinition): void };
  readonly composer: { action(definition: ComposerActionDefinition): void };
  /** Bind an implementation to a capability this plugin declared in its manifest. */
  readonly capabilities: { register(name: string, handler: CapabilityHandler): void };
  /** Routes the server mounts at their declared absolute paths. */
  readonly http: { route(definition: HttpRouteDefinition): void };
  readonly storage: ScopedKv;
  /** Database helpers that keep plugins from re-implementing kernel statements (get-or-create). */
  readonly db: PluginDb;
  /** Audit events: `ctx.events.emit` with the envelope filled in. Needs `event.emit` and the type in `events.emits`. */
  readonly audit: PluginAudit;
  /** The shipped team templates (`templates/` at the repository root, or `MANYTHREADS_TEMPLATES_DIR`). */
  readonly templates: PluginTemplates;
  /** Background jobs. Only for plugins whose manifest extends `job.register`; any other plugin throws on access. */
  readonly jobs: PluginJobs;
  readonly mail: MailService;
  readonly runtime: PluginRuntime;
  /** Only for plugins whose manifest extends `provider.identity`; any other plugin throws on access. */
  readonly identity: IdentityServices;
  /** Envelope-encrypted secrets (client secrets of sign-in providers). Only for plugins that extend `provider.identity`. */
  readonly secrets: SecretService;
}

/** Input of `ctx.db.getOneOrCreate`: one `INSERT ... ON CONFLICT ... DO SELECT` (Postgres 19). */
export interface GetOneOrCreateInput {
  /** `table` or `schema.table`. Identifiers are validated (lowercase letters, digits, underscore). */
  table: string;
  /** Column to value for the insert; must include every column of the conflict target. */
  values: Readonly<Record<string, unknown>>;
  /** Columns of the unique index the conflict is detected on. */
  conflict: readonly string[];
  /** Predicate of a partial unique index (`kind = 'dm'`), written as trusted SQL, never from user input. */
  conflictWhere?: string;
  /** Columns to return; defaults to all. */
  returning?: readonly string[];
}

export interface PluginDb {
  /**
   * The kernel's one get-or-create: inserts the row or returns the existing one for the conflict target, in a single
   * statement, so concurrent callers converge on one row and a hit writes nothing. To know whether you created it, put a
   * pre-drawn id in `values` (`SELECT uuidv7()`) and compare it with the returned `id`.
   */
  getOneOrCreate<R extends Record<string, unknown> = Record<string, unknown>>(tx: PluginTx, input: GetOneOrCreateInput): Promise<R>;
}

/** An audit event as a plugin writes it: `schemaVersion` defaults to 1 and `workspaceId` to the transaction's workspace. */
export interface AuditEvent {
  type: string;
  schemaVersion?: number;
  workspaceId?: string;
  [field: string]: unknown;
}

export interface PluginAudit {
  /** Validated against the event registry and written with the outbox rows in `tx`, like `ctx.events.emit`. */
  emit(tx: PluginTx, event: AuditEvent): Promise<void>;
}

export interface PluginTemplates {
  /** Every template, sorted by id. Read once and cached; an invalid template file fails here, naming file and field. */
  list(): Promise<readonly TeamTemplate[]>;
  get(id: string): Promise<TeamTemplate | undefined>;
}

/** What a job handler learns about the run it is in. */
export interface JobInfo {
  jobId: string;
  /** 1 on the first run. */
  attempt: number;
  workerId: string;
}

/**
 * Runs once per claimed job inside one transaction as the SYSTEM actor (no RLS), scoped to `payload.workspaceId` when it is a
 * string. A throw rolls the transaction back and the job is retried with backoff, then dead-lettered; a return commits it. Check
 * everything the payload says: it is whatever was enqueued, by anyone who could call `ctx.jobs.enqueue`.
 */
export type JobHandler = (payload: Record<string, unknown>, tx: PluginTx, job: JobInfo) => void | Promise<void>;

export interface JobOptions {
  /** Jobs of this queue in flight at once in one server process (default 1). */
  concurrency?: number;
  /** Attempts before the job is dead-lettered (default 5). */
  maxAttempts?: number;
}

export interface EnqueueJobOptions {
  runAt?: Date;
  /** While a job with this key is ready or running in the queue, enqueue returns it instead of adding another. */
  dedupeKey?: string;
}

export interface PluginJobs {
  /**
   * Handle `queue`. The queue must be named `<plugin>.<name>` (the plugin's own namespace) and may be registered once.
   * The server starts the worker; handlers must be idempotent (a job can run again after a crash or a failed commit).
   */
  register(queue: string, handler: JobHandler, options?: JobOptions): void;
  /** Adds a job in `tx`: it exists, and workers are woken, when `tx` commits. Same queue-name rule. Returns the job id. */
  enqueue(tx: PluginTx, queue: string, payload: Record<string, unknown>, options?: EnqueueJobOptions): Promise<string>;
}

/** What `identity.sessions.issue` returns: the opaque token and the CSRF token it is bound to. Never log either. */
export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string;
}

/** A session as listed to its owner; no token, no hash. */
export interface SessionRecord {
  id: string;
  /** Short device label, e.g. `Chrome on macOS`. */
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

/** Session storage for sign-in plugins. Every method takes the system transaction from `identity.runAsSystem`. */
export interface SessionIssuer {
  /** Creates a session (and registers the person's actor) and returns the token to hand back via `HttpResponse.setSession`. */
  issue(tx: PluginTx, input: { workspaceId: string; personId: string; device?: string | null }): Promise<IssuedSession>;
  /** The person's live sessions, newest first. */
  list(tx: PluginTx, personId: string, currentSessionId?: string | null): Promise<SessionRecord[]>;
  /** Ends one session, only if it belongs to `personId`. False when it does not exist, is theirs no more or already ended. */
  revoke(tx: PluginTx, input: { sessionId: string; personId: string }): Promise<boolean>;
  /** Ends every live session of the person (except one) and returns how many ended. */
  revokeAll(tx: PluginTx, input: { personId: string; exceptSessionId?: string | null }): Promise<number>;
}

/**
 * What a sign-in plugin (`extends: ['provider.identity']`) may do beyond an ordinary plugin: work as the system actor
 * (sign-in runs before anyone is known), create and end sessions, hash passwords, and run a task at server start.
 * Everything here is trusted-code territory: read docs/plugins/security.md.
 */
export interface IdentityServices {
  /** Runs `fn` in one transaction as the system actor (no RLS), scoped to `workspaceId` when given. */
  runAsSystem<T>(fn: (tx: PluginTx) => Promise<T>, options?: { workspaceId?: string }): Promise<T>;
  /** Get-or-create the `actors` row of a person; returns its id. */
  ensureActor(tx: PluginTx, input: { workspaceId: string; personId: string }): Promise<string>;
  hashPassword(password: string): Promise<string>;
  /** False for a wrong password or a malformed hash; never throws. */
  verifyPassword(hash: string, password: string): Promise<boolean>;
  sessions: SessionIssuer;
  /** Runs once after the server's plugins are loaded and its migrations applied, as the system actor. */
  onStart(task: (tx: PluginTx, log: PluginLogger) => Promise<void>): void;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** A mail built from a template; the kernel renders plain text and simple HTML. */
export type MailTemplateMessage =
  | { template: 'verify'; to: string; name: string; url: string }
  | { template: 'reset'; to: string; name: string; url: string }
  | { template: 'invite'; to: string; inviterName: string; workspaceName: string; teamName: string | null; url: string };

export interface MailService {
  /** Sends one templated mail. Rejects when delivery fails; callers that must not leak that should catch it. */
  send(message: MailTemplateMessage): Promise<void>;
}

/** Facts about the running server a plugin may need. */
export interface PluginRuntime {
  /** Public base URL without a trailing slash (`MANYTHREADS_PUBLIC_URL`), used to build links in mails and logs. */
  publicUrl: string;
  /** The server's clock (injectable in tests); use it instead of `new Date()` for expiry logic. */
  now(): Date;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  register(ctx: PluginContext): void | Promise<void>;
}

export type { ExtensionPoint, PluginManifest };

/**
 * Envelope-encrypted secrets, workspace-owned. A secret is written by a workspace admin's transaction or the system
 * actor and read back only by the system actor (`identity.runAsSystem`); no API route may return one.
 */
export interface SecretService {
  /** Stores `plaintext` and returns the secret id (admin or system transaction; the database refuses anyone else). */
  put(tx: PluginTx, plaintext: string): Promise<string>;
  /** Decrypts a secret. Throws unless `tx` is a system transaction. */
  get(tx: PluginTx, secretId: string): Promise<string>;
  /** Deletes a secret of the caller's workspace. False when it did not exist. */
  delete(tx: PluginTx, secretId: string): Promise<boolean>;
}

/** Result of `BlobStorage.put`: what the `files` table records about the stored bytes. */
export interface BlobPutResult {
  /** Opaque key the provider chose; hand it back to `get`/`head`/`delete`. */
  blobKey: string;
  size: number;
  /** Lower-case hex SHA-256 of the stored bytes. */
  sha256: string;
}

export interface BlobHead {
  size: number;
}

/** Thrown by `put` when the stream is longer than `maxBytes`; nothing is stored. */
export class BlobTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Blob is larger than the ${maxBytes} byte limit`);
    this.name = 'BlobTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** Thrown for a key this provider could never have issued (never touches storage). */
export class InvalidBlobKeyError extends Error {
  constructor() {
    super('Invalid blob key');
    this.name = 'InvalidBlobKeyError';
  }
}

/** Thrown by `get` when the key is well formed but nothing is stored under it. */
export class BlobNotFoundError extends Error {
  constructor() {
    super('Blob not found');
    this.name = 'BlobNotFoundError';
  }
}

/**
 * The `provider.storage` contract (spec §5.2): attachment bytes only. Who may read a blob is decided by the caller from
 * the `files` row and the channel ACL before it calls `get` (principle 8); a provider never sees identities.
 * Streams are `AsyncIterable<Uint8Array>` (a Node `Readable` is one), so the SDK stays free of `node:` types.
 */
export interface BlobStorage extends ProviderImpl {
  /**
   * Stores the stream and returns where it went. Rejects with `BlobTooLargeError` as soon as more than `maxBytes` have
   * arrived (the source is destroyed when it supports it, partial data is removed). Any other failure also leaves nothing behind.
   */
  put(stream: AsyncIterable<Uint8Array>, options: { maxBytes: number }): Promise<BlobPutResult>;
  /** The bytes as a stream. Rejects with `BlobNotFoundError` when nothing is stored. */
  get(blobKey: string): Promise<AsyncIterable<Uint8Array>>;
  /** True when something was removed. */
  delete(blobKey: string): Promise<boolean>;
  /** Size of the stored bytes, or null when nothing is stored. */
  head(blobKey: string): Promise<BlobHead | null>;
}
