import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ZodObject, ZodRawShape, z } from 'zod';

export interface AuthenticatedKey {
  readonly id: string;
  readonly prefix: string;
  readonly name: string;
  readonly rateLimitPerMinute: number;
}

export interface ToolContext {
  readonly logger: Logger;
  readonly db: Pool;
  readonly redis: Redis;
  readonly apiKey: AuthenticatedKey;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface CallToolResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition<
  TInput extends ZodRawShape = ZodRawShape,
  TOutput extends ZodRawShape | undefined = undefined,
> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: TOutput;
  rateLimit?: { perMinute: number };
  requiresConfirmation?: boolean;
  tags?: string[];
  handler: (args: z.infer<ZodObject<TInput>>, ctx: ToolContext) => Promise<CallToolResult>;
}
