// The seam between the code that does work (the database entry, the model gateway call, the Hermes call, the job runner) and OpenTelemetry (docs/deploy/monitoring.md).
//
// This file imports no telemetry package. The server registers a bridge at start-up ONLY when `MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT` is set; until then every function
// here does nothing and costs one property read, so an install without a collector loads none of the telemetry code (a test pins that).
//
// What may travel: span names fixed in code, and attributes that are ids, counts, kinds and status codes. Never message text, file names, a person's name, an address, a query or a
// secret. The bridge enforces it with an allow-list of attribute names (`packages/server/src/otel.ts`); an attribute outside the list is dropped, so a mistake here cannot leak.

/** Values a span may carry. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/** The end of a request span: the caller says how it finished. */
export interface RequestSpan {
  /** The trace the request belongs to; its log lines carry it as `traceId`. */
  readonly traceId: string;
  end(attributes: SpanAttributes, failed: boolean): void;
}

export interface TraceBridge {
  /** A child of the span that is active now; with none active, just runs `fn` (a background poll must not start a trace of its own). */
  span<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T>;
  /** A new trace (a job run). Subject to the sample ratio. */
  root<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T>;
  /** Opens the span of one HTTP request and calls `next` inside it, so everything the request does becomes its children. */
  request(name: string, attributes: SpanAttributes, next: (span: RequestSpan) => void): void;
  /** `traceparent` of the active span, to send to a service of ours; empty when no span is active. */
  headers(): Record<string, string>;
  /** Trace id of the active span, when there is one. */
  traceId(): string | undefined;
}

// One bridge per process, kept on `globalThis` so two copies of this module (a test that loads the sdk through two paths) still agree.
const KEY = Symbol.for('manythreads.trace.bridge');
type Holder = { [KEY]?: TraceBridge | null };

const bridge = (): TraceBridge | null => (globalThis as Holder)[KEY] ?? null;

/** Called once by the server when an OTLP endpoint is configured (and by tests). `null` turns tracing off again. */
export function setTraceBridge(next: TraceBridge | null): void {
  (globalThis as Holder)[KEY] = next;
}

/** True when a bridge is registered. */
export const tracingOn = (): boolean => bridge() !== null;

/** Runs `fn` in a child span of the active one. With no bridge it is exactly `fn()`. */
export function traceSpan<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
  const b = bridge();
  return b === null ? fn() : b.span(name, attributes, fn);
}

/** Runs `fn` in a span of a new trace (a job run). With no bridge it is exactly `fn()`. */
export function traceRoot<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
  const b = bridge();
  return b === null ? fn() : b.root(name, attributes, fn);
}

/** The request span for the HTTP hooks: `next` runs inside it and gets the span; with no bridge `next` gets null and runs as it is. */
export function traceRequest(name: string, attributes: SpanAttributes, next: (span: RequestSpan | null) => void): void {
  const b = bridge();
  if (b === null) next(null);
  else b.request(name, attributes, next);
}

/**
 * Headers for a call to a service of OURS (the model gateway, a managed Hermes pod, the agent bridge). Never spread them into a call to an address a customer typed or to a
 * third party: the trace id would leave the install. Empty with no bridge.
 */
export function traceHeaders(): Record<string, string> {
  const b = bridge();
  return b === null ? {} : b.headers();
}

/** The active trace id, for a log line. */
export function currentTraceId(): string | undefined {
  return bridge()?.traceId();
}
