import { hostname } from 'node:os';
import { setTraceBridge, type RequestSpan, type SpanAttributes, type TraceBridge } from '@manythreads/sdk';

// OpenTelemetry traces for the server (PLAN P10-10, docs/deploy/monitoring.md#traces).
//
// OFF unless `MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT` is set. While it is unset nothing in this file runs and no telemetry package is loaded: the packages are fetched with
// `import()` inside `startOtel`, so a start with no collector pays nothing, in time or in memory (a test checks the module list).
//
// What is traced: each HTTP request (span name `METHOD /route`), each actor transaction under it (`db.transaction`, from the kernel's database entry), each job run, each model
// gateway call and each Hermes gateway call. Calls to our own services carry `traceparent`. Spans hold ids, kinds and status codes only. Never message text, a person's name, an
// address, SQL or a secret; the allow-list below drops anything else, and an error is recorded by its type, never its message.

/** The attribute names a span may carry. Anything else is dropped before it reaches the exporter. */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'mt.actor_id',
  'mt.workspace_id',
  'mt.run_id',
  'mt.bot_id',
  'mt.job.queue',
  'mt.job.id',
  'mt.job.attempt',
  'mt.db.actor_kind',
  'mt.db.read_only',
  'mt.llm.alias',
  'mt.llm.purpose',
  'mt.llm.prompt_tokens',
  'mt.llm.completion_tokens',
  'mt.llm.messages',
  'mt.hermes.agent',
  'mt.hermes.profile',
  'error.type',
]);

/** A value a span may carry: a boolean, a finite number, or a short id-like string (no spaces, no quotes). Anything else is dropped. */
const SAFE_STRING = /^[A-Za-z0-9._:@/-]{1,64}$/;

/** The attributes of a span after the allow-list. Exported for the test that proves nothing else gets through. */
export function cleanAttributes(attributes: SpanAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(key) || value === undefined) continue;
    if (typeof value === 'string' ? SAFE_STRING.test(value) : typeof value === 'boolean' || Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export interface OtelConfig {
  /** Where the collector listens for OTLP over HTTP, e.g. `http://otel-collector:4318`. */
  endpoint: string;
  /** Share of traces kept, 0 to 1. */
  sampleRatio: number;
}

/**
 * `MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT` (unset or empty: tracing off) and `MANYTHREADS_OTEL_SAMPLE_RATIO` (0 to 1, default 1). A bad value does not stop the server: it is
 * reported in `problem` and tracing stays off, so a typo in an optional feature cannot take the site down.
 */
export function otelConfigFromEnv(env: Readonly<Record<string, string | undefined>>): { config: OtelConfig | null; problem?: string } {
  const raw = (env['MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '').trim();
  if (raw === '') return { config: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { config: null, problem: 'MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT is not a web address; tracing stays off' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { config: null, problem: 'MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT must start with http:// or https://; tracing stays off' };
  }
  const ratioRaw = (env['MANYTHREADS_OTEL_SAMPLE_RATIO'] ?? '').trim();
  let sampleRatio = 1;
  if (ratioRaw !== '') {
    const n = Number(ratioRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) return { config: null, problem: 'MANYTHREADS_OTEL_SAMPLE_RATIO must be a number from 0 to 1; tracing stays off' };
    sampleRatio = n;
  }
  return { config: { endpoint: raw, sampleRatio } };
}

/** The address spans are posted to: the endpoint with `/v1/traces` (the OTLP path) unless it already ends with it. */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

export interface OtelHandle {
  /** Sends what is buffered and stops. */
  shutdown(): Promise<void>;
}

export interface StartOtelOptions {
  /** Test seam: a span exporter instead of the OTLP one (an in-memory one). */
  exporter?: unknown;
  /** Test seam: spans are ended and exported at once instead of in batches. */
  simple?: boolean;
}

/** Routes whose requests are never traced: probes and scrapes would be most of the traffic and none of the interest. */
export const UNTRACED_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Loads the telemetry packages, registers the tracer and hands the bridge to the code that makes spans. Returns null when `config` is null (nothing is loaded then).
 */
export async function startOtel(config: OtelConfig | null, options: StartOtelOptions = {}): Promise<OtelHandle | null> {
  if (config === null) return null;
  const [api, node, resources] = await Promise.all([import('@opentelemetry/api'), import('@opentelemetry/sdk-trace-node'), import('@opentelemetry/resources')]);
  const { context, propagation, trace, SpanKind, SpanStatusCode } = api;

  const exporter: import('@opentelemetry/sdk-trace-node').SpanExporter =
    (options.exporter as import('@opentelemetry/sdk-trace-node').SpanExporter | undefined) ??
    new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter({ url: tracesUrl(config.endpoint) });
  const provider = new node.NodeTracerProvider({
    resource: resources.resourceFromAttributes({ 'service.name': 'manythreads-server', 'service.instance.id': hostname() }),
    sampler: new node.ParentBasedSampler({ root: new node.TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanProcessors: [options.simple === true ? new node.SimpleSpanProcessor(exporter) : new node.BatchSpanProcessor(exporter)],
  });
  // Makes the async-local context manager and the W3C propagator global: what lets a child span find its parent across awaits.
  provider.register();
  const tracer = trace.getTracer('manythreads-server');

  const finish = (span: import('@opentelemetry/api').Span, failed: unknown): void => {
    if (failed instanceof Error) {
      // The type only: an error message can hold a query value or a person's text.
      span.setAttribute('error.type', failed.name);
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else if (failed === true) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };

  const run = async <T>(span: import('@opentelemetry/api').Span, fn: () => Promise<T>): Promise<T> => {
    try {
      const value = await context.with(trace.setSpan(context.active(), span), fn);
      finish(span, false);
      return value;
    } catch (err) {
      finish(span, err instanceof Error ? err : true);
      throw err;
    }
  };

  const bridge: TraceBridge = {
    span(name, attributes, fn) {
      // Only under a trace: a poll that runs every half second must not start one of its own.
      if (trace.getSpan(context.active()) === undefined) return fn();
      return run(tracer.startSpan(name, { attributes: cleanAttributes(attributes) }), fn);
    },
    root(name, attributes, fn) {
      return run(tracer.startSpan(name, { attributes: cleanAttributes(attributes), root: true }), fn);
    },
    request(name, attributes, next) {
      const span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes: cleanAttributes(attributes), root: true });
      let ended = false;
      const handle: RequestSpan = {
        traceId: span.spanContext().traceId,
        end(final, failed) {
          if (ended) return;
          ended = true;
          span.setAttributes(cleanAttributes(final));
          finish(span, failed);
        },
      };
      context.with(trace.setSpan(context.active(), span), () => next(handle));
    },
    headers() {
      const span = trace.getSpan(context.active());
      if (span === undefined) return {};
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      // Only the trace parent: baggage and the rest stay in this process.
      const parent = carrier['traceparent'];
      const out: Record<string, string> = {};
      if (parent !== undefined) out['traceparent'] = parent;
      return out;
    },
    traceId() {
      return trace.getSpan(context.active())?.spanContext().traceId;
    },
  };
  setTraceBridge(bridge);

  return {
    async shutdown() {
      setTraceBridge(null);
      await provider.shutdown();
      // Lets a later start (a test, a second server in one process) register its own provider: the API refuses a second registration while the first is in place.
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
