import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fetchUrlProcessor } from './fetch-url.ts';

const makeJob = (data: { url: string; apiKeyId: string }, id = 'test-job-1') => ({
  id,
  data,
  updateProgress: mock.fn(async () => {}),
});

const makeCtx = (overrides: Record<string, unknown> = {}) => ({
  logger: {
    child: mock.fn(() => ({
      info: mock.fn(),
      error: mock.fn(),
      warn: mock.fn(),
    })),
    info: mock.fn(),
    error: mock.fn(),
  },
  db: {
    query: mock.fn(async () => ({
      rows: [{ id: 'resource-uuid-123' }],
    })),
  },
  redis: {},
  ...overrides,
});

describe('fetchUrlProcessor', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mock.reset();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches URL, inserts into DB, and returns expected result', async () => {
    globalThis.fetch = mock.fn(
      async () =>
        new Response('hello world', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
    ) as typeof fetch;

    const job = makeJob({ url: 'https://example.com/page', apiKeyId: 'key-1' });
    const ctx = makeCtx();

    const result = await fetchUrlProcessor(job as never, ctx as never);

    assert.equal(result.resourceId, 'resource-uuid-123');
    assert.equal(result.statusCode, 200);
    assert.equal(result.bytes, Buffer.byteLength('hello world', 'utf8'));

    // Verify DB insert was called with correct params
    const queryFn = ctx.db.query as ReturnType<typeof mock.fn>;
    assert.equal(queryFn.mock.callCount(), 1);
    const [sql, params] = queryFn.mock.calls[0].arguments as [string, unknown[]];
    assert.ok(sql.includes('INSERT INTO fetched_resources'));
    assert.equal(params[0], 'https://example.com/page');
    assert.equal(params[1], 200);
    assert.equal(params[2], 'text/plain');
    assert.equal(params[3], 'hello world');
    assert.equal(params[5], 'key-1');
  });

  it('stores non-200 status codes correctly', async () => {
    globalThis.fetch = mock.fn(
      async () =>
        new Response('not found', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        }),
    ) as typeof fetch;

    const job = makeJob({ url: 'https://example.com/missing', apiKeyId: 'key-2' });
    const ctx = makeCtx();

    const result = await fetchUrlProcessor(job as never, ctx as never);

    assert.equal(result.statusCode, 404);
    const queryFn = ctx.db.query as ReturnType<typeof mock.fn>;
    const [, params] = queryFn.mock.calls[0].arguments as [string, unknown[]];
    assert.equal(params[1], 404);
    assert.equal(params[3], 'not found');
  });

  it('throws on network error', async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const job = makeJob({ url: 'https://unreachable.example.com', apiKeyId: 'key-3' });
    const ctx = makeCtx();

    await assert.rejects(
      () => fetchUrlProcessor(job as never, ctx as never),
      (err: Error) => err.message === 'fetch failed',
    );
  });

  it('truncates body over 1 MB but records full byte count', async () => {
    const largeBody = 'x'.repeat(2_000_000);
    globalThis.fetch = mock.fn(
      async () =>
        new Response(largeBody, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    ) as typeof fetch;

    const job = makeJob({ url: 'https://example.com/large', apiKeyId: 'key-4' });
    const ctx = makeCtx();

    const result = await fetchUrlProcessor(job as never, ctx as never);

    // Full byte count recorded in result
    assert.equal(result.bytes, Buffer.byteLength(largeBody, 'utf8'));

    // Stored body is truncated to 1 MB
    const queryFn = ctx.db.query as ReturnType<typeof mock.fn>;
    const [, params] = queryFn.mock.calls[0].arguments as [string, unknown[]];
    const storedBody = params[3] as string;
    assert.equal(storedBody.length, 1_048_576);

    // Full bytes param still has the real size
    assert.equal(params[4], Buffer.byteLength(largeBody, 'utf8'));
  });

  it('throws on invalid protocol (ftp)', async () => {
    const job = makeJob({ url: 'ftp://example.com/file', apiKeyId: 'key-5' });
    const ctx = makeCtx();

    await assert.rejects(
      () => fetchUrlProcessor(job as never, ctx as never),
      (err: Error) => err.message.includes('unsupported protocol'),
    );
  });

  it('throws on invalid protocol (file)', async () => {
    const job = makeJob({ url: 'file:///etc/passwd', apiKeyId: 'key-6' });
    const ctx = makeCtx();

    await assert.rejects(
      () => fetchUrlProcessor(job as never, ctx as never),
      (err: Error) => err.message.includes('unsupported protocol'),
    );
  });

  it('calls job.updateProgress at expected milestones', async () => {
    globalThis.fetch = mock.fn(async () => new Response('ok', { status: 200 })) as typeof fetch;

    const job = makeJob({ url: 'https://example.com', apiKeyId: 'key-7' });
    const ctx = makeCtx();

    await fetchUrlProcessor(job as never, ctx as never);

    const progressCalls = job.updateProgress.mock.calls as unknown as Array<{
      arguments: [number];
    }>;
    assert.equal(progressCalls.length, 3);
    assert.equal(progressCalls[0].arguments[0], 10);
    assert.equal(progressCalls[1].arguments[0], 60);
    assert.equal(progressCalls[2].arguments[0], 100);
  });

  it('creates a child logger with job_id and url', async () => {
    globalThis.fetch = mock.fn(async () => new Response('ok', { status: 200 })) as typeof fetch;

    const job = makeJob({ url: 'https://example.com/test', apiKeyId: 'key-8' }, 'job-42');
    const ctx = makeCtx();

    await fetchUrlProcessor(job as never, ctx as never);

    const childFn = ctx.logger.child as ReturnType<typeof mock.fn>;
    assert.equal(childFn.mock.callCount(), 1);
    assert.deepEqual(childFn.mock.calls[0].arguments[0], {
      job_id: 'job-42',
      url: 'https://example.com/test',
    });
  });

  it('throws on malformed URL', async () => {
    const job = makeJob({ url: 'not-a-url', apiKeyId: 'key-9' });
    const ctx = makeCtx();

    await assert.rejects(
      () => fetchUrlProcessor(job as never, ctx as never),
      (err: Error) => err instanceof TypeError,
    );
  });
});
