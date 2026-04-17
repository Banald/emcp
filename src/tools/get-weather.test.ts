import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { fmtNum, labelForSymbol, normalizeStep, pickNumber } from './get-weather.ts';

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const makeStep = (time: string, data: Record<string, number>) => ({ time, data });

const FORECAST_BODY = {
  approvedTime: '2026-04-17T07:14:00Z',
  referenceTime: '2026-04-17T06:00:00Z',
  geometry: { type: 'Point', coordinates: [18.0686, 59.3293] },
  timeSeries: [
    makeStep('2026-04-17T07:00:00Z', {
      air_temperature: 7.2,
      wind_speed: 4.1,
      wind_from_direction: 210,
      wind_speed_of_gust: 8.3,
      relative_humidity: 68,
      air_pressure_at_mean_sea_level: 1015.3,
      visibility_in_air: 49.0,
      cloud_area_fraction: 55,
      precipitation_amount_mean: 0.0,
      precipitation_amount_min: 0.0,
      precipitation_amount_max: 0.0,
      predominant_precipitation_type_at_surface: 0,
      thunderstorm_probability: 0,
      symbol_code: 3,
    }),
    makeStep('2026-04-17T08:00:00Z', {
      air_temperature: 8.1,
      wind_speed: 4.4,
      symbol_code: 5,
    }),
    makeStep('2026-04-17T09:00:00Z', { air_temperature: 9.0, symbol_code: 18 }),
  ],
};

describe('get-weather helpers', () => {
  it('labelForSymbol maps known codes', () => {
    assert.equal(labelForSymbol(1), 'Clear sky');
    assert.equal(labelForSymbol(11), 'Thunderstorm');
    assert.equal(labelForSymbol(27), 'Heavy snowfall');
  });

  it('labelForSymbol returns a placeholder for unknown codes', () => {
    assert.match(labelForSymbol(999), /unknown \(999\)/);
  });

  it('pickNumber returns null for missing, non-finite, or non-number values', () => {
    assert.equal(pickNumber({ x: 5 }, 'x'), 5);
    assert.equal(pickNumber({ x: 0 }, 'x'), 0);
    assert.equal(pickNumber({ x: -1.5 }, 'x'), -1.5);
    assert.equal(pickNumber({}, 'x'), null);
    assert.equal(pickNumber({ x: Number.NaN }, 'x'), null);
    assert.equal(pickNumber({ x: Number.POSITIVE_INFINITY }, 'x'), null);
    assert.equal(pickNumber({ x: 'abc' } as unknown as Record<string, number>, 'x'), null);
  });

  it('fmtNum formats numbers and returns n/a for null', () => {
    assert.equal(fmtNum(0), '0');
    assert.equal(fmtNum(-3.5), '-3.5');
    assert.equal(fmtNum(null), 'n/a');
  });

  it('normalizeStep fills every field with null when data is empty', () => {
    const step = normalizeStep({ time: '2026-04-17T07:00:00Z' });
    assert.equal(step.air_temperature, null);
    assert.equal(step.wind_speed, null);
    assert.equal(step.symbol_code, null);
    assert.equal(step.symbol_label, null);
    assert.equal(step.time, '2026-04-17T07:00:00Z');
  });

  it('normalizeStep returns a label when symbol_code is present', () => {
    const step = normalizeStep({ time: 't', data: { symbol_code: 11 } });
    assert.equal(step.symbol_code, 11);
    assert.equal(step.symbol_label, 'Thunderstorm');
  });

  it('normalizeStep handles a missing time field', () => {
    const step = normalizeStep({});
    assert.equal(step.time, '');
    assert.equal(step.symbol_code, null);
    assert.equal(step.symbol_label, null);
  });
});

describe('get-weather tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'get-weather');
      assert.equal(tool.title, 'Get Weather');
    });

    it('description mentions SMHI and SNOW1gv1', () => {
      assert.match(tool.description, /SMHI/);
      assert.match(tool.description, /SNOW1gv1/);
    });

    it('has rate limit 30/min', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid lat/lon', () => {
      assert.equal(schema.safeParse({ latitude: 59.3293, longitude: 18.0686 }).success, true);
    });

    it('rejects latitude out of range', () => {
      assert.equal(schema.safeParse({ latitude: 91, longitude: 0 }).success, false);
      assert.equal(schema.safeParse({ latitude: -91, longitude: 0 }).success, false);
    });

    it('rejects longitude out of range', () => {
      assert.equal(schema.safeParse({ latitude: 0, longitude: 181 }).success, false);
    });

    it('rejects steps<1 and steps>96', () => {
      assert.equal(schema.safeParse({ latitude: 0, longitude: 0, steps: 0 }).success, false);
      assert.equal(schema.safeParse({ latitude: 0, longitude: 0, steps: 97 }).success, false);
    });
  });

  describe('handler', () => {
    it('places lon before lat in the SMHI URL path', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx);

      const url = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(url, /\/lon\/18\.0686\/lat\/59\.3293\/data\.json$/);
    });

    it('rounds coordinates to 6 decimal places', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      await tool.handler({ latitude: 59.32934567891, longitude: 18.06861234567, steps: 24 }, ctx);
      const url = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(url, /\/lon\/18\.068612\/lat\/59\.329346\/data\.json$/);
    });

    it('parses a full forecast into typed steps with symbol labels', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        approved_time: string;
        reference_time: string;
        latitude: number;
        longitude: number;
        geometry_coordinates: number[];
        now: Record<string, unknown>;
        series: Array<Record<string, unknown>>;
      };

      assert.equal(structured.approved_time, '2026-04-17T07:14:00Z');
      assert.equal(structured.reference_time, '2026-04-17T06:00:00Z');
      assert.equal(structured.latitude, 59.3293);
      assert.equal(structured.longitude, 18.0686);
      assert.deepEqual(structured.geometry_coordinates, [18.0686, 59.3293]);
      assert.equal(structured.series.length, 3);
      assert.equal(structured.now.time, '2026-04-17T07:00:00Z');
      assert.equal(structured.now.air_temperature, 7.2);
      assert.equal(structured.now.symbol_code, 3);
      assert.equal(structured.now.symbol_label, 'Variable cloudiness');
      assert.equal(structured.now.wind_speed, 4.1);
      assert.equal(structured.series[1]?.air_temperature, 8.1);
      assert.equal(structured.series[1]?.symbol_label, 'Cloudy');
    });

    it('respects the steps parameter', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 2 }, ctx);
      const structured = result.structuredContent as { series: unknown[] };
      assert.equal(structured.series.length, 2);
    });

    it('fills missing numeric fields with null', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 5 }, ctx);
      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      // Second step only has air_temperature, wind_speed, symbol_code.
      const step2 = structured.series[1];
      assert.equal(step2?.relative_humidity, null);
      assert.equal(step2?.cloud_area_fraction, null);
      assert.equal(step2?.precipitation_amount_mean, null);
    });

    it('returns isError on HTTP 404 (outside coverage)', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('no', { status: 404 }));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 0, longitude: 0, steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Nordic\/Baltic coverage/);
    });

    it('returns isError when timeSeries is empty', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          approvedTime: '2026-04-17T07:14:00Z',
          referenceTime: '2026-04-17T06:00:00Z',
          timeSeries: [],
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /empty forecast series/);
    });

    it('throws TransientError on HTTP 503', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('ENETUNREACH');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('sends the User-Agent header', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 24 }, ctx);
      const init = fetchMock.mock.calls[0]?.arguments[1] as { headers: Record<string, string> };
      assert.equal(init.headers['User-Agent'], USER_AGENT);
    });

    it('renders the text block with Now and forecast sections', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 3 }, ctx);
      const text = textOf(result);
      assert.match(text, /^SMHI forecast for \(59\.3293, 18\.0686\)$/m);
      assert.match(text, /Now — 2026-04-17T07:00:00Z/);
      assert.match(text, /Weather: .*Variable cloudiness/);
      assert.match(text, /Forecast — next 3 steps:/);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(FORECAST_BODY));
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 3 }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('falls back to [lon, lat] when SMHI omits geometry', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          approvedTime: 'a',
          referenceTime: 'b',
          timeSeries: [makeStep('2026-04-17T07:00:00Z', { air_temperature: 1, symbol_code: 1 })],
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ latitude: 59.3293, longitude: 18.0686, steps: 1 }, ctx);
      const structured = result.structuredContent as { geometry_coordinates: number[] };
      assert.deepEqual(structured.geometry_coordinates, [18.0686, 59.3293]);
    });
  });
});
