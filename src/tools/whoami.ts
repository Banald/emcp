import type { CallToolResult, ToolContext, ToolDefinition } from './types.ts';

const inputSchema = {};

const tool: ToolDefinition<typeof inputSchema> = {
  name: 'whoami',
  title: 'Who Am I',
  description:
    'Returns information about the API key making this request: id, prefix, name, and configured rate limit. Use this to verify which credentials a session is using.',
  inputSchema,
  handler: async (_args, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info('whoami invoked');
    const payload = {
      id: ctx.apiKey.id,
      prefix: ctx.apiKey.prefix,
      name: ctx.apiKey.name,
      rate_limit_per_minute: ctx.apiKey.rateLimitPerMinute,
      request_id: ctx.requestId,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  },
};

export default tool;
