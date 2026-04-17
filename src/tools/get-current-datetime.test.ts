import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { formatOffset, parseLongOffset } from './get-current-datetime.ts';

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

describe('get-current-datetime helpers', () => {
  it('parseLongOffset returns 0 for undefined / GMT / UTC / malformed', () => {
    assert.equal(parseLongOffset(undefined), 0);
    assert.equal(parseLongOffset('GMT'), 0);
    assert.equal(parseLongOffset('UTC'), 0);
    assert.equal(parseLongOffset('garbage'), 0);
    assert.equal(parseLongOffset(''), 0);
  });

  it('parseLongOffset parses hour-only and hour:minute forms', () => {
    assert.equal(parseLongOffset('GMT+2'), 120);
    assert.equal(parseLongOffset('GMT+02:00'), 120);
    assert.equal(parseLongOffset('GMT-05:30'), -330);
    assert.equal(parseLongOffset('UTC+09:00'), 540);
  });

  it('formatOffset pads hours and minutes', () => {
    assert.equal(formatOffset(0), '+00:00');
    assert.equal(formatOffset(120), '+02:00');
    assert.equal(formatOffset(-300), '-05:00');
    assert.equal(formatOffset(-570), '-09:30');
  });
});

describe('get-current-datetime tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'get-current-datetime');
      assert.equal(tool.title, 'Get Current Datetime');
    });

    it('has a description mentioning timezone and UTC', () => {
      assert.match(tool.description, /timezone/i);
      assert.match(tool.description, /UTC/);
      assert.match(tool.description, /ISO 8601/);
    });

    it('declares both inputSchema and outputSchema', () => {
      assert.ok(tool.inputSchema);
      assert.ok(tool.outputSchema);
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts an empty input and applies defaults', () => {
      const result = schema.safeParse({});
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.timezone, 'UTC');
        assert.equal(result.data.format, 'both');
      }
    });

    it('accepts a valid IANA timezone', () => {
      const result = schema.safeParse({ timezone: 'Europe/Stockholm' });
      assert.equal(result.success, true);
    });

    it('rejects an empty timezone string', () => {
      const result = schema.safeParse({ timezone: '' });
      assert.equal(result.success, false);
    });

    it('rejects a timezone longer than 80 characters', () => {
      const result = schema.safeParse({ timezone: 'A'.repeat(81) });
      assert.equal(result.success, false);
    });

    it('accepts each format enum value', () => {
      for (const format of ['iso', 'human', 'both'] as const) {
        assert.equal(schema.safeParse({ format }).success, true);
      }
    });

    it('rejects an unknown format value', () => {
      const result = schema.safeParse({ format: 'xml' });
      assert.equal(result.success, false);
    });
  });

  describe('handler', () => {
    it('returns isError for an unknown timezone without throwing', async () => {
      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'Not/A_Zone', format: 'both' }, ctx);

      assert.equal(result.isError, true);
      assert.match(textOf(result), /Unknown timezone/);
      assert.match(textOf(result), /Europe\/Stockholm/);
    });

    it('returns a UTC snapshot with trailing Z and offset +00:00', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-17T12:34:56.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'UTC', format: 'both' }, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.utc_iso, '2026-04-17T12:34:56.000Z');
      assert.equal(structured.local_iso, '2026-04-17T12:34:56+00:00');
      assert.equal(structured.timezone, 'UTC');
      assert.equal(structured.offset, '+00:00');
      assert.equal(structured.offset_minutes, 0);
      assert.equal(structured.date, '2026-04-17');
      assert.equal(structured.time, '12:34:56');
      assert.equal(structured.unix_ms, new Date('2026-04-17T12:34:56.000Z').getTime());
      assert.equal(structured.is_dst, false);
      assert.match(structured.weekday as string, /Friday/);
    });

    it('returns a DST-aware Stockholm snapshot in summer (+02:00)', async () => {
      // 2026-07-15 is deep inside European summer time.
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-07-15T10:00:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'Europe/Stockholm', format: 'both' }, ctx);

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.timezone, 'Europe/Stockholm');
      assert.equal(structured.offset, '+02:00');
      assert.equal(structured.offset_minutes, 120);
      assert.equal(structured.is_dst, true);
      assert.equal(structured.local_iso, '2026-07-15T12:00:00+02:00');
      assert.equal(structured.date, '2026-07-15');
      assert.equal(structured.time, '12:00:00');
    });

    it('returns non-DST Stockholm snapshot in winter (+01:00)', async () => {
      // 2026-01-15 is deep inside European winter time.
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-01-15T10:00:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'Europe/Stockholm', format: 'both' }, ctx);

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.offset, '+01:00');
      assert.equal(structured.offset_minutes, 60);
      assert.equal(structured.is_dst, false);
      assert.equal(structured.local_iso, '2026-01-15T11:00:00+01:00');
    });

    it('returns a negative offset for a western timezone', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-01-15T17:00:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'America/New_York', format: 'both' }, ctx);

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.offset, '-05:00');
      assert.equal(structured.offset_minutes, -300);
      assert.equal(structured.is_dst, false);
      assert.match(structured.local_iso as string, /12:00:00-05:00$/);
    });

    it('handles a non-DST zone without falsely flagging is_dst', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-06-01T00:00:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'Asia/Tokyo', format: 'both' }, ctx);

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.offset, '+09:00');
      assert.equal(structured.is_dst, false);
    });

    it('respects format=iso (no human line)', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-17T12:00:00.000Z').getTime(),
      });
      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'UTC', format: 'iso' }, ctx);
      const text = textOf(result);
      assert.match(text, /^UTC: {3}2026-04-17T12:00:00.000Z$/m);
      assert.match(text, /^Local:/m);
      assert.doesNotMatch(text, /^Human:/m);
    });

    it('respects format=human (no ISO UTC/Local lines)', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-17T12:00:00.000Z').getTime(),
      });
      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'UTC', format: 'human' }, ctx);
      const text = textOf(result);
      assert.match(text, /^Human: /m);
      assert.doesNotMatch(text, /^UTC: /m);
      assert.doesNotMatch(text, /^Local: /m);
    });

    it('always includes Unix ms and DST lines', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-17T12:00:00.000Z').getTime(),
      });
      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'UTC', format: 'iso' }, ctx);
      const text = textOf(result);
      assert.match(text, /^Unix ms: \d+$/m);
      assert.match(text, /^DST: (active|not active)$/m);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-04-17T12:00:00.000Z').getTime(),
      });

      const ctx = makeCtx();
      const result = await tool.handler({ timezone: 'Europe/Stockholm', format: 'both' }, ctx);

      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });
  });
});
