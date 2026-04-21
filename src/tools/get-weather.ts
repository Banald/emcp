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

const inputSchema = {
  location: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'City, address, or place name to fetch weather for. Examples: "Stockholm", "Tromsø", "Kungsgatan 12, Göteborg". Resolved to coordinates via Open-Meteo geocoding. SMHI only covers the Nordic/Baltic region (SE/NO/FI/DK/IS/EE/LV/LT), so places outside that area return isError.',
    ),
  steps: z
    .number()
    .int()
    .min(1)
    .max(96)
    .default(24)
    .describe(
      'How many forecast steps to return from the series (default 24). The first ~24 steps are 1-hour, later steps are 3/6/12-hour.',
    ),
};

const stepSchema = z.object({
  time: z.string(),
  air_temperature: z.number().nullable(),
  wind_speed: z.number().nullable(),
  wind_from_direction: z.number().nullable(),
  wind_speed_of_gust: z.number().nullable(),
  relative_humidity: z.number().nullable(),
  air_pressure_at_mean_sea_level: z.number().nullable(),
  visibility_in_air: z.number().nullable(),
  cloud_area_fraction: z.number().nullable(),
  precipitation_amount_mean: z.number().nullable(),
  precipitation_amount_min: z.number().nullable(),
  precipitation_amount_max: z.number().nullable(),
  predominant_precipitation_type_at_surface: z.number().nullable(),
  thunderstorm_probability: z.number().nullable(),
  symbol_code: z.number().nullable(),
  symbol_label: z.string().nullable(),
});

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
  approved_time: z.string().describe('ISO 8601 timestamp when the forecast was approved.'),
  reference_time: z.string().describe('ISO 8601 timestamp of the forecast reference.'),
  latitude: z.number().describe('Latitude used for the SMHI lookup (rounded).'),
  longitude: z.number().describe('Longitude used for the SMHI lookup (rounded).'),
  geometry_coordinates: z
    .array(z.number())
    .describe('The [longitude, latitude] reported by SMHI (may snap to the ~2.5 km grid).'),
  now: stepSchema.describe('Condensed snapshot built from timeSeries[0].'),
  series: z.array(stepSchema).describe('The first N forecast steps (N = steps).'),
};

interface RawTimeStep {
  readonly time?: string;
  readonly data?: Record<string, number>;
}

interface RawForecast {
  readonly approvedTime?: string;
  readonly referenceTime?: string;
  readonly geometry?: { readonly type?: string; readonly coordinates?: readonly number[] };
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
    'Fetch a point forecast for a city, address, or place name. The tool geocodes the location via Open-Meteo (CC BY 4.0) and then queries SMHI (the Swedish Meteorological and Hydrological Institute) using the SNOW1gv1 product. Coverage is the Nordic/Baltic region (Sweden, Norway, Finland, Denmark, Iceland, Estonia, Latvia, Lithuania); places outside this area return isError. The response includes the resolved place name, approved/reference times, a "now" snapshot (temperature, wind, humidity, precipitation, cloud cover, WMO-style weather symbol label) and a configurable number of forecast steps. Data is licensed CC BY 4.0 — attribute SMHI and Open-Meteo when displaying.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async ({ location, steps }, ctx: ToolContext): Promise<CallToolResult> => {
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

    const allSteps = (raw.timeSeries ?? []).map(normalizeStep);
    const nowStep = allSteps[0];
    if (nowStep === undefined) {
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

    const series = allSteps.slice(0, steps);

    const snapshot = {
      query,
      resolved_location: {
        name: place.name,
        country: place.country,
        country_code: place.country_code,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      approved_time: raw.approvedTime ?? '',
      reference_time: raw.referenceTime ?? '',
      latitude: lat,
      longitude: lon,
      geometry_coordinates: Array.isArray(raw.geometry?.coordinates)
        ? [...raw.geometry.coordinates]
        : [lon, lat],
      now: nowStep,
      series,
    };

    const text = formatText(snapshot);

    return {
      content: [{ type: 'text', text }],
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

interface ForecastStep {
  readonly time: string;
  readonly air_temperature: number | null;
  readonly wind_speed: number | null;
  readonly wind_from_direction: number | null;
  readonly wind_speed_of_gust: number | null;
  readonly relative_humidity: number | null;
  readonly air_pressure_at_mean_sea_level: number | null;
  readonly visibility_in_air: number | null;
  readonly cloud_area_fraction: number | null;
  readonly precipitation_amount_mean: number | null;
  readonly precipitation_amount_min: number | null;
  readonly precipitation_amount_max: number | null;
  readonly predominant_precipitation_type_at_surface: number | null;
  readonly thunderstorm_probability: number | null;
  readonly symbol_code: number | null;
  readonly symbol_label: string | null;
}

export function normalizeStep(step: RawTimeStep): ForecastStep {
  const data = step.data ?? {};
  const symbol = pickNumber(data, 'symbol_code');
  return {
    time: step.time ?? '',
    air_temperature: pickNumber(data, 'air_temperature'),
    wind_speed: pickNumber(data, 'wind_speed'),
    wind_from_direction: pickNumber(data, 'wind_from_direction'),
    wind_speed_of_gust: pickNumber(data, 'wind_speed_of_gust'),
    relative_humidity: pickNumber(data, 'relative_humidity'),
    air_pressure_at_mean_sea_level: pickNumber(data, 'air_pressure_at_mean_sea_level'),
    visibility_in_air: pickNumber(data, 'visibility_in_air'),
    cloud_area_fraction: pickNumber(data, 'cloud_area_fraction'),
    precipitation_amount_mean: pickNumber(data, 'precipitation_amount_mean'),
    precipitation_amount_min: pickNumber(data, 'precipitation_amount_min'),
    precipitation_amount_max: pickNumber(data, 'precipitation_amount_max'),
    predominant_precipitation_type_at_surface: pickNumber(
      data,
      'predominant_precipitation_type_at_surface',
    ),
    thunderstorm_probability: pickNumber(data, 'thunderstorm_probability'),
    symbol_code: symbol,
    symbol_label: symbol === null ? null : labelForSymbol(symbol),
  };
}

export function pickNumber(data: Record<string, number>, key: string): number | null {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function labelForSymbol(code: number): string {
  return SYMBOL_LABELS[code] ?? `unknown (${code})`;
}

const SYMBOL_LABELS: Record<number, string> = {
  1: 'Clear sky',
  2: 'Nearly clear',
  3: 'Variable cloudiness',
  4: 'Half clear',
  5: 'Cloudy',
  6: 'Overcast',
  7: 'Fog',
  8: 'Light rain showers',
  9: 'Moderate rain showers',
  10: 'Heavy rain showers',
  11: 'Thunderstorm',
  12: 'Light sleet showers',
  13: 'Moderate sleet showers',
  14: 'Heavy sleet showers',
  15: 'Light snow showers',
  16: 'Moderate snow showers',
  17: 'Heavy snow showers',
  18: 'Light rain',
  19: 'Moderate rain',
  20: 'Heavy rain',
  21: 'Thunder',
  22: 'Light sleet',
  23: 'Moderate sleet',
  24: 'Heavy sleet',
  25: 'Light snowfall',
  26: 'Moderate snowfall',
  27: 'Heavy snowfall',
};

interface Snapshot {
  readonly query: string;
  readonly resolved_location: {
    readonly name: string;
    readonly country: string | null;
    readonly country_code: string | null;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly approved_time: string;
  readonly reference_time: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly now: ForecastStep;
  readonly series: readonly ForecastStep[];
}

function formatText(s: Snapshot): string {
  const n = s.now;
  const place = s.resolved_location;
  const countryLabel = place.country ?? place.country_code ?? 'unknown country';
  const lines: string[] = [];
  lines.push(
    `SMHI forecast for "${s.query}" → ${place.name}, ${countryLabel} (${s.latitude}, ${s.longitude})`,
  );
  lines.push(`Approved: ${s.approved_time}    Reference: ${s.reference_time}`);
  lines.push('');
  lines.push(`Now — ${n.time}`);
  lines.push(`  Weather:       ${n.symbol_label ?? 'n/a'} (code ${n.symbol_code ?? 'n/a'})`);
  lines.push(
    `  Temperature:   ${fmtNum(n.air_temperature)} °C    Humidity: ${fmtNum(n.relative_humidity)} %`,
  );
  lines.push(
    `  Wind:          ${fmtNum(n.wind_speed)} m/s from ${fmtNum(n.wind_from_direction)}° (gusts ${fmtNum(n.wind_speed_of_gust)} m/s)`,
  );
  lines.push(
    `  Precipitation: ${fmtNum(n.precipitation_amount_mean)} mm    Cloud cover: ${fmtNum(n.cloud_area_fraction)}`,
  );
  lines.push(`  Pressure:      ${fmtNum(n.air_pressure_at_mean_sea_level)} hPa`);
  lines.push('');
  lines.push(`Forecast — next ${s.series.length} steps:`);
  for (const step of s.series) {
    lines.push(
      `  ${step.time}  ${fmtNum(step.air_temperature)}°C  wind ${fmtNum(step.wind_speed)} m/s  ${step.symbol_label ?? 'n/a'}`,
    );
  }
  return lines.join('\n');
}

export function fmtNum(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}
