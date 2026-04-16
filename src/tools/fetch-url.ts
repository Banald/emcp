import { z } from 'zod';
import type { CallToolResult, ToolContext, ToolDefinition } from './types.ts';

const inputSchema = {
  url: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const p = new URL(u).protocol;
          return p === 'http:' || p === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'only http and https URLs are allowed' },
    )
    .describe('The URL to fetch'),
};

// TODO(phase-7): block private IP ranges and link-local addresses (SSRF defense)

const tool: ToolDefinition<typeof inputSchema> = {
  name: 'fetch-url',
  title: 'Fetch URL',
  description:
    'Enqueue a background job to fetch the given URL and store the response body in the database. Returns the job ID immediately; use a follow-up tool or query to retrieve the fetched content.',
  inputSchema,
  rateLimit: { perMinute: 10 },
  handler: async ({ url }, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info({ url }, 'fetch-url enqueueing');
    const job = await ctx.queues.fetch.add('fetch', {
      url,
      apiKeyId: ctx.apiKey.id,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ jobId: job.id, url, status: 'queued' }),
        },
      ],
    };
  },
};

export default tool;
