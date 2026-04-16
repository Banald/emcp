import type { Job } from 'bullmq';
import type { FetchJobData, FetchJobResult } from '../queues.ts';
import type { WorkerContext } from '../types.ts';

const MAX_STORED_BYTES = 1_048_576; // 1 MB
const FETCH_TIMEOUT_MS = 15_000;

export async function fetchUrlProcessor(
  job: Job<FetchJobData, FetchJobResult>,
  ctx: WorkerContext,
): Promise<FetchJobResult> {
  const { url, apiKeyId } = job.data;
  const log = ctx.logger.child({ job_id: job.id, url });
  log.info('fetch starting');

  // Validate URL (defense in depth — the tool already validated)
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  // TODO(phase-7): block private IP ranges and link-local addresses (SSRF defense)

  await job.updateProgress(10);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timeout);
  }

  await job.updateProgress(60);

  const body = await response.text();
  const bytes = Buffer.byteLength(body, 'utf8');

  // Cap stored body at 1 MB to avoid runaway storage
  const stored = bytes > MAX_STORED_BYTES ? body.slice(0, MAX_STORED_BYTES) : body;

  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO fetched_resources (url, status_code, content_type, body, bytes, fetched_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [url, response.status, response.headers.get('content-type'), stored, bytes, apiKeyId],
  );

  await job.updateProgress(100);
  log.info({ resource_id: rows[0].id, status: response.status, bytes }, 'fetch complete');
  return { resourceId: rows[0].id, statusCode: response.status, bytes };
}
