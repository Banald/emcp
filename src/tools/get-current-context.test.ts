import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { toSecondPrecisionIso } from './get-current-context.ts';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
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
    signal: new AbortController().signal,
    ...overrides,
  }) as unknown as ToolContext;

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

describe('get-current-context helpers', () => {
  it('toSecondPrecisionIso strips milliseconds and keeps trailing Z', () => {
    assert.equal(
      toSecondPrecisionIso(new Date('2026-04-21T14:32:00.000Z')),
      '2026-04-21T14:32:00Z',
    );
    assert.equal(
      toSecondPrecisionIso(new Date('2026-04-21T14:32:00.789Z')),
      '2026-04-21T14:32:00Z',
    );
    assert.equal(
      toSecondPrecisionIso(new Date('1970-01-01T00:00:00.000Z')),
      '1970-01-01T00:00:00Z',
    );
  });
});

describe('get-current-context tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  describe('metadata', () => {
    it('has the required name and title', () => {
      assert.equal(tool.name, 'get-current-context');
      assert.equal(tool.title, 'Get Current Context');
    });

    it('has the exact required description', () => {
      assert.equal(
        tool.description,
        'REQUIRED: Call this at the start of every session to ground yourself in the current date and time. Your training cutoff is NOT the current date. Time has continued to pass since your training ended. Call this before reasoning about anything time-sensitive.',
      );
    });

    it('declares both inputSchema and outputSchema', () => {
      assert.ok(tool.inputSchema);
      assert.ok(tool.outputSchema);
    });

    it('takes no input fields', () => {
      assert.deepEqual(Object.keys(tool.inputSchema), []);
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts an empty input', () => {
      assert.equal(schema.safeParse({}).success, true);
    });

    it('accepts (and strips) unexpected fields by default', () => {
      const result = schema.safeParse({ anything: 'goes' });
      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.data, {});
      }
    });
  });

  describe('handler', () => {
    it('returns the current datetime truncated to second precision with trailing Z', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-21T14:32:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.current_datetime, '2026-04-21T14:32:00Z');
    });

    it('strips milliseconds even when the wall clock has them', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-21T14:32:00.789Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.current_datetime, '2026-04-21T14:32:00Z');
    });

    it('returns the fixed training-cutoff hint', async () => {
      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(
        structured.months_since_likely_training_cutoff,
        'varies (typically 6-18 months)',
      );
    });

    it('returns exactly the three grounding reminders', async () => {
      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      const reminders = structured.reminders as string[];

      assert.ok(Array.isArray(reminders));
      assert.equal(reminders.length, 3);
      assert.match(reminders[0] as string, /Software versions/);
      assert.match(reminders[1] as string, /'current'/);
      assert.match(reminders[2] as string, /not have been trained on them/);
    });

    it('serializes structuredContent verbatim into the text content block', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-21T14:32:00.000Z').getTime(),
      });
      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);

      const parsed = JSON.parse(textOf(result));
      assert.deepEqual(parsed, result.structuredContent);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      const ctx = makeCtx();
      const result = await tool.handler({}, ctx);

      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('returns fresh reminder and datetime values across calls (no shared mutation)', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-21T14:32:00.000Z').getTime(),
      });
      const ctx = makeCtx();
      const first = await tool.handler({}, ctx);
      const firstStructured = first.structuredContent as Record<string, unknown>;
      (firstStructured.reminders as string[]).push('tampered');

      mock.timers.reset();
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-21T14:32:05.000Z').getTime(),
      });
      const second = await tool.handler({}, ctx);
      const secondStructured = second.structuredContent as Record<string, unknown>;

      assert.equal((secondStructured.reminders as string[]).length, 3);
      assert.equal(secondStructured.current_datetime, '2026-04-21T14:32:05Z');
    });
  });
});
