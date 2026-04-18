import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const metrics = {
  // MCP request metrics
  requestsTotal: new Counter({
    name: 'mcp_requests_total',
    help: 'Total MCP tool calls',
    labelNames: ['tool', 'status'] as const,
    registers: [register],
  }),
  requestDuration: new Histogram({
    name: 'mcp_request_duration_seconds',
    help: 'MCP request duration in seconds',
    labelNames: ['tool'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
  }),
  requestBytesIn: new Histogram({
    name: 'mcp_request_bytes_in',
    help: 'MCP request body size in bytes',
    labelNames: ['tool'] as const,
    buckets: [128, 1024, 8192, 65536, 524288, 1048576],
    registers: [register],
  }),
  requestBytesOut: new Histogram({
    name: 'mcp_request_bytes_out',
    help: 'MCP response body size in bytes',
    labelNames: ['tool'] as const,
    buckets: [128, 1024, 8192, 65536, 524288, 1048576],
    registers: [register],
  }),
  activeSessions: new Gauge({
    name: 'mcp_active_sessions',
    help: 'Currently open Streamable HTTP sessions',
    registers: [register],
  }),

  // Auth and rate limiting
  authFailuresTotal: new Counter({
    name: 'mcp_auth_failures_total',
    help: 'Authentication failures by reason',
    labelNames: ['reason'] as const,
    registers: [register],
  }),
  rateLimitHitsTotal: new Counter({
    name: 'mcp_rate_limit_hits_total',
    help: 'Rate limit triggers',
    labelNames: ['scope'] as const,
    registers: [register],
  }),

  // Background worker metrics
  workerRunsTotal: new Counter({
    name: 'worker_runs_total',
    help: 'Worker run lifecycle counters',
    labelNames: ['worker', 'status'] as const,
    registers: [register],
  }),
  workerRunDuration: new Histogram({
    name: 'worker_run_duration_seconds',
    help: 'Worker run duration in seconds',
    labelNames: ['worker'] as const,
    buckets: [0.01, 0.1, 0.5, 1, 5, 30, 60, 300, 900, 3600],
    registers: [register],
  }),

  // Outbound proxy egress metrics (docs/ARCHITECTURE.md "Proxy egress").
  // `proxy_id` labels use the pool-index form ("p0", "p1", ...) that the
  // pool itself emits; the proxy URL is NEVER a label because it may
  // carry credentials and would explode cardinality.
  proxyRequestsTotal: new Counter({
    name: 'proxy_requests_total',
    help: 'Outbound egress attempts per proxy, labelled by outcome',
    labelNames: ['proxy_id', 'status'] as const,
    registers: [register],
  }),
  proxyRequestDuration: new Histogram({
    name: 'proxy_request_duration_seconds',
    help: 'End-to-end duration of proxied fetchExternal() calls',
    labelNames: ['proxy_id'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
  }),
  proxyCooldownsTotal: new Counter({
    name: 'proxy_cooldowns_total',
    help: 'Number of times a proxy entered cooldown due to consecutive failures',
    labelNames: ['proxy_id'] as const,
    registers: [register],
  }),
  proxyPoolHealthy: new Gauge({
    name: 'proxy_pool_healthy',
    help: 'Number of proxies currently eligible for rotation (not cooled down)',
    registers: [register],
  }),
};
