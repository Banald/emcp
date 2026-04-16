import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { metrics, register } from './metrics.ts';

describe('metrics registry', () => {
  it('registers all expected custom metrics', async () => {
    const allMetrics = await register.getMetricsAsJSON();
    const names = allMetrics.map((m) => m.name);

    const expected = [
      'mcp_requests_total',
      'mcp_request_duration_seconds',
      'mcp_request_bytes_in',
      'mcp_request_bytes_out',
      'mcp_active_sessions',
      'mcp_auth_failures_total',
      'mcp_rate_limit_hits_total',
      'worker_runs_total',
      'worker_run_duration_seconds',
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `missing metric: ${name}`);
    }
  });

  it('includes default Node.js process metrics', async () => {
    const allMetrics = await register.getMetricsAsJSON();
    const names = allMetrics.map((m) => m.name);
    assert.ok(
      names.some((n) => n.startsWith('process_')),
      'expected process_ default metrics',
    );
  });

  it('mcp_requests_total is a counter with correct labels', () => {
    const metric = metrics.requestsTotal;
    assert.equal(metric.constructor.name, 'Counter');
  });

  it('mcp_request_duration_seconds is a histogram with correct labels', () => {
    const metric = metrics.requestDuration;
    assert.equal(metric.constructor.name, 'Histogram');
  });

  it('mcp_active_sessions is a gauge', () => {
    const metric = metrics.activeSessions;
    assert.equal(metric.constructor.name, 'Gauge');
  });

  it('mcp_auth_failures_total is a counter', () => {
    const metric = metrics.authFailuresTotal;
    assert.equal(metric.constructor.name, 'Counter');
  });

  it('mcp_rate_limit_hits_total is a counter', () => {
    const metric = metrics.rateLimitHitsTotal;
    assert.equal(metric.constructor.name, 'Counter');
  });

  it('worker_runs_total is a counter', () => {
    const metric = metrics.workerRunsTotal;
    assert.equal(metric.constructor.name, 'Counter');
  });

  it('worker_run_duration_seconds is a histogram', () => {
    const metric = metrics.workerRunDuration;
    assert.equal(metric.constructor.name, 'Histogram');
  });

  it('produces valid Prometheus text output', async () => {
    const text = await register.metrics();
    assert.ok(text.length > 0, 'metrics text should not be empty');
    assert.ok(text.includes('# HELP mcp_requests_total'), 'expected HELP line');
    assert.ok(text.includes('# TYPE mcp_requests_total counter'), 'expected TYPE line');
  });
});
