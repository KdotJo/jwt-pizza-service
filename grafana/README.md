# Grafana dashboard

Export the dashboard JSON (Dashboard → Share/Export → Export → Save to file) to
`grafana/deliverable8dashboard.json`. That file is not created yet.

Metrics come from `src/metrics.js`, pushed as OTLP to Grafana Cloud every 10s.
Filter on `source="jwt-pizza-service"` (prod) or `source="jwt-pizza-service-dev"` (local).

## Check the real metric names

Prometheus renames OTLP metrics (counters get `_total`, units add a suffix). Confirm before building panels:

1. Grafana → **Explore** → pick the `grafanacloud-<stack>-prom` data source.
2. Switch the query editor to **Code**, type `{source="jwt-pizza-service"}` and run it, or open
   **Metrics browser** and filter by the `source` label.
3. Use the names shown there in the queries below if they differ.

## Panels

Expected names; adjust to what Explore shows.

| Panel | Type | PromQL |
| --- | --- | --- |
| HTTP requests/min by method | Time series | `sum by (method) (rate(http_requests_total{source="$source"}[1m])) * 60` |
| HTTP requests/min total | Time series / Stat | `sum(rate(http_requests_total{source="$source"}[1m])) * 60` |
| Active users | Stat / Time series | `max(active_users{source="$source"})` |
| Auth attempts/min | Time series | `sum by (status) (rate(auth_attempts_total{source="$source"}[1m])) * 60` |
| CPU % | Gauge / Time series | `avg(cpu_usage_percent{source="$source"})` |
| Memory % | Gauge / Time series | `avg(memory_usage_percent{source="$source"})` |
| Pizzas sold/min | Time series | `sum(rate(pizza_sold_total{source="$source"}[1m])) * 60` |
| Pizza creation failures/min | Time series | `sum(rate(pizza_failures_total{source="$source"}[1m])) * 60` |
| Revenue/min | Time series | `sum(rate(pizza_revenue_total{source="$source"}[1m])) * 60` |
| Service latency (ms) | Time series | `avg(service_latency_milliseconds{source="$source"})` |
| Pizza creation latency (ms) | Time series | `avg(pizza_creation_latency_milliseconds{source="$source"})` |

`$source` is a dashboard variable (Custom: `jwt-pizza-service,jwt-pizza-service-dev`); or hard-code the value.
