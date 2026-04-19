import { type Logger as PinoLogger, pino } from 'pino';
import { config } from '../config.ts';
import { REDACT_PATHS } from './logger.ts';

/**
 * Audit stream. Separate from the operational logger so retention,
 * destination, and redaction can be tuned independently. Every record
 * carries `{ stream: 'audit' }` so operators running under compose or
 * PM2 can tee it via their log forwarder of choice without eMCP needing
 * a file path or external sink baked in.
 *
 * All emit helpers are explicitly typed to enforce an allowlist of
 * fields — a future tool handler cannot leak stray data into this
 * stream because the public surface only accepts the documented shape.
 *
 * Redact config is a superset of the operational logger's (SECURITY
 * Rule 12 / AUDIT L-2): the CLI's `audit(logger, event, msg, context)`
 * accepts an untyped bag of fields, so a future caller could drop a
 * raw bearer in by accident. Redact paths here include the operational
 * set plus audit-specific credential-ish keys (`api_key`, `raw_key`,
 * `bearer`, `authorization`) so a slip never produces a cleartext
 * record.
 */

// Audit-only paths on top of the operational ones. Kept narrow — any
// wildcard here has to fire on every audit record.
const AUDIT_EXTRA_REDACT_PATHS: readonly string[] = Object.freeze([
  '*.api_key',
  '*.raw_key',
  '*.bearer',
  '*.authorization',
]);

export const AUDIT_REDACT_PATHS: readonly string[] = Object.freeze([
  ...REDACT_PATHS,
  ...AUDIT_EXTRA_REDACT_PATHS,
]);

function buildAuditLogger(): PinoLogger {
  return pino({
    name: 'audit',
    // Audit lines are always emitted at info when the operational logger
    // is active; a `silent` operational level silences audit too so test
    // runs stay quiet.
    level: config.logLevel === 'silent' ? 'silent' : 'info',
    base: { stream: 'audit' },
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [...AUDIT_REDACT_PATHS],
      censor: '[REDACTED]',
    },
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
