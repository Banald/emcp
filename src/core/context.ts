import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AuthenticatedKey, Queue, ToolContext } from '../tools/types.ts';

export function buildToolContext(input: {
  apiKey: AuthenticatedKey;
  toolName: string;
  requestId: string;
  signal: AbortSignal;
  pool: Pool;
  redis: Redis;
  queues: Readonly<Record<string, Queue>>;
  rootLogger: Logger;
}): ToolContext {
  const childLogger = input.rootLogger.child({
    request_id: input.requestId,
    tool_name: input.toolName,
    api_key_prefix: input.apiKey.prefix,
    api_key_id: input.apiKey.id,
  });

  return {
    logger: childLogger,
    db: input.pool,
    redis: input.redis,
    queues: input.queues,
    apiKey: input.apiKey,
    requestId: input.requestId,
    signal: input.signal,
  };
}
