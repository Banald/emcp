import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { conditionFromSymbol, pickNumber } from './get-weather.ts';

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
      symbol_code: 3,
    }),
    makeStep('2026-04-17T08:00:00Z', {
      air_temperature: 8.1,
      wind_speed: 4.4,
      symbol_code: 5,
    }),
  ],
};

describe('get-weather helpers', () => {
  it('pickNumber returns null for missing, non-finite, or non-number values', () => {
    assert.equal(pickNumber({ x: 5 }, 'x'), 5);
    assert.equal(pickNumber({ x: 0 }, 'x'), 0);
    assert.equal(pickNumber({ x: -1.5 }, 'x'), -1.5);
    assert.equal(pickNumber({}, 'x'), null);
    assert.equal(pickNumber({ x: Number.NaN }, 'x'), null);
    assert.equal(pickNumber({ x: Number.POSITIVE_INFINITY }, 'x'), null);
    assert.equal(pickNumber({ x: 'abc' } as unknown as Record<string, number>, 'x'), null);
  });

  it('conditionFromSymbol buckets SMHI symbol codes', () => {
    assert.equal(conditionFromSymbol(1), 'sunny');
    assert.equal(conditionFromSymbol(2), 'sunny');
    assert.equal(conditionFromSymbol(3), 'cloudy');
    assert.equal(conditionFromSymbol(6), 'cloudy');
    assert.equal(conditionFromSymbol(7), 'foggy');
    assert.equal(conditionFromSymbol(8), 'raining');
    assert.equal(conditionFromSymbol(18), 'raining');
    assert.equal(conditionFromSymbol(20), 'raining');
    assert.equal(conditionFromSymbol(11), 'thunderstorm');
    assert.equal(conditionFromSymbol(21), 'thunderstorm');
    assert.equal(conditionFromSymbol(12), 'sleet');
    assert.equal(conditionFromSymbol(24), 'sleet');
    assert.equal(conditionFromSymbol(15), 'snowing');
    assert.equal(conditionFromSymbol(27), 'snowing');
  });

  it('conditionFromSymbol returns unknown for null or unknown codes', () => {
    assert.equal(conditionFromSymbol(null), 'unknown');
    assert.equal(conditionFromSymbol(999), 'unknown');
    assert.equal(conditionFromSymbol(0), 'unknown');
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

    it('ignores unexpected fields like steps', () => {
      assert.equal(schema.safeParse({ location: 'Stockholm', steps: 24 }).success, true);
    });
  });

  describe('handler — happy path', () => {
    it('geocodes then fetches SMHI, returning a compact snapshot', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);

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
        time: string;
        temperature_celsius: number | null;
        wind_speed_ms: number | null;
        condition: string;
      };

      assert.equal(structured.query, 'Stockholm');
      assert.equal(structured.resolved_location.name, 'Stockholm');
      assert.equal(structured.resolved_location.country, 'Sweden');
      assert.equal(structured.resolved_location.country_code, 'SE');
      assert.equal(structured.resolved_location.latitude, 59.3293);
      assert.equal(structured.resolved_location.longitude, 18.0686);
      assert.equal(structured.time, '2026-04-17T07:00:00Z');
      assert.equal(structured.temperature_celsius, 7.2);
      assert.equal(structured.wind_speed_ms, 4.1);
      assert.equal(structured.condition, 'cloudy');
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
      await tool.handler({ location: 'Göteborg, Sweden' }, ctx);
      const geoUrl = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.match(geoUrl, /name=G%C3%B6teborg%2C%20Sweden/);
    });

    it('trims whitespace before geocoding', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: '   Stockholm   ' }, ctx);
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
      await tool.handler({ location: 'Stockholm' }, ctx);
      const smhiUrl = fetchMock.mock.calls[1]?.arguments[0] as string;
      assert.match(smhiUrl, /\/lon\/18\.068612\/lat\/59\.329346\/data\.json$/);
    });

    it('fills missing numeric fields with null', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse({
          timeSeries: [makeStep('2026-04-17T07:00:00Z', {})],
        }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
      const structured = result.structuredContent as {
        temperature_celsius: number | null;
        wind_speed_ms: number | null;
        condition: string;
      };
      assert.equal(structured.temperature_celsius, null);
      assert.equal(structured.wind_speed_ms, null);
      assert.equal(structured.condition, 'unknown');
    });

    it('sends the User-Agent header on both requests', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      await tool.handler({ location: 'Stockholm' }, ctx);
      const geoInit = fetchMock.mock.calls[0]?.arguments[1] as { headers: Record<string, string> };
      const smhiInit = fetchMock.mock.calls[1]?.arguments[1] as { headers: Record<string, string> };
      assert.equal(geoInit.headers['User-Agent'], USER_AGENT);
      assert.equal(smhiInit.headers['User-Agent'], USER_AGENT);
    });

    it('renders a compact text snapshot with location, temperature, wind, and condition', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
      const text = textOf(result);
      assert.match(text, /Stockholm, Sweden/);
      assert.match(text, /2026-04-17T07:00:00Z/);
      assert.match(text, /7\.2 °C/);
      assert.match(text, /wind 4\.1 m\/s/);
      assert.match(text, /cloudy/);
    });

    it('renders n/a when temperature or wind is missing', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse({
          timeSeries: [makeStep('2026-04-17T07:00:00Z', { symbol_code: 1 })],
        }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
      const text = textOf(result);
      assert.match(text, /n\/a/);
      assert.match(text, /wind n\/a/);
      assert.match(text, /sunny/);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      sequenceFetches([jsonResponse(GEOCODE_STOCKHOLM), jsonResponse(FORECAST_BODY)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('falls through to SMHI when the geocoder omits country_code', async () => {
      const fetchMock = sequenceFetches([
        jsonResponse({
          results: [{ name: 'Somewhere', latitude: 60, longitude: 15 }],
        }),
        jsonResponse(FORECAST_BODY),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Somewhere' }, ctx);
      assert.equal(fetchMock.mock.callCount(), 2);
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        resolved_location: { country_code: string | null };
      };
      assert.equal(structured.resolved_location.country_code, null);
    });

    it('handles a forecast step with a missing time field', async () => {
      sequenceFetches([
        jsonResponse(GEOCODE_STOCKHOLM),
        jsonResponse({ timeSeries: [{ data: { air_temperature: 1, symbol_code: 1 } }] }),
      ]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
      const structured = result.structuredContent as { time: string };
      assert.equal(structured.time, '');
    });
  });

  describe('handler — geocoder error paths', () => {
    it('returns isError when the input is blank after trimming', async () => {
      const fetchMock = sequenceFetches([]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: '   ' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /must not be blank/);
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it('returns isError and skips SMHI when the geocoder returns zero results', async () => {
      const fetchMock = sequenceFetches([jsonResponse({ results: [] })]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'asdfqwerty-no-such-place' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Could not find a place matching "asdfqwerty-no-such-place"/);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('treats missing results array as not found', async () => {
      sequenceFetches([jsonResponse({})]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'nowhere' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Could not find a place/);
    });

    it('returns isError when the resolved place is outside Nordic/Baltic coverage', async () => {
      const fetchMock = sequenceFetches([jsonResponse(GEOCODE_PARIS)]);
      const ctx = makeCtx();
      const result = await tool.handler({ location: 'Paris' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Paris, France/);
      assert.match(textOf(result), /Nordic\/Baltic coverage/);
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('throws TransientError on geocoder HTTP 503', async () => {
      sequenceFetches([() => new Response('down', { status: 503 })]);
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ location: 'Stockholm' }, ctx),
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
        () => tool.handler({ location: 'Stockholm' }, ctx),
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
      const result = await tool.handler({ location: 'Remote island' }, ctx);
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
      const result = await tool.handler({ location: 'Stockholm' }, ctx);
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
        () => tool.handler({ location: 'Stockholm' }, ctx),
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
        () => tool.handler({ location: 'Stockholm' }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });
  });
});
