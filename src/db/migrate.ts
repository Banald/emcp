import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runner } from 'node-pg-migrate';
import { config } from '../config.ts';
import { logger } from '../lib/logger.ts';
import { createPool } from './client.ts';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

async function listMigrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR);
    return entries.filter((f) => /\.(sql|cjs|mjs|js|ts)$/.test(f)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function queryApplied(): Promise<Set<string>> {
  const pool = createPool();
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on`,
    );
    return new Set(rows.map((r) => r.name));
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return new Set();
    throw err;
  } finally {
    await pool.end();
  }
}

async function up(count?: number): Promise<void> {
  await runner({
    databaseUrl: config.databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    ...(count === undefined ? {} : { count }),
    migrationsTable: MIGRATIONS_TABLE,
    verbose: false,
  });
}

async function down(count: number): Promise<void> {
  await runner({
    databaseUrl: config.databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'down',
    count,
    migrationsTable: MIGRATIONS_TABLE,
    verbose: false,
  });
}

async function status(): Promise<void> {
  const files = await listMigrationFiles();
  if (files.length === 0) {
    process.stdout.write('no migrations\n');
    return;
  }
  const applied = await queryApplied();
  for (const file of files) {
    const name = file.replace(/\.[^.]+$/, '');
    const state = applied.has(name) ? 'applied' : 'pending';
    process.stdout.write(`${state.padEnd(8)} ${file}\n`);
  }
}

function printUsageAndExit(): never {
  process.stderr.write('Usage: migrate <up|down|status> [count]\n');
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0];
  try {
    switch (command) {
      case 'up': {
        const n = positionals[1] ? Number.parseInt(positionals[1], 10) : undefined;
        if (n !== undefined && !Number.isFinite(n)) printUsageAndExit();
        await up(n);
        break;
      }
      case 'down': {
        const n = positionals[1] ? Number.parseInt(positionals[1], 10) : 1;
        if (!Number.isFinite(n)) printUsageAndExit();
        await down(n);
        break;
      }
      case 'status':
        await status();
        break;
      default:
        printUsageAndExit();
    }
  } catch (err) {
    logger.error({ err }, 'migration command failed');
    process.exit(1);
  }
}

await main();
