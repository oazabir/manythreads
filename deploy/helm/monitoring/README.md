# Monitoring files

Ready-made files for the monitoring side of a manythreads install (PLAN P10-09, P10-10). The page that explains them is [docs/deploy/monitoring.md](../../../docs/deploy/monitoring.md). Nothing here is installed by the Helm chart: take what you use.

| File | What it is |
|---|---|
| `prometheus-rules.yaml` | Alert rules in Prometheus' rule-file form. The limits equal the built-in watcher's defaults, so the two agree. |
| `grafana/manythreads-overview.json` | A Grafana dashboard: up, outbox and job lag, run slots, database connections and replica lag, memory, volumes, model budgets. |
| `otel-collector.yaml` | An example OpenTelemetry Collector configuration that receives the server's traces. |

## Prometheus rules

Check the file, with `promtool` from the Prometheus image (no install needed):

```sh
docker run --rm --entrypoint promtool -v "$PWD/deploy/helm/monitoring:/m:ro" prom/prometheus:v3.5.0 check rules /m/prometheus-rules.yaml
```

Load it with `rule_files:` in `prometheus.yml`. With the Prometheus Operator, put the `groups:` list under `spec:` of a `PrometheusRule` object. The rules read the scrape job named `manythreads` (the one in monitoring.md); if yours has another name, change `job="manythreads"` in the first rule.

`ManythreadsReplicaLag` has no series, and so never fires, on an install with one database: the metric exists only while a standby is connected.

## Grafana dashboard

In Grafana: Dashboards, New, Import, upload `grafana/manythreads-overview.json`, and choose your Prometheus data source. Its uid is `manythreads-overview`, so importing it again replaces it. Every panel reads the `manythreads_*` metrics of the scrape job `manythreads`.

## OpenTelemetry traces

Off until you give the server an address. In your values file:

```yaml
server:
  otel:
    endpoint: http://otel-collector.monitoring.svc:4318   # OTLP over HTTP; the server adds /v1/traces
    sampleRatio: 1                                        # 0 to 1: the share of requests kept
```

Run a collector with `otel-collector.yaml` as its configuration and point its exporter at your tracing backend. What the spans hold, and what they never hold, is in monitoring.md.
