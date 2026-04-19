import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadWorkers } from './loader.ts';

async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'emcp-workers-test-'));
}

async function writeWorker(dir: string, filename: string, content: string): Promise<void> {
  const filePath = join(dir, filename);
  const subdir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(subdir, { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

const validWorkerSource = `
const worker = {
  name: 'test-worker',
  description: 'A test worker',
  schedule: '*/5 * * * *',
  handler: async () => {},
};
export default worker;
`;

function makeWorkerSource(name: string, schedule = '*/5 * * * *'): string {
  return `
const worker = {
  name: '${name}',
  schedule: '${schedule}',
  handler: async () => {},
};
export default worker;
`;
}

describe('loadWorkers', () => {
  const dirs: string[] = [];

  after(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await createTmpDir();
    dirs.push(dir);
    return dir;
  }

  it('returns an empty registry for an empty directory', async () => {
    const dir = await makeTmpDir();
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('loads one valid worker file', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'test-worker.ts', validWorkerSource);
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 1);
    const worker = registry.get('test-worker');
    assert.ok(worker);
    assert.equal(worker.name, 'test-worker');
    assert.equal(worker.description, 'A test worker');
    assert.equal(worker.schedule, '*/5 * * * *');
  });

  it('discovers workers in subdirectories', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'sub/nested-worker.ts', makeWorkerSource('nested-worker'));
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 1);
    assert.ok(registry.get('nested-worker'));
  });

  it('throws when a file has no default export', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'bad-export.ts', 'export const foo = 42;\n');
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) =>
        err.message.includes('bad-export.ts') && err.message.includes('no default export'),
    );
  });

  it('throws when two files export the same name', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'first.ts', makeWorkerSource('dupe-name'));
    await writeWorker(dir, 'second.ts', makeWorkerSource('dupe-name'));
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) =>
        err.message.includes('Duplicate worker name') && err.message.includes('dupe-name'),
    );
  });

  it('throws when name contains uppercase', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'bad-name.ts', makeWorkerSource('BadName'));
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) => err.message.includes('invalid name') && err.message.includes('BadName'),
    );
  });

  it('throws when name starts with a digit', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'digit.ts', makeWorkerSource('1bad'));
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) => err.message.includes('invalid name'),
    );
  });

  it('throws when the file fails to import', async () => {
    const dir = await makeTmpDir();
    const src = `
import { nonExistent } from 'totally-nonexistent-package';
export default { name: 'fail', schedule: '* * * * *', handler: nonExistent };
`;
    await writeWorker(dir, 'bad-import.ts', src);
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) =>
        err.message.includes('bad-import.ts') && err.message.includes('Failed to import'),
    );
  });

  it('throws when required fields are missing', async () => {
    const dir = await makeTmpDir();
    const src = `
const worker = { name: 'missing-handler', schedule: '* * * * *' };
export default worker;
`;
    await writeWorker(dir, 'missing.ts', src);
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) => err.message.includes('missing required fields'),
    );
  });

  it('throws when the schedule is not a valid cron expression', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'bad-cron.ts', makeWorkerSource('bad-cron', 'not a cron'));
    await assert.rejects(
      () => loadWorkers(dir),
      (err: Error) => err.message.includes('invalid schedule'),
    );
  });

  it('ignores files starting with underscore', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, '_helpers.ts', 'export const helper = 1;\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores files ending in .test.ts', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'foo.test.ts', 'export default { name: "x" };\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores types.ts, loader.ts, scheduler.ts, index.ts', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'types.ts', 'export default { name: "x" };\n');
    await writeWorker(dir, 'loader.ts', 'export default { name: "y" };\n');
    await writeWorker(dir, 'scheduler.ts', 'export default { name: "z" };\n');
    await writeWorker(dir, 'index.ts', 'export default { name: "w" };\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('loads compiled .js worker files (production dist layout)', async () => {
    const dir = await makeTmpDir();
    // .js files in a directory without a `"type": "module"` package.json
    // default to CommonJS; the real dist ships with ESM. Drop a minimal
    // package.json so Node resolves the .js files as ESM like it does in prod.
    await writeWorker(dir, 'package.json', '{"type":"module"}\n');
    await writeWorker(dir, 'compiled-worker.js', validWorkerSource);
    await writeWorker(dir, 'types.js', 'export default { name: "x" };\n');
    await writeWorker(dir, 'loader.js', 'export default { name: "y" };\n');
    await writeWorker(dir, 'scheduler.js', 'export default { name: "z" };\n');
    await writeWorker(dir, 'index.js', 'export default { name: "w" };\n');
    await writeWorker(dir, 'foo.test.js', 'export default { name: "t" };\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 1);
    assert.ok(registry.get('test-worker'));
  });

  it('ignores .js.map and other non-.ts/.js files', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'stray.js.map', '{"version":3}\n');
    await writeWorker(dir, 'readme.md', '# not a worker\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores underscore-prefixed files in subdirectories', async () => {
    const dir = await makeTmpDir();
    await writeWorker(dir, 'sub/_util.ts', 'export const x = 1;\n');
    const registry = await loadWorkers(dir);
    assert.equal(registry.list().length, 0);
  });

  it('get returns undefined for non-existent worker', async () => {
    const dir = await makeTmpDir();
    const registry = await loadWorkers(dir);
    assert.equal(registry.get('nonexistent'), undefined);
  });
});
