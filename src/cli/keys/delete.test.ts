import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeCapturedDeps,
  makeRecord,
  mockFindByPrefix,
  mockVoidById,
} from '../../../tests/_helpers/cli.ts';
import { run } from './delete.ts';

describe('keys delete', () => {
  it('returns 2 when positional is missing', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run([], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /missing positional/);
  });

  it('returns 1 when the key is not found', async () => {
    const findByPrefixUnique = mockFindByPrefix(null);
    const { deps, stderrText } = makeCapturedDeps({ repo: { findByPrefixUnique } });
    const code = await run(['mcp_live_zzz', '--yes'], deps);
    assert.equal(code, 1);
    assert.match(stderrText(), /not found/);
  });

  it('shows an extra-prominent warning banner and aborts on refusal', async () => {
    const findByPrefixUnique = mockFindByPrefix(makeRecord());
    const softDelete = mockVoidById();
    const { deps, stdoutText } = makeCapturedDeps({
      repo: { findByPrefixUnique, softDelete },
      stdin: 'no\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    const out = stdoutText();
    assert.match(out, /DELETE IS PERMANENT/);
    assert.match(out, /mcp_live_abc/);
    assert.match(out, /aborted/);
    assert.equal(softDelete.mock.callCount(), 0);
  });

  it('only mutates when user types y/yes', async () => {
    const findByPrefixUnique = mockFindByPrefix(makeRecord({ id: 'key-id-1' }));
    const softDelete = mockVoidById();
    const { deps, stdoutText, logs } = makeCapturedDeps({
      repo: { findByPrefixUnique, softDelete },
      stdin: 'yes\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.deepEqual(softDelete.mock.calls[0]?.arguments, ['key-id-1']);
    assert.match(stdoutText(), /deleted mcp_live_abc/);
    const audit = logs.find((l) => l.fields.event === 'api_key.deleted');
    assert.ok(audit);
    assert.equal(audit.fields.keyId, 'key-id-1');
  });

  it('--yes skips the confirmation prompt entirely', async () => {
    const findByPrefixUnique = mockFindByPrefix(makeRecord());
    const softDelete = mockVoidById();
    const { deps, stdoutText } = makeCapturedDeps({
      repo: { findByPrefixUnique, softDelete },
    });
    const code = await run(['mcp_live_abc', '--yes'], deps);
    assert.equal(code, 0);
    assert.doesNotMatch(stdoutText(), /DELETE IS PERMANENT/);
    assert.equal(softDelete.mock.callCount(), 1);
  });

  it('rejects unknown flags', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run(['--bogus'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option|unknown/i);
  });
});
