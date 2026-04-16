import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface WorkerContext {
  readonly logger: Logger;
  readonly db: Pool;
  readonly redis: Redis;
}
