import type { ExtensionPoint, PluginManifest } from '@majlis/shared';

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

export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}
export interface HttpResponse {
  status?: number;
  body?: unknown;
}
export interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the plugin's mount point (`/plugins/<name>`), starts with `/`. */
  path: string;
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
  /** Routes the server mounts under `/plugins/<name>`. */
  readonly http: { route(definition: HttpRouteDefinition): void };
  readonly storage: ScopedKv;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  register(ctx: PluginContext): void | Promise<void>;
}

export type { ExtensionPoint, PluginManifest };
