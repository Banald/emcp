import { z } from 'zod';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const formatEnum = z.enum(['iso', 'human', 'both']);

const inputSchema = {
  timezone: z
    .string()
    .min(1)
    .max(80)
    .default('UTC')
    .describe(
      'IANA time zone name (e.g. "Europe/Stockholm", "America/New_York", "UTC"). Defaults to UTC. Unknown zones return isError.',
    ),
  format: formatEnum
    .default('both')
    .describe(
      'Which textual representations to include in the content block. "iso" (8601 only), "human" (weekday + date + time + zone), or "both".',
    ),
};

const outputSchema = {
  utc_iso: z
    .string()
    .describe('ISO 8601 timestamp in UTC with trailing Z (e.g. "2026-04-17T12:34:56.000Z").'),
  local_iso: z
    .string()
    .describe(
      'ISO 8601 timestamp in the requested timezone with numeric offset (e.g. "2026-04-17T14:34:56+02:00").',
    ),
  timezone: z.string().describe('The IANA timezone that was resolved.'),
  offset: z.string().describe('Current UTC offset for the timezone, formatted as ±HH:MM.'),
  offset_minutes: z
    .number()
    .int()
    .describe('Current UTC offset in minutes. Positive east of UTC, negative west.'),
  weekday: z
    .string()
    .describe(
      'Weekday name in English (e.g. "Friday"). Computed against the caller-provided timezone.',
    ),
  date: z.string().describe('Local date as YYYY-MM-DD (in the caller-provided timezone).'),
  time: z
    .string()
    .describe('Local time as HH:MM:SS in 24-hour clock (in the caller-provided timezone).'),
  unix_ms: z
    .number()
    .int()
    .describe('Unix time in milliseconds since the epoch (UTC; timezone-independent).'),
  is_dst: z
    .boolean()
    .describe('True when the timezone is currently observing daylight saving time.'),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'get-current-datetime',
  title: 'Get Current Datetime',
  description:
    'Returns the server\'s current wall-clock time, normalized to UTC and a caller-specified IANA timezone (default UTC). Useful when the assistant needs authoritative "right now" for planning, timestamping, or recency reasoning — the server clock is the authority, not the model\'s training data. Output exposes UTC and local ISO 8601 strings, the UTC offset, weekday, Unix milliseconds, and a DST flag. Unknown time zones return isError instead of throwing.',
  inputSchema,
  outputSchema,
  handler: async ({ timezone, format }, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info({ timezone, format }, 'get-current-datetime invoked');

    if (!isValidTimeZone(timezone)) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown timezone "${timezone}". Pass a valid IANA zone such as "UTC", "Europe/Stockholm", or "America/New_York".`,
          },
        ],
        isError: true,
      };
    }

    const now = new Date();
    const snapshot = buildSnapshot(now, timezone);
    const text = formatText(snapshot, format);

    return {
      content: [{ type: 'text', text }],
      structuredContent: snapshot,
    };
  },
};

export default tool;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function getOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value;
  return parseLongOffset(raw);
}

export function parseLongOffset(raw: string | undefined): number {
  if (raw === undefined || raw === 'GMT' || raw === 'UTC') return 0;
  const match = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = match[3] !== undefined ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}

export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

interface DateSnapshot extends Record<string, unknown> {
  utc_iso: string;
  local_iso: string;
  timezone: string;
  offset: string;
  offset_minutes: number;
  weekday: string;
  date: string;
  time: string;
  unix_ms: number;
  is_dst: boolean;
}

function buildSnapshot(now: Date, timeZone: string): DateSnapshot {
  const offsetMinutes = getOffsetMinutes(now, timeZone);
  const offset = formatOffset(offsetMinutes);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  let hour = pick('hour');
  if (hour === '24') hour = '00';

  const date = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const time = `${hour}:${pick('minute')}:${pick('second')}`;
  const localIso = `${date}T${time}${offset}`;

  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);

  return {
    utc_iso: now.toISOString(),
    local_iso: localIso,
    timezone: timeZone,
    offset,
    offset_minutes: offsetMinutes,
    weekday,
    date,
    time,
    unix_ms: now.getTime(),
    is_dst: isDst(now, timeZone, offsetMinutes),
  };
}

function isDst(now: Date, timeZone: string, currentOffset: number): boolean {
  const year = now.getUTCFullYear();
  const jan = getOffsetMinutes(new Date(Date.UTC(year, 0, 1, 12)), timeZone);
  const jul = getOffsetMinutes(new Date(Date.UTC(year, 6, 1, 12)), timeZone);
  if (jan === jul) return false;
  return currentOffset === Math.max(jan, jul);
}

function formatText(snapshot: DateSnapshot, format: z.infer<typeof formatEnum>): string {
  const lines: string[] = [];
  if (format === 'iso' || format === 'both') {
    lines.push(`UTC:   ${snapshot.utc_iso}`);
    lines.push(`Local: ${snapshot.local_iso}   (${snapshot.timezone}, UTC${snapshot.offset})`);
  }
  if (format === 'human' || format === 'both') {
    lines.push(
      `Human: ${snapshot.weekday}, ${snapshot.date}, ${snapshot.time} ${snapshot.timezone} (UTC${snapshot.offset})`,
    );
  }
  lines.push(`Unix ms: ${snapshot.unix_ms}`);
  lines.push(`DST: ${snapshot.is_dst ? 'active' : 'not active'}`);
  return lines.join('\n');
}
