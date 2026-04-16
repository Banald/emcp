import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { z } from 'zod';
import tool from './fetch-url.ts';
import type { ToolContext } from './types.ts';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
  ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    queues: {
      fetch: {
        add: mock.fn(async () => ({ id: 'job-123' })),
      },
    },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test key',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-00000000-0000-0000-0000-000000000001',
    signal: AbortSignal.timeout(5000),
    ...overrides,
  }) as unknown as ToolContext;

describe('fetch-url tool', () => {
  it('has correct metadata', () => {
    assert.equal(tool.name, 'fetch-url');
    assert.equal(tool.title, 'Fetch URL');
    assert.ok(tool.description.length > 0);
    assert.deepEqual(tool.rateLimit, { perMinute: 10 });
  });

  it('enqueues a job for a valid https URL', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ url: 'https://example.com/page' }, ctx);

    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    assert.equal(payload.jobId, 'job-123');
    assert.equal(payload.url, 'https://example.com/page');
    assert.equal(payload.status, 'queued');

    // Verify queue.add was called correctly
    const addFn = (ctx as unknown as Record<string, any>).queues.fetch.add;
    assert.equal(addFn.mock.callCount(), 1);
    const [jobName, jobData] = addFn.mock.calls[0].arguments;
    assert.equal(jobName, 'fetch');
    assert.deepEqual(jobData, {
      url: 'https://example.com/page',
      apiKeyId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('enqueues a job for a valid http URL', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ url: 'http://example.com/' }, ctx);

    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    assert.equal(payload.jobId, 'job-123');
  });

  it('propagates queue.add errors', async () => {
    const ctx = makeCtx({
      queues: {
        fetch: {
          add: mock.fn(async () => {
            throw new Error('Redis connection failed');
          }),
        },
      },
    });

    await assert.rejects(
      () => tool.handler({ url: 'https://example.com' }, ctx),
      (err: Error) => err.message === 'Redis connection failed',
    );
  });

  it('logs the URL on enqueue', async () => {
    const ctx = makeCtx();
    await tool.handler({ url: 'https://example.com' }, ctx);

    const infoFn = ctx.logger.info as unknown as ReturnType<typeof mock.fn>;
    assert.equal(infoFn.mock.callCount(), 1);
    const logArg = infoFn.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(logArg.url, 'https://example.com');
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts valid https URL', () => {
      const result = schema.safeParse({ url: 'https://example.com/path' });
      assert.equal(result.success, true);
    });

    it('accepts valid http URL', () => {
      const result = schema.safeParse({ url: 'http://example.com/' });
      assert.equal(result.success, true);
    });

    it('rejects ftp protocol', () => {
      const result = schema.safeParse({ url: 'ftp://example.com/file' });
      assert.equal(result.success, false);
    });

    it('rejects file protocol', () => {
      const result = schema.safeParse({ url: 'file:///etc/passwd' });
      assert.equal(result.success, false);
    });

    it('rejects non-URL strings', () => {
      const result = schema.safeParse({ url: 'not a url' });
      assert.equal(result.success, false);
    });

    it('rejects empty string', () => {
      const result = schema.safeParse({ url: '' });
      assert.equal(result.success, false);
    });

    it('rejects missing url field', () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });
  });
});
