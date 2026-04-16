import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadTools } from './loader.ts';

// Resolve zod's file URL so temp-dir fixtures can import it by absolute path.
const zodUrl = import.meta.resolve('zod');

async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'echo-tools-test-'));
}

async function writeTool(dir: string, filename: string, content: string): Promise<void> {
  const filePath = join(dir, filename);
  const subdir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(subdir, { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

const validToolSource = `
import { z } from '${zodUrl}';

const tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: { query: z.string() },
  handler: async (args) => ({ content: [{ type: 'text', text: args.query }] }),
};
export default tool;
`;

function makeToolSource(name: string): string {
  return `
import { z } from '${zodUrl}';

const tool = {
  name: '${name}',
  description: 'Tool ${name}',
  inputSchema: { query: z.string() },
  handler: async (args) => ({ content: [{ type: 'text', text: args.query }] }),
};
export default tool;
`;
}

describe('loadTools', () => {
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
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 0);
  });

  it('loads one valid tool file', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'test-tool.ts', validToolSource);
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 1);
    const tool = registry.get('test-tool');
    assert.ok(tool);
    assert.equal(tool.name, 'test-tool');
    assert.equal(tool.description, 'A test tool');
  });

  it('discovers tools in subdirectories', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'sub/nested-tool.ts', makeToolSource('nested-tool'));
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 1);
    assert.ok(registry.get('nested-tool'));
  });

  it('throws when a file has no default export', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'bad-export.ts', 'export const foo = 42;\n');
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) =>
        err.message.includes('bad-export.ts') && err.message.includes('no default export'),
    );
  });

  it('throws when two files export the same name', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'first.ts', makeToolSource('dupe-name'));
    await writeTool(dir, 'second.ts', makeToolSource('dupe-name'));
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) =>
        err.message.includes('Duplicate tool name') && err.message.includes('dupe-name'),
    );
  });

  it('throws when name contains uppercase', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'bad-name.ts', makeToolSource('BadName'));
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) => err.message.includes('invalid name') && err.message.includes('BadName'),
    );
  });

  it('throws when name starts with a digit', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'digit.ts', makeToolSource('1bad'));
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) => err.message.includes('invalid name'),
    );
  });

  it('throws when the file fails to import', async () => {
    const dir = await makeTmpDir();
    const src = `
import { nonExistent } from 'totally-nonexistent-package';
export default { name: 'fail', description: 'x', inputSchema: {}, handler: nonExistent };
`;
    await writeTool(dir, 'bad-import.ts', src);
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) =>
        err.message.includes('bad-import.ts') && err.message.includes('Failed to import'),
    );
  });

  it('throws when required fields are missing', async () => {
    const dir = await makeTmpDir();
    const src = `
const tool = { name: 'missing-handler', description: 'no handler', inputSchema: {} };
export default tool;
`;
    await writeTool(dir, 'missing.ts', src);
    await assert.rejects(
      () => loadTools(dir),
      (err: Error) => err.message.includes('missing required fields'),
    );
  });

  it('ignores files starting with underscore', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, '_helpers.ts', 'export const helper = 1;\n');
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores files ending in .test.ts', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'foo.test.ts', 'export default { name: "x" };\n');
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores types.ts and loader.ts', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'types.ts', 'export default { name: "x" };\n');
    await writeTool(dir, 'loader.ts', 'export default { name: "y" };\n');
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 0);
  });

  it('ignores underscore-prefixed files in subdirectories', async () => {
    const dir = await makeTmpDir();
    await writeTool(dir, 'sub/_util.ts', 'export const x = 1;\n');
    const registry = await loadTools(dir);
    assert.equal(registry.list().length, 0);
  });

  it('get returns undefined for non-existent tool', async () => {
    const dir = await makeTmpDir();
    const registry = await loadTools(dir);
    assert.equal(registry.get('nonexistent'), undefined);
  });
});
