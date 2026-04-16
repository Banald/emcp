import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './whoami.ts';

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
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

describe('whoami', () => {
  it('has correct metadata', () => {
    assert.equal(tool.name, 'whoami');
    assert.equal(tool.title, 'Who Am I');
    assert.ok(tool.description.length > 0);
  });

  it('returns expected fields from ctx.apiKey and ctx.requestId', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({}, ctx);

    const text = result.content[0];
    assert.ok(text);
    assert.equal(text.type, 'text');
    assert.ok('text' in text);
    const payload = JSON.parse((text as { type: 'text'; text: string }).text);

    assert.equal(payload.id, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(payload.prefix, 'mcp_test_abc');
    assert.equal(payload.name, 'test key');
    assert.equal(payload.rate_limit_per_minute, 60);
    assert.equal(payload.request_id, 'req-00000000-0000-0000-0000-000000000001');
  });

  it('calls ctx.logger.info exactly once', async () => {
    const ctx = makeCtx();
    await tool.handler({}, ctx);

    const infoFn = ctx.logger.info as unknown as ReturnType<typeof mock.fn>;
    assert.equal(infoFn.mock.callCount(), 1);
  });

  it('returns isError undefined (success)', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({}, ctx);
    assert.equal(result.isError, undefined);
  });

  it('returns valid JSON in the text content', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({}, ctx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    assert.doesNotThrow(() => JSON.parse(text));
  });

  it('returns exactly one content item', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({}, ctx);
    assert.equal(result.content.length, 1);
  });
});
