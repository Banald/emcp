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

  // BullMQ worker metrics
  bullmqJobsTotal: new Counter({
    name: 'bullmq_jobs_total',
    help: 'BullMQ job lifecycle counters',
    labelNames: ['queue', 'status'] as const,
    registers: [register],
  }),
  bullmqJobDuration: new Histogram({
    name: 'bullmq_job_duration_seconds',
    help: 'BullMQ job processing duration',
    labelNames: ['queue'] as const,
    buckets: [0.01, 0.1, 0.5, 1, 5, 30, 60, 300],
    registers: [register],
  }),
  bullmqQueueDepth: new Gauge({
    name: 'bullmq_queue_depth',
    help: 'Jobs in queue by state',
    labelNames: ['queue', 'state'] as const,
    registers: [register],
  }),
};
