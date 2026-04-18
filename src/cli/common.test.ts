import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { describe, it, mock } from 'node:test';
import type { Logger } from 'pino';
import type { ApiKeyRecord, ApiKeyRepository } from '../db/repos/api-keys.ts';
import { ConflictError } from '../lib/errors.ts';
import { audit, type CliDeps, confirm, findKey, isUuid, safeParse, writeLine } from './common.ts';

function capturedWritable(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('isUuid', () => {
  it('returns true for a valid v4 UUID', () => {
    assert.equal(isUuid('7c4f8b1d-0000-4000-8000-000000000000'), true);
  });

  it('returns true regardless of case', () => {
    assert.equal(isUuid('7C4F8B1D-0000-4000-8000-000000000000'), true);
  });

  it('returns false for a non-UUID string', () => {
    assert.equal(isUuid('mcp_live_abc'), false);
  });

  it('returns false for an empty string', () => {
    assert.equal(isUuid(''), false);
  });
});

describe('findKey', () => {
  const fakeRecord = { id: '7c4f8b1d-0000-4000-8000-000000000000' } as ApiKeyRecord;

  it('routes to findById when given a UUID and returns the record', async () => {
    const findById = mock.fn(async () => fakeRecord);
    const findByPrefixUnique = mock.fn(async () => null);
    const repo = { findById, findByPrefixUnique } as unknown as ApiKeyRepository;
    const result = await findKey(repo, '7c4f8b1d-0000-4000-8000-000000000000');
    assert.equal(findById.mock.callCount(), 1);
    assert.equal(findByPrefixUnique.mock.callCount(), 0);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.record.id, fakeRecord.id);
  });

  it('returns not-found when a UUID is not in the DB', async () => {
    const findById = mock.fn(async () => null);
    const findByPrefixUnique = mock.fn(async () => null);
    const repo = { findById, findByPrefixUnique } as unknown as ApiKeyRepository;
    const result = await findKey(repo, '7c4f8b1d-0000-4000-8000-000000000001');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'not-found');
      assert.match(result.message, /not found/);
    }
  });

  it('routes to findByPrefixUnique when given a prefix (AUDIT L-4)', async () => {
    const findById = mock.fn(async () => null);
    const findByPrefixUnique = mock.fn(async () => fakeRecord);
    const repo = { findById, findByPrefixUnique } as unknown as ApiKeyRepository;
    const result = await findKey(repo, 'mcp_live_abc');
    assert.equal(findById.mock.callCount(), 0);
    assert.equal(findByPrefixUnique.mock.callCount(), 1);
    assert.equal(result.ok, true);
  });

  it('returns ambiguous when findByPrefixUnique throws ConflictError', async () => {
    const findById = mock.fn(async () => null);
    const findByPrefixUnique = mock.fn(async () => {
      throw new ConflictError(
        'prefix "mcp_live_abc" matched 2 keys; use the UUID instead',
        'Ambiguous prefix; use the UUID instead.',
      );
    });
    const repo = { findById, findByPrefixUnique } as unknown as ApiKeyRepository;
    const result = await findKey(repo, 'mcp_live_abc');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'ambiguous');
      assert.match(result.message, /matched 2 keys/);
    }
  });

  it('rethrows non-Conflict errors from the repo', async () => {
    const findById = mock.fn(async () => null);
    const findByPrefixUnique = mock.fn(async () => {
      throw new Error('DB exploded');
    });
    const repo = { findById, findByPrefixUnique } as unknown as ApiKeyRepository;
    await assert.rejects(() => findKey(repo, 'mcp_live_abc'), /DB exploded/);
  });
});

describe('confirm', () => {
  function makeDeps(input: string): CliDeps {
    return {
      repo: {} as ApiKeyRepository,
      stdin: Readable.from(input),
      stdout: capturedWritable().stream,
      stderr: capturedWritable().stream,
      logger: {} as Logger,
      auditLogger: {} as Logger,
    };
  }

  it('returns true for "y"', async () => {
    assert.equal(await confirm(makeDeps('y\n'), 'ok? '), true);
  });

  it('returns true for "yes" (case-insensitive)', async () => {
    assert.equal(await confirm(makeDeps('YES\n'), 'ok? '), true);
  });

  it('returns false for "n"', async () => {
    assert.equal(await confirm(makeDeps('n\n'), 'ok? '), false);
  });

  it('returns false for empty input', async () => {
    assert.equal(await confirm(makeDeps('\n'), 'ok? '), false);
  });
});

describe('writeLine', () => {
  it('writes a line with trailing newline', () => {
    const { stream, text } = capturedWritable();
    writeLine(stream, 'hello');
    assert.equal(text(), 'hello\n');
  });

  it('writes just a newline when no argument given', () => {
    const { stream, text } = capturedWritable();
    writeLine(stream);
    assert.equal(text(), '\n');
  });
});

describe('safeParse', () => {
  it('returns the value on success', () => {
    const { stream: stderr } = capturedWritable();
    const deps = { stderr } as unknown as CliDeps;
    const result = safeParse(() => 42, deps, 'usage');
    assert.equal(result, 42);
  });

  it('returns null and writes to stderr on failure', () => {
    const { stream: stderr, text } = capturedWritable();
    const deps = { stderr } as unknown as CliDeps;
    const result = safeParse(
      () => {
        throw new Error('bad arg');
      },
      deps,
      'Usage: cmd [opts]',
    );
    assert.equal(result, null);
    assert.match(text(), /bad arg/);
    assert.match(text(), /Usage: cmd/);
  });
});

describe('audit', () => {
  it('logs with event field and provided context', () => {
    const info = mock.fn();
    const logger = { info } as unknown as Logger;
    audit(logger, 'api_key.created', 'key created', { keyId: '123', keyPrefix: 'mcp_live' });
    assert.equal(info.mock.callCount(), 1);
    const args = info.mock.calls[0].arguments;
    assert.equal((args[0] as Record<string, unknown>).event, 'api_key.created');
    assert.equal((args[0] as Record<string, unknown>).keyId, '123');
    assert.equal((args[0] as Record<string, unknown>).keyPrefix, 'mcp_live');
    assert.equal(args[1], 'key created');
  });
});
