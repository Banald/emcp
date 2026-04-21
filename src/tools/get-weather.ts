import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const SMHI_BASE =
  'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point';
const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

// SMHI SNOW1gv1 coverage is the Nordic/Baltic region. If the geocoder tags
// the resolved place with a country code outside this set we short-circuit
// before hitting SMHI so the LLM gets a clear "not covered" message instead
// of a bare 404.
const NORDIC_BALTIC_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'SE',
  'NO',
  'FI',
  'DK',
  'IS',
  'EE',
  'LV',
  'LT',
]);

const CONDITIONS = [
  'sunny',
  'cloudy',
  'foggy',
  'raining',
  'snowing',
  'sleet',
  'thunderstorm',
  'unknown',
] as const;
type Condition = (typeof CONDITIONS)[number];

const inputSchema = {
  location: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'City, address, or place name to fetch weather for. Examples: "Stockholm", "Tromsø", "Kungsgatan 12, Göteborg". Resolved to coordinates via Open-Meteo geocoding. SMHI only covers the Nordic/Baltic region (SE/NO/FI/DK/IS/EE/LV/LT), so places outside that area return isError.',
    ),
};

const resolvedLocationSchema = z.object({
  name: z.string().describe('Place name as returned by the geocoder.'),
  country: z.string().nullable().describe('Country name as returned by the geocoder, or null.'),
  country_code: z
    .string()
    .nullable()
    .describe('ISO 3166-1 alpha-2 country code (uppercased), or null.'),
  latitude: z.number().describe('Resolved latitude in decimal degrees.'),
  longitude: z.number().describe('Resolved longitude in decimal degrees.'),
});

const outputSchema = {
  query: z.string().describe('The location string the caller passed in.'),
  resolved_location: resolvedLocationSchema.describe(
    'What Open-Meteo geocoding resolved the query to. Echo the name/country back to the user so they can correct ambiguous place names.',
  ),
  time: z.string().describe('ISO 8601 timestamp of the forecast step this snapshot is for.'),
  temperature_celsius: z
    .number()
    .nullable()
    .describe('Current air temperature in degrees Celsius, or null if unavailable.'),
  wind_speed_ms: z
    .number()
    .nullable()
    .describe('Current wind speed in metres per second, or null if unavailable.'),
  condition: z
    .enum(CONDITIONS)
    .describe(
      'Simple current weather condition bucketed from SMHI symbol codes: sunny, cloudy, foggy, raining, snowing, sleet, thunderstorm, or unknown.',
    ),
};

interface RawTimeStep {
  readonly time?: string;
  readonly data?: Record<string, number>;
}

interface RawForecast {
  readonly timeSeries?: readonly RawTimeStep[];
}

interface GeocodedLocation {
  readonly name: string;
  readonly country: string | null;
  readonly country_code: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

type GeocodeOutcome =
  | { readonly kind: 'ok'; readonly location: GeocodedLocation }
  | { readonly kind: 'not_found' };

interface RawGeocodeResult {
  readonly latitude?: number;
  readonly longitude?: number;
  readonly name?: string;
  readonly country?: string;
  readonly country_code?: string;
}

interface RawGeocodeBody {
  readonly results?: readonly RawGeocodeResult[];
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'get-weather',
  title: 'Get Weather',
  description:
    'Fetch the current weather for a city, address, or place name. The tool geocodes the location via Open-Meteo (CC BY 4.0) and then queries SMHI (the Swedish Meteorological and Hydrological Institute) using the SNOW1gv1 product. Coverage is the Nordic/Baltic region (Sweden, Norway, Finland, Denmark, Iceland, Estonia, Latvia, Lithuania); places outside this area return isError. The response is a compact snapshot: resolved place name, the forecast timestamp, current temperature (°C), wind speed (m/s), and a simple condition bucket (sunny, cloudy, foggy, raining, snowing, sleet, thunderstorm, unknown). Data is licensed CC BY 4.0 — attribute SMHI and Open-Meteo when displaying.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async ({ location }, ctx: ToolContext): Promise<CallToolResult> => {
    const query = location.trim();
    if (query.length === 0) {
      return {
        content: [{ type: 'text', text: 'Location must not be blank.' }],
        isError: true,
      };
    }

    const geocoded = await geocode(query, ctx.signal);
    if (geocoded.kind === 'not_found') {
      return {
        content: [
          {
            type: 'text',
            text: `Could not find a place matching "${query}". Try a more specific name (e.g. "Göteborg, Sweden" instead of "Gothenburg district").`,
          },
        ],
        isError: true,
      };
    }

    const place = geocoded.location;
    if (place.country_code !== null && !NORDIC_BALTIC_COUNTRY_CODES.has(place.country_code)) {
      const countryLabel = place.country ?? place.country_code;
      return {
        content: [
          {
            type: 'text',
            text: `"${query}" resolved to ${place.name}, ${countryLabel} — outside SMHI's Nordic/Baltic coverage area. SMHI SNOW1gv1 only covers Sweden, Norway, Finland, Denmark, Iceland, Estonia, Latvia, and Lithuania.`,
          },
        ],
        isError: true,
      };
    }

    const lat = round6(place.latitude);
    const lon = round6(place.longitude);
    // SMHI URL order is lon first, then lat. Easy to reverse — hold it in one place.
    const url = `${SMHI_BASE}/lon/${lon}/lat/${lat}/data.json`;

    let response: Response;
    try {
      response = await fetchExternal(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `SMHI request failed: ${err instanceof Error ? err.message : String(err)}`,
        'SMHI is temporarily unavailable. Please try again.',
      );
    }

    if (response.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text: `"${query}" resolved to ${place.name} (${lat}, ${lon}) but SMHI has no forecast for that point — it is likely outside the Nordic/Baltic coverage area.`,
          },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      throw new TransientError(
        `SMHI returned HTTP ${response.status}`,
        'SMHI is temporarily unavailable. Please try again.',
      );
    }

    const raw = (await response.json()) as RawForecast;
    const firstStep = raw.timeSeries?.[0];
    if (firstStep === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `SMHI returned an empty forecast series for ${place.name} (${lat}, ${lon}).`,
          },
        ],
        isError: true,
      };
    }

    const data = firstStep.data ?? {};
    const snapshot = {
      query,
      resolved_location: {
        name: place.name,
        country: place.country,
        country_code: place.country_code,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      time: firstStep.time ?? '',
      temperature_celsius: pickNumber(data, 'air_temperature'),
      wind_speed_ms: pickNumber(data, 'wind_speed'),
      condition: conditionFromSymbol(pickNumber(data, 'symbol_code')),
    };

    return {
      content: [{ type: 'text', text: formatText(snapshot) }],
      structuredContent: snapshot,
    };
  },
};

export default tool;

async function geocode(query: string, signal: AbortSignal): Promise<GeocodeOutcome> {
  const url = `${OPEN_METEO_GEOCODE}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;

  let response: Response;
  try {
    response = await fetchExternal(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } catch (err) {
    throw new TransientError(
      `Open-Meteo geocoding request failed: ${err instanceof Error ? err.message : String(err)}`,
      'Geocoding service is temporarily unavailable. Please try again.',
    );
  }

  if (!response.ok) {
    throw new TransientError(
      `Open-Meteo geocoding returned HTTP ${response.status}`,
      'Geocoding service is temporarily unavailable. Please try again.',
    );
  }

  const body = (await response.json()) as RawGeocodeBody;
  const top = body.results?.[0];
  if (
    top === undefined ||
    typeof top.latitude !== 'number' ||
    typeof top.longitude !== 'number' ||
    !Number.isFinite(top.latitude) ||
    !Number.isFinite(top.longitude)
  ) {
    return { kind: 'not_found' };
  }

  return {
    kind: 'ok',
    location: {
      name: typeof top.name === 'string' && top.name.length > 0 ? top.name : query,
      country: typeof top.country === 'string' && top.country.length > 0 ? top.country : null,
      country_code:
        typeof top.country_code === 'string' && top.country_code.length > 0
          ? top.country_code.toUpperCase()
          : null,
      latitude: top.latitude,
      longitude: top.longitude,
    },
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function pickNumber(data: Record<string, number>, key: string): number | null {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function conditionFromSymbol(code: number | null): Condition {
  if (code === null) return 'unknown';
  switch (code) {
    case 1:
    case 2:
      return 'sunny';
    case 3:
    case 4:
    case 5:
    case 6:
      return 'cloudy';
    case 7:
      return 'foggy';
    case 8:
    case 9:
    case 10:
    case 18:
    case 19:
    case 20:
      return 'raining';
    case 11:
    case 21:
      return 'thunderstorm';
    case 12:
    case 13:
    case 14:
    case 22:
    case 23:
    case 24:
      return 'sleet';
    case 15:
    case 16:
    case 17:
    case 25:
    case 26:
    case 27:
      return 'snowing';
    default:
      return 'unknown';
  }
}

interface Snapshot {
  readonly query: string;
  readonly resolved_location: {
    readonly name: string;
    readonly country: string | null;
    readonly country_code: string | null;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly time: string;
  readonly temperature_celsius: number | null;
  readonly wind_speed_ms: number | null;
  readonly condition: Condition;
}

function formatText(s: Snapshot): string {
  const place = s.resolved_location;
  const countryLabel = place.country ?? place.country_code ?? 'unknown country';
  const temp = s.temperature_celsius === null ? 'n/a' : `${s.temperature_celsius} °C`;
  const wind = s.wind_speed_ms === null ? 'n/a' : `${s.wind_speed_ms} m/s`;
  return `Weather for "${s.query}" → ${place.name}, ${countryLabel} at ${s.time}: ${temp}, wind ${wind}, ${s.condition}.`;
}
