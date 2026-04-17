import { type Logger as PinoLogger, pino } from 'pino';
import { config } from '../config.ts';

/**
 * Audit stream. Separate from the operational logger so retention,
 * destination, and redaction can be tuned independently. Every record
 * carries `{ stream: 'audit' }` so operators running under compose or
 * PM2 can tee it via their log forwarder of choice without Echo needing
 * a file path or external sink baked in.
 *
 * All emit helpers are explicitly typed to enforce an allowlist of
 * fields — a future tool handler cannot leak stray data into this
 * stream because the public surface only accepts the documented shape.
 */

function buildAuditLogger(): PinoLogger {
  return pino({
    name: 'audit',
    // Audit lines are always emitted at info when the operational logger
    // is active; a `silent` operational level silences audit too so test
    // runs stay quiet.
    level: config.logLevel === 'silent' ? 'silent' : 'info',
    base: { stream: 'audit' },
    formatters: { level: (label) => ({ level: label }) },
  });
}

export const auditLogger: PinoLogger = buildAuditLogger();

export interface ToolCallAudit {
  keyId: string;
  keyPrefix: string;
  tool: string;
  /** 'success' or a coarse error category ('error:rate_limit', 'error:transient', ...). */
  outcome: string;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
}

export function auditToolCall(r: ToolCallAudit): void {
  auditLogger.info(
    {
      event: 'tool.call',
      key_id: r.keyId,
      key_prefix: r.keyPrefix,
      tool: r.tool,
      outcome: r.outcome,
      duration_ms: r.durationMs,
      bytes_in: r.bytesIn,
      bytes_out: r.bytesOut,
    },
    'tool call',
  );
}

export interface AuthFailAudit {
  reason: 'missing' | 'malformed' | 'unknown' | 'blacklisted' | 'deleted';
  jsonRpcCode: number;
  keyPrefix?: string;
}

export function auditAuthFail(r: AuthFailAudit): void {
  auditLogger.info(
    {
      event: 'auth.fail',
      reason: r.reason,
      json_rpc_code: r.jsonRpcCode,
      ...(r.keyPrefix !== undefined ? { key_prefix: r.keyPrefix } : {}),
    },
    'auth fail',
  );
}

export interface RateLimitHitAudit {
  keyId: string;
  keyPrefix: string;
  scope: 'per_key' | 'per_tool';
  tool?: string;
}

export function auditRateLimitHit(r: RateLimitHitAudit): void {
  auditLogger.info(
    {
      event: 'rate_limit.hit',
      key_id: r.keyId,
      key_prefix: r.keyPrefix,
      scope: r.scope,
      ...(r.tool !== undefined ? { tool: r.tool } : {}),
    },
    'rate limit hit',
  );
}
