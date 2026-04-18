import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const SMHI_BASE =
  'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point';

const inputSchema = {
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe('Latitude in decimal degrees (-90..90). Rounded to 6 decimal places.'),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe('Longitude in decimal degrees (-180..180). Rounded to 6 decimal places.'),
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

const outputSchema = {
  approved_time: z.string().describe('ISO 8601 timestamp when the forecast was approved.'),
  reference_time: z.string().describe('ISO 8601 timestamp of the forecast reference.'),
  latitude: z.number().describe('Echo of the requested latitude (rounded).'),
  longitude: z.number().describe('Echo of the requested longitude (rounded).'),
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

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'get-weather',
  title: 'Get Weather',
  description:
    'Fetch a point forecast from SMHI (the Swedish Meteorological and Hydrological Institute) using the SNOW1gv1 product (replaced the retired PMP3gv2 on 2026-03-31). Coverage is the Nordic/Baltic region; coordinates outside this area return isError. Output includes approved/reference times, a "now" snapshot (temperature, wind, humidity, precipitation, cloud cover, WMO-style weather symbol label) and a configurable number of forecast steps. Data is licensed CC BY 4.0 — attribute SMHI when displaying.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async ({ latitude, longitude, steps }, ctx: ToolContext): Promise<CallToolResult> => {
    const lat = round6(latitude);
    const lon = round6(longitude);
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
            text: `No SMHI forecast for (${lat}, ${lon}). Coordinates are likely outside the Nordic/Baltic coverage area.`,
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
            text: `SMHI returned an empty forecast series for (${lat}, ${lon}).`,
          },
        ],
        isError: true,
      };
    }

    const series = allSteps.slice(0, steps);

    const snapshot = {
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
  readonly approved_time: string;
  readonly reference_time: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly now: ForecastStep;
  readonly series: readonly ForecastStep[];
}

function formatText(s: Snapshot): string {
  const n = s.now;
  const lines: string[] = [];
  lines.push(`SMHI forecast for (${s.latitude}, ${s.longitude})`);
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
