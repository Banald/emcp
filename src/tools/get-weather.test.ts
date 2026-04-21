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

type FetchArgs = Parameters<typeof fetch>;

const sequenceFetches = (
  responses: ReadonlyArray<Response | (() => Response | Promise<Response>)>,
): ReturnType<typeof mock.method<typeof globalThis, 'fetch'>> => {
  let i = 0;
  return mock.method(globalThis, 'fetch', async (..._args: FetchArgs): Promise<Response> => {
    const idx = i;
    i++;
    const entry = responses[idx];
    if (entry === undefined) {
      throw new Error(`Unexpected fetch call #${idx + 1}`);
    }
    return typeof entry === 'function' ? await entry() : entry;
  });
};

const makeStep = (time: string, data: Record<string, number>) => ({ time, data });

const GEOCODE_STOCKHOLM = {
  results: [
    {
      id: 2673730,
      name: 'Stockholm',
      latitude: 59.3293,
      longitude: 18.0686,
      country: 'Sweden',
      country_code: 'SE',
      admin1: 'Stockholm',
    },
  ],
};

const GEOCODE_PARIS = {
  results: [
    {
      id: 2988507,
      name: 'Paris',
      latitude: 48.8534,
      longitude: 2.3488,
      country: 'France',
      country_code: 'FR',
    },
  ],
};

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

    it('description mentions SMHI and Open-Meteo', () => {
      assert.match(tool.description, /SMHI/);
      assert.match(tool.description, /Open-Meteo/);
    });

    it('has rate limit 30/min', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid location', () => {
      assert.equal(schema.safeParse({ location: 'Stockholm' }).success, true);
    });

    it('rejects empty location', () => {
      assert.equal(schema.safeParse({ location: '' }).success, false);
    });

    it('rejects location over 200 characters', () => {
      assert.equal(schema.safeParse({ location: 'a'.repeat(201) }).success, false);
    });

    it('rejects steps<1 and steps>96', () => {
      assert.equal(schema.safeParse({ location: 'Stockholm', steps: 0 }).success, false);
      assert.equal(schema.safeParse({ location: 'Stockholm', steps: 97 }).success, false);
    });

    it('does not require steps (default 24)', () => {
      const parsed = schema.parse({ location: 'Stockholm' });
      assert.equal(parsed.steps, 24);
    });
  });

  describe('handler — happy path', () => {
    it('geocodes then fetches SMHI, returning a parsed forecast', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 24 }, ctx);

      assert.equal(fetchMock.mock.callCount(), 2);
      const geoUrl = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(geoUrl, /geocoding-api\.open-meteo\.com\/v1\/search\?/);
      assert.match(geoUrl, /name=Stockholm/);
      const smhiUrl = fetchMock.mock.calls[1]?.arguments[0] as string;
      assert.match(smhiUrl, /\/lon\/18\.0686\/lat\/59\.3293\/data\.json$/);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        query: string;
        resolved_location: {
          name: string;
          country: string | null;
          country_code: string | null;
          latitude: number;
          longitude: number;
        };
        approved_time: string;
        reference_time: string;
        latitude: number;
        longitude: number;
        geometry_coordinates: number[];
        now: Record<string, unknown>;
        series: Array<Record<string, unknown>>;
      };

      assert.equal(structured.query, 'Stockholm');
      assert.equal(structured.resolved_location.name, 'Stockholm');
      assert.equal(structured.resolved_location.country, 'Sweden');
      assert.equal(structured.resolved_location.country_code, 'SE');
      assert.equal(structured.resolved_location.latitude, 59.3293);
      assert.equal(structured.resolved_location.longitude, 18.0686);
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

    it('URL-encodes the geocoder query', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse({
          results: [
            {
              name: 'Göteborg',
              latitude: 57.70887,
              longitude: 11.97456,
              country: 'Sweden',
              country_code: 'SE',
            },
          ],
        }),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: 'Göteborg, Sweden', steps: 24 }, ctx);
      const geoUrl = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(geoUrl, /name=G%C3%B6teborg%2C%20Sweden/);
    });

    it('trims whitespace before geocoding', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: '   Stockholm   ', steps: 24 }, ctx);
      const geoUrl = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(geoUrl, /name=Stockholm&/);
    });

    it('rounds SMHI coordinates to 6 decimal places', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse({
          results: [
            {
              name: 'Stockholm',
              latitude: 59.32934567891,
              longitude: 18.06861234567,
              country: 'Sweden',
              country_code: 'SE',
            },
          ],
        }),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: 'Stockholm', steps: 24 }, ctx);
      const smhiUrl = fetchMock.mock.calls[1]?.arguments[0] as string;
      assert.match(smhiUrl, /\/lon\/18\.068612\/lat\/59\.329346\/data\.json$/);
    });

    it('respects the steps parameter', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 2 }, ctx);
      const structured = result.structuredContent as { series: unknown[] };
      assert.equal(structured.series.length, 2);
    });

    it('fills missing numeric fields with null', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 5 }, ctx);
      const structured = result.structuredContent as { series: Array<Record<string, unknown>> };
      const step2 = structured.series[1];
      assert.equal(step2?.relative_humidity, null);
      assert.equal(step2?.cloud_area_fraction, null);
      assert.equal(step2?.precipitation_amount_mean, null);
    });

    it('sends the User-Agent header on both requests', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: 'Stockholm', steps: 24 }, ctx);
      const geoInit = fetchMock.mock.calls[0]?.arguments[1] as { headers: Record<string, string> };
      const smhiInit = fetchMock.mock.calls[1]?.arguments[1] as { headers: Record<string, string> };
      assert.equal(geoInit.headers['User-Agent'], USER_AGENT);
      assert.equal(smhiInit.headers['User-Agent'], USER_AGENT);
    });

    it('renders the text block with resolved location, Now, and forecast sections', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 3 }, ctx);
      const text = textOf(result);
      assert.match(
        text,
        /SMHI forecast for "Stockholm" → Stockholm, Sweden \(59\.3293, 18\.0686\)/,
      );
      assert.match(text, /Now — 2026-04-17T07:00:00Z/);
      assert.match(text, /Weather: .*Variable cloudiness/);
      assert.match(text, /Forecast — next 3 steps:/);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 3 }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('falls back to [lon, lat] when SMHI omits geometry', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse({
          approvedTime: 'a',
          referenceTime: 'b',
          timeSeries: [makeStep('2026-04-17T07:00:00Z', { air_temperature: 1, symbol_code: 1 })],
        }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 1 }, ctx);
      const structured = result.structuredContent as { geometry_coordinates: number[] };
      assert.deepEqual(structured.geometry_coordinates, [18.0686, 59.3293]);
    });

    it('falls through to SMHI when the geocoder omits country_code', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse({
          results: [{ name: 'Somewhere', latitude: 60, longitude: 15 }],
        }),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Somewhere', steps: 1 }, ctx);
      assert.equal(fetchMock.mock.callCount(), 2);
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        resolved_location: { country_code: string | null };
      };
      assert.equal(structured.resolved_location.country_code, null);
    });
  });

  describe('handler — geocoder error paths', () => {
    it('returns isError when the input is blank after trimming', async () => {
      const fetchMock = sequenceFetches([]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: '   ', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /must not be blank/);
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it('returns isError and skips SMHI when the geocoder returns zero results', async () => {
      const fetchMock = sequenceFetches([jsonResponse({ results: [] })]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'asdfqwerty-no-such-place', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Could not find a place matching "asdfqwerty-no-such-place"/);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('treats missing results array as not found', async () => {
      sequenceFetches([jsonResponse({})]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'nowhere', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Could not find a place/);
    });

    it('returns isError when the resolved place is outside Nordic/Baltic coverage', async () => {
      const fetchMock = sequenceFetches([jsonResponse(GEOCODE_PARIS)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Paris', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Paris, France/);
      assert.match(textOf(result), /Nordic\/Baltic coverage/);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('throws TransientError on geocoder HTTP 503', async () => {
      sequenceFetches([() => new Response('down', { status: 503 })]);
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ location: 'Stockholm', steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on geocoder network error', async () => {
      sequenceFetches([
        () => {
          throw new Error('ENETUNREACH');
        },
      ]);
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ location: 'Stockholm', steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });
  });

  describe('handler — SMHI error paths', () => {
    it('returns isError on SMHI HTTP 404 naming the resolved place', async () => {
      sequenceFetches([
        jsonResponse({
          results: [
            {
              name: 'Remote island',
              latitude: 0,
              longitude: 0,
              country: 'Sweden',
              country_code: 'SE',
            },
          ],
        }),
        () => new Response('no', { status: 404 }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Remote island', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Remote island/);
      assert.match(textOf(result), /Nordic\/Baltic coverage area/);
    });

    it('returns isError when timeSeries is empty', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse({
          approvedTime: '2026-04-17T07:14:00Z',
          referenceTime: '2026-04-17T06:00:00Z',
          timeSeries: [],
        }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm', steps: 24 }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /empty forecast series/);
    });

    it('throws TransientError on SMHI HTTP 503', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        () => new Response('down', { status: 503 }),
      ]);
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ location: 'Stockholm', steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on SMHI network error', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        () => {
          throw new Error('ENETUNREACH');
        },
      ]);
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ location: 'Stockholm', steps: 24 }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });
  });
});
