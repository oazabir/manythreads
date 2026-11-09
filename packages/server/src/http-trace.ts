import { traceRequest, tracingOn, type RequestSpan } from '@manythreads/sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UNTRACED_ROUTES } from './otel.ts';

// The HTTP side of tracing: one span per request, opened in the FIRST `onRequest` hook so every later hook, the handler and the database transactions it opens are its
// children, and ended when the response is sent. Imports no telemetry package (the span comes from the bridge the sdk holds), so this file is safe to load with tracing off.
//
// The span name is `METHOD /route` with the route pattern (`/api/channels/:id/messages`), never the raw address: a raw address can hold a token or a name.
// The request's log lines (all but the first, "incoming request") carry `traceId`, so a slow request in the log finds its trace and a trace finds its log lines.

const spans = new WeakMap<FastifyRequest, RequestSpan>();

/** Adds the hooks. A no-op unless tracing is on (the bridge exists), so a server with no collector gets no extra hook. Call it before any other hook is added. */
export function registerHttpTracing(app: FastifyInstance): void {
  if (!tracingOn()) return;
  app.addHook('onRequest', (req, reply, done) => {
    const route = req.routeOptions.url;
    // Not traced: probes and scrapes, unmatched paths (a scanner would fill the collector), and WebSocket upgrades (one span for a day-long socket says nothing).
    if (route === undefined || UNTRACED_ROUTES.has(route) || req.headers['upgrade'] !== undefined) {
      done();
      return;
    }
    traceRequest(`${req.method} ${route}`, { 'http.request.method': req.method, 'http.route': route }, (span) => {
      if (span !== null) {
        spans.set(req, span);
        // The request's logger and the reply's (it writes the "request completed" line) both carry the trace id. The "incoming request" line is written before any hook runs and cannot.
        req.log = req.log.child({ traceId: span.traceId });
        reply.log = req.log;
      }
      done();
    });
  });
  app.addHook('onResponse', (req, reply, done) => {
    const span = spans.get(req);
    if (span !== undefined) {
      spans.delete(req);
      span.end(
        { 'http.response.status_code': reply.statusCode, 'mt.actor_id': req.actor?.id, 'mt.workspace_id': req.actor?.workspaceId },
        reply.statusCode >= 500,
      );
    }
    done();
  });
  // A client that hangs up before the answer: end the span so the trace shows where the work stopped.
  app.addHook('onRequestAbort', (req, done) => {
    const span = spans.get(req);
    if (span !== undefined) {
      spans.delete(req);
      span.end({}, false);
    }
    done();
  });
}
