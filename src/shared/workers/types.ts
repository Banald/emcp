import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface WorkerContext {
  readonly logger: Logger;
  readonly db: Pool;
  readonly signal: AbortSignal;
}

export interface WorkerDefinition {
  readonly name: string;
  readonly description?: string;
  readonly schedule: string;
  readonly timezone?: string;
  readonly runOnStartup?: boolean;
  readonly timeoutMs?: number;
  readonly handler: (ctx: WorkerContext) => Promise<void>;
}
