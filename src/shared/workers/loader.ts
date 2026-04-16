import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cron } from 'croner';
import { ConfigError } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import type { WorkerDefinition } from './types.ts';

const WORKER_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const EXCLUDED_FILENAMES = new Set(['types.ts', 'loader.ts', 'scheduler.ts', 'index.ts']);

function isExcluded(filename: string): boolean {
  if (EXCLUDED_FILENAMES.has(filename)) return true;
  if (filename.endsWith('.test.ts')) return true;
  if (filename.startsWith('_')) return true;
  return false;
}

function hasRequiredFields(obj: unknown): obj is {
  name: string;
  schedule: string;
  handler: (...args: never[]) => unknown;
} {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    typeof record.schedule === 'string' &&
    typeof record.handler === 'function'
  );
}

export interface WorkerRegistry {
  list(): readonly WorkerDefinition[];
  get(name: string): WorkerDefinition | undefined;
}

export async function loadWorkers(workersDir: string): Promise<WorkerRegistry> {
  const entries = await readdir(workersDir, { recursive: true });
  const workers = new Map<string, WorkerDefinition>();
  const nameToFile = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;

    const parts = entry.split('/');
    const filename = parts[parts.length - 1] ?? entry;
    if (isExcluded(filename)) continue;

    const fullPath = join(workersDir, entry);
    const relPath = relative(workersDir, fullPath);

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(fullPath).href)) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(
        `Failed to import worker file "${relPath}": ${err instanceof Error ? err.message : String(err)}`,
        'Worker loading error.',
      );
    }

    const worker = mod.default;
    if (worker === undefined) {
      throw new ConfigError(
        `Worker file "${relPath}" has no default export`,
        'Worker loading error.',
      );
    }

    if (!hasRequiredFields(worker)) {
      throw new ConfigError(
        `Worker file "${relPath}" default export is missing required fields (name, schedule, handler)`,
        'Worker loading error.',
      );
    }

    if (!WORKER_NAME_REGEX.test(worker.name)) {
      throw new ConfigError(
        `Worker file "${relPath}" has invalid name "${worker.name}" — must match /^[a-z][a-z0-9-]*$/`,
        'Worker loading error.',
      );
    }

    const existingFile = nameToFile.get(worker.name);
    if (existingFile !== undefined) {
      throw new ConfigError(
        `Duplicate worker name "${worker.name}" in "${relPath}" and "${existingFile}"`,
        'Worker loading error.',
      );
    }

    try {
      const probe = new Cron(worker.schedule, { paused: true });
      probe.stop();
    } catch (err) {
      throw new ConfigError(
        `Worker file "${relPath}" has an invalid schedule "${worker.schedule}": ${err instanceof Error ? err.message : String(err)}`,
        'Worker loading error.',
      );
    }

    const def = worker as WorkerDefinition;
    workers.set(def.name, def);
    nameToFile.set(def.name, relPath);
    logger.debug({ worker: def.name, file: relPath, schedule: def.schedule }, 'loaded worker');
  }

  return {
    list: () => [...workers.values()],
    get: (name: string) => workers.get(name),
  };
}
