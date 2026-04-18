import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { pino } from 'pino';
import {
  AUDIT_REDACT_PATHS,
  auditAuthFail,
  auditLogger,
  auditRateLimitHit,
  auditToolCall,
} from './audit.ts';

describe('auditLogger', () => {
  let infoMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    infoMock = mock.method(auditLogger, 'info', () => {});
  });

  afterEach(() => {
    infoMock.mock.restore();
  });

  function lastCall(): { payload: Record<string, unknown>; message: string } {
    const call = infoMock.mock.calls.at(-1);
    assert.ok(call, 'expected audit logger to be called');
    return {
      payload: call.arguments[0] as Record<string, unknown>,
      message: call.arguments[1] as string,
    };
  }

  it('auditToolCall emits the documented shape', () => {
    auditToolCall({
      keyId: 'key-123',
      keyPrefix: 'mcp_live_abc',
      tool: 'web-search',
      outcome: 'success',
      durationMs: 42,
      bytesIn: 100,
      bytesOut: 250,
    });
    const { payload, message } = lastCall();
    assert.equal(payload.event, 'tool.call');
    assert.equal(payload.key_id, 'key-123');
    assert.equal(payload.key_prefix, 'mcp_live_abc');
    assert.equal(payload.tool, 'web-search');
    assert.equal(payload.outcome, 'success');
    assert.equal(payload.duration_ms, 42);
    assert.equal(payload.bytes_in, 100);
    assert.equal(payload.bytes_out, 250);
    assert.equal(message, 'tool call');
  });

  it('auditToolCall supports error outcomes with a category suffix', () => {
    auditToolCall({
      keyId: 'key-1',
      keyPrefix: 'mcp_live_x',
      tool: 'fetch-url',
      outcome: 'error:transient',
      durationMs: 7,
      bytesIn: 30,
      bytesOut: 0,
    });
    assert.equal(lastCall().payload.outcome, 'error:transient');
  });

  it('auditAuthFail omits key_prefix when not provided', () => {
    auditAuthFail({ reason: 'missing', jsonRpcCode: -32001 });
    const { payload, message } = lastCall();
    assert.equal(payload.event, 'auth.fail');
    assert.equal(payload.reason, 'missing');
    assert.equal(payload.json_rpc_code, -32001);
    assert.equal(payload.key_prefix, undefined);
    assert.equal(message, 'auth fail');
  });

  it('auditAuthFail includes key_prefix when provided', () => {
    auditAuthFail({
      reason: 'blacklisted',
      jsonRpcCode: -32004,
      keyPrefix: 'mcp_live_bad',
    });
    const { payload } = lastCall();
    assert.equal(payload.key_prefix, 'mcp_live_bad');
    assert.equal(payload.reason, 'blacklisted');
  });

  it('auditRateLimitHit emits per_key scope without a tool field', () => {
    auditRateLimitHit({ keyId: 'k', keyPrefix: 'p', scope: 'per_key' });
    const { payload, message } = lastCall();
    assert.equal(payload.event, 'rate_limit.hit');
    assert.equal(payload.scope, 'per_key');
    assert.equal(payload.tool, undefined);
    assert.equal(message, 'rate limit hit');
  });

  it('auditRateLimitHit includes the tool name when scope is per_tool', () => {
    auditRateLimitHit({
      keyId: 'k',
      keyPrefix: 'p',
      scope: 'per_tool',
      tool: 'fetch-url',
    });
    assert.equal(lastCall().payload.tool, 'fetch-url');
  });
});

describe('audit redaction (AUDIT L-2)', () => {
  // Build a standalone pino logger configured with the exported redact
  // set and capture its serialized output, so we're asserting on the
  // real Pino redaction rather than a mocked info method.
  function captureEmit(context: Record<string, unknown>): string {
    const chunks: string[] = [];
    const logger = pino(
      {
        level: 'info',
        redact: {
          paths: [...AUDIT_REDACT_PATHS],
          censor: '[REDACTED]',
        },
      },
      { write: (chunk: string) => chunks.push(chunk) },
    );
    logger.info(context, 'audit test');
    return chunks.join('');
  }

  it('redacts operational paths (authorization, cookie, x-api-key, password, secret, token)', () => {
    const out = captureEmit({
      req: {
        headers: {
          authorization: 'Bearer leak',
          cookie: 'session=leak',
          'x-api-key': 'leak',
        },
      },
      nested: {
        apiKey: 'leak',
        password: 'leak',
        secret: 'leak',
        token: 'leak',
        hmacSecret: 'leak',
      },
    });
    assert.ok(!/Bearer leak/.test(out), 'authorization must be redacted');
    assert.ok(!/session=leak/.test(out), 'cookie must be redacted');
    // Every mention of the literal "leak" should be gone from the payload.
    assert.equal(out.match(/leak/g), null);
    assert.ok(/\[REDACTED]/.test(out));
  });

  it('redacts audit-specific wildcard fields (api_key, raw_key, bearer, authorization)', () => {
    const out = captureEmit({
      ctx: {
        api_key: 'mcp_live_should_never_appear',
        raw_key: 'raw_should_never_appear',
        bearer: 'bearer_should_never_appear',
        authorization: 'Bearer should_never_appear',
      },
    });
    assert.ok(
      !/mcp_live_should_never_appear|raw_should_never_appear|bearer_should_never_appear|should_never_appear/.test(
        out,
      ),
      'audit-only paths must be redacted',
    );
    assert.ok(/\[REDACTED]/.test(out));
  });

  it('preserves non-sensitive audit fields verbatim', () => {
    const out = captureEmit({ event: 'tool.call', tool: 'web-search', outcome: 'success' });
    assert.match(out, /"event":"tool.call"/);
    assert.match(out, /"tool":"web-search"/);
    assert.match(out, /"outcome":"success"/);
  });
});
