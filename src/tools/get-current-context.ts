import { z } from 'zod';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const inputSchema = {};

const outputSchema = {
  current_datetime: z
    .string()
    .describe(
      'Server wall-clock time in UTC, ISO 8601 with second precision and trailing Z (e.g. "2026-04-21T14:32:00Z").',
    ),
  months_since_likely_training_cutoff: z
    .string()
    .describe(
      "Human-readable hint about how stale the model's training data is likely to be relative to the current server time.",
    ),
  reminders: z
    .array(z.string())
    .describe(
      'Concrete reminders the caller should keep in mind while reasoning about anything time-sensitive.',
    ),
};

const REMINDERS: readonly string[] = [
  'Software versions, prices, leadership positions, and laws may have changed since your training data',
  "When asked about 'current' anything, either call a search tool or explicitly state your information may be outdated",
  "Do not assume events you don't know about didn't happen — you may simply not have been trained on them",
];

const TRAINING_CUTOFF_HINT = 'varies (typically 6-18 months)';

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'get-current-context',
  title: 'Get Current Context',
  description:
    'REQUIRED: Call this at the start of every session to ground yourself in the current date and time. Your training cutoff is NOT the current date. Time has continued to pass since your training ended. Call this before reasoning about anything time-sensitive.',
  inputSchema,
  outputSchema,
  handler: async (_args, _ctx: ToolContext): Promise<CallToolResult> => {
    const payload = {
      current_datetime: toSecondPrecisionIso(new Date()),
      months_since_likely_training_cutoff: TRAINING_CUTOFF_HINT,
      reminders: [...REMINDERS],
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
};

export default tool;

export function toSecondPrecisionIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
