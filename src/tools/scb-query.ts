import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 30_000;
const SCB_BASE = 'https://api.scb.se/OV0104/v1/doris';
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]*[A-Za-z0-9]$/;

const languageEnum = z.enum(['sv', 'en']);
const modeEnum = z.enum(['metadata', 'data']);
const formatEnum = z.enum(['json', 'json-stat2']);
const filterEnum = z.enum(['item', 'all', 'top', 'agg', 'vs']);

const queryEntrySchema = z.object({
  code: z
    .string()
    .min(1)
    .max(100)
    .describe('Variable code exactly as returned by the metadata (case-sensitive, e.g. "Region").'),
  values: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(500)
    .describe(
      'Selected values (for filter="item"), codes for aggregations, or "*" wildcards depending on filter.',
    ),
  filter: filterEnum
    .default('item')
    .describe(
      'Selection filter: "item" (exact codes), "all" (wildcard like "*" or "01*"), "top" (N most recent codes), "agg" (named aggregation), "vs" (alternative value set).',
    ),
});

const inputSchema = {
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(PATH_RE, { message: 'path must contain only A-Z, a-z, 0-9, /, _, - characters' })
    .refine((p) => !p.includes('..'), { message: 'path must not contain ".."' })
    .refine((p) => !p.includes('//'), { message: 'path must not contain "//"' })
    .describe(
      'Table or folder path beneath /ssd/, e.g. "BE/BE0101/BE0101A/BefolkningNy". Case-sensitive. Must not contain ".." or leading/trailing slashes.',
    ),
  language: languageEnum
    .default('en')
    .describe('SCB response language: "sv" or "en" (affects valueTexts and labels). Default "en".'),
  mode: modeEnum
    .default('metadata')
    .describe(
      'Operation mode: "metadata" (GET — returns the table\'s variables and allowed values) or "data" (POST — returns actual data rows). Default "metadata".',
    ),
  query: z
    .array(queryEntrySchema)
    .max(50)
    .optional()
    .describe(
      'Required when mode="data": selection per variable. Each entry pairs a code with its chosen values and filter.',
    ),
  format: formatEnum
    .default('json')
    .describe(
      'Data response format: "json" (legacy px-json with columns+data arrays) or "json-stat2" (JSON-stat 2.0). Ignored in metadata mode.',
    ),
};

const variableSchema = z.object({
  code: z.string(),
  text: z.string(),
  values: z.array(z.string()),
  value_texts: z.array(z.string()),
  elimination: z.boolean(),
  time: z.boolean(),
});

const columnSchema = z.object({
  code: z.string(),
  text: z.string(),
  type: z.string(),
  unit: z.string().nullable(),
});

const rowSchema = z.object({
  key: z.array(z.string()),
  values: z.array(z.string()),
});

const outputSchema = {
  mode: modeEnum.describe('Echoes the requested mode.'),
  path: z.string().describe('Echo of the requested table path.'),
  language: languageEnum.describe('Echo of the requested language.'),
  title: z.string().nullable().describe('Table title (metadata mode only; null in data mode).'),
  variables: z
    .array(variableSchema)
    .describe('Variable metadata (populated only in metadata mode; empty in data mode).'),
  columns: z
    .array(columnSchema)
    .describe('Column metadata (populated only in data mode; empty in metadata mode).'),
  rows: z
    .array(rowSchema)
    .describe('Data rows (populated only in data mode; empty in metadata mode).'),
  raw_format: z
    .string()
    .nullable()
    .describe('Response format that was requested from SCB, or null for metadata.'),
};

interface MetadataResponse {
  readonly title?: string;
  readonly variables?: readonly {
    readonly code?: string;
    readonly text?: string;
    readonly values?: readonly string[];
    readonly valueTexts?: readonly string[];
    readonly elimination?: boolean;
    readonly time?: boolean;
  }[];
}

interface DataResponse {
  readonly columns?: readonly {
    readonly code?: string;
    readonly text?: string;
    readonly type?: string;
    readonly unit?: string;
  }[];
  readonly data?: readonly {
    readonly key?: readonly string[];
    readonly values?: readonly string[];
  }[];
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'scb-query',
  title: 'SCB PxWeb Query',
  description:
    'Query the Swedish national statistics database (Statistikdatabasen / SCB PxWeb v1). Use mode="metadata" (GET) to inspect a table\'s variables and allowed values, or mode="data" (POST) to fetch actual rows. Paths are case-sensitive (e.g. "BE/BE0101/BE0101A/BefolkningNy"). Throttled to 30/min to respect the upstream 30-req/10s cap. On cell-limit overflow (HTTP 403) the tool returns isError with a hint to filter more tightly; on rate limiting (HTTP 429) it throws TransientError.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async (
    { path, language, mode, query, format },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    if (mode === 'data' && (query === undefined || query.length === 0)) {
      return {
        content: [
          {
            type: 'text',
            text: 'scb-query mode="data" requires a non-empty query array. Pass at least one { code, values } entry.',
          },
        ],
        isError: true,
      };
    }

    const url = `${SCB_BASE}/${language}/ssd/${path}`;
    const init: RequestInit =
      mode === 'data'
        ? {
            method: 'POST',
            headers: {
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              query: (query ?? []).map((q) => ({
                code: q.code,
                selection: { filter: q.filter, values: q.values },
              })),
              response: { format },
            }),
          }
        : {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          };

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
    } catch (err) {
      throw new TransientError(
        `SCB request failed: ${err instanceof Error ? err.message : String(err)}`,
        'SCB is temporarily unavailable. Please try again.',
      );
    }

    if (response.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text: `SCB returned 404 for path "${path}" (language ${language}). Confirm the path case-sensitively and that the table exists under /ssd/.`,
          },
        ],
        isError: true,
      };
    }

    if (response.status === 403) {
      return {
        content: [
          {
            type: 'text',
            text: `SCB returned 403 — the query likely exceeds the cell limit (~50 000 cells on v1). Narrow the selection by using fewer values or splitting across Region/Tid.`,
          },
        ],
        isError: true,
      };
    }

    if (response.status === 429) {
      throw new TransientError(
        `SCB rate-limited the request (429)`,
        'SCB rate-limited the request. Please slow down and retry.',
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `SCB returned HTTP ${response.status}`,
        'SCB is temporarily unavailable. Please try again.',
      );
    }

    if (mode === 'metadata') {
      const data = (await response.json()) as MetadataResponse;
      const snapshot = {
        mode: 'metadata' as const,
        path,
        language,
        title: data.title ?? null,
        variables: normalizeVariables(data),
        columns: [],
        rows: [],
        raw_format: null,
      };
      return {
        content: [{ type: 'text', text: formatMetadataText(snapshot) }],
        structuredContent: snapshot,
      };
    }

    const data = (await response.json()) as DataResponse;
    const columns = normalizeColumns(data);
    const rows = normalizeRows(data);
    const snapshot = {
      mode: 'data' as const,
      path,
      language,
      title: null,
      variables: [],
      columns,
      rows,
      raw_format: format,
    };
    return {
      content: [{ type: 'text', text: formatDataText(snapshot) }],
      structuredContent: snapshot,
    };
  },
};

export default tool;

export function normalizeVariables(data: MetadataResponse): Array<{
  code: string;
  text: string;
  values: string[];
  value_texts: string[];
  elimination: boolean;
  time: boolean;
}> {
  return (data.variables ?? []).map((v) => ({
    code: v.code ?? '',
    text: v.text ?? '',
    values: Array.from(v.values ?? []),
    value_texts: Array.from(v.valueTexts ?? []),
    elimination: v.elimination ?? false,
    time: v.time ?? false,
  }));
}

export function normalizeColumns(data: DataResponse): Array<{
  code: string;
  text: string;
  type: string;
  unit: string | null;
}> {
  return (data.columns ?? []).map((c) => ({
    code: c.code ?? '',
    text: c.text ?? '',
    type: c.type ?? '',
    unit: c.unit ?? null,
  }));
}

export function normalizeRows(data: DataResponse): Array<{ key: string[]; values: string[] }> {
  return (data.data ?? []).map((r) => ({
    key: Array.from(r.key ?? []),
    values: Array.from(r.values ?? []),
  }));
}

export interface MetadataSnapshot {
  readonly mode: 'metadata';
  readonly path: string;
  readonly language: string;
  readonly title: string | null;
  readonly variables: ReadonlyArray<{
    readonly code: string;
    readonly text: string;
    readonly values: readonly string[];
    readonly value_texts: readonly string[];
    readonly elimination: boolean;
    readonly time: boolean;
  }>;
}

export function formatMetadataText(s: MetadataSnapshot): string {
  const lines: string[] = [];
  lines.push(`SCB metadata — ${s.path} (${s.language})`);
  if (s.title) lines.push(`Title: ${s.title}`);
  for (const v of s.variables) {
    lines.push('');
    lines.push(
      `• ${v.code} (${v.text})${v.time ? ' [time]' : ''}${v.elimination ? ' [eliminable]' : ''}`,
    );
    const sampleCount = Math.min(v.values.length, 5);
    const sample = v.values
      .slice(0, sampleCount)
      .map((code, i) => `${code}="${v.value_texts[i] ?? code}"`)
      .join(', ');
    lines.push(`    ${v.values.length} values; first ${sampleCount}: ${sample}`);
  }
  return lines.join('\n');
}

export interface DataSnapshot {
  readonly mode: 'data';
  readonly path: string;
  readonly language: string;
  readonly columns: ReadonlyArray<{
    readonly code: string;
    readonly text: string;
    readonly type: string;
    readonly unit: string | null;
  }>;
  readonly rows: ReadonlyArray<{
    readonly key: readonly string[];
    readonly values: readonly string[];
  }>;
  readonly raw_format: string;
}

export function formatDataText(s: DataSnapshot): string {
  const lines: string[] = [];
  lines.push(`SCB data — ${s.path} (${s.language}, format=${s.raw_format})`);
  lines.push(`Columns: ${s.columns.map((c) => `${c.code}(${c.type})`).join(', ') || '(none)'}`);
  lines.push(`Rows: ${s.rows.length}`);
  const sampleCount = Math.min(s.rows.length, 10);
  for (const r of s.rows.slice(0, sampleCount)) {
    lines.push(`  [${r.key.join(', ')}] → ${r.values.join(', ')}`);
  }
  if (s.rows.length > sampleCount) {
    lines.push(`  … (${s.rows.length - sampleCount} more rows)`);
  }
  return lines.join('\n');
}
