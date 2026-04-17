import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeCapturedDeps,
  makeRecord,
  mockFindByPrefix,
  mockVoidById,
} from '../../../tests/_helpers/cli.ts';
import { run } from './unblacklist.ts';

describe('keys unblacklist', () => {
  it('returns 2 when positional is missing', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run([], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /missing positional/);
  });

  it('returns 1 when the key is not found', async () => {
    const findByPrefix = mockFindByPrefix(null);
    const { deps, stderrText } = makeCapturedDeps({ repo: { findByPrefix } });
    const code = await run(['mcp_live_zzz', '--yes'], deps);
    assert.equal(code, 1);
    assert.match(stderrText(), /not found/);
  });

  it('returns 2 when the key is not currently blacklisted', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ status: 'active' }));
    const unblacklist = mockVoidById();
    const { deps, stderrText } = makeCapturedDeps({
      repo: { findByPrefix, unblacklist },
    });
    const code = await run(['mcp_live_abc', '--yes'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /is active, not blacklisted/);
    assert.equal(unblacklist.mock.callCount(), 0);
  });

  it('refuses to unblacklist a deleted key', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ status: 'deleted' }));
    const unblacklist = mockVoidById();
    const { deps, stderrText } = makeCapturedDeps({
      repo: { findByPrefix, unblacklist },
    });
    const code = await run(['mcp_live_abc', '--yes'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /is deleted, not blacklisted/);
    assert.equal(unblacklist.mock.callCount(), 0);
  });

  it('prompts and aborts when user declines', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ status: 'blacklisted' }));
    const unblacklist = mockVoidById();
    const { deps, stdoutText } = makeCapturedDeps({
      repo: { findByPrefix, unblacklist },
      stdin: '\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.match(stdoutText(), /Unblacklist key mcp_live_abc/);
    assert.match(stdoutText(), /aborted/);
    assert.equal(unblacklist.mock.callCount(), 0);
  });

  it('mutates and audits on --yes', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ id: 'key-id-1', status: 'blacklisted' }));
    const unblacklist = mockVoidById();
    const { deps, logs, stdoutText } = makeCapturedDeps({
      repo: { findByPrefix, unblacklist },
    });
    const code = await run(['mcp_live_abc', '--yes'], deps);
    assert.equal(code, 0);
    assert.deepEqual(unblacklist.mock.calls[0]?.arguments, ['key-id-1']);
    assert.match(stdoutText(), /unblacklisted mcp_live_abc/);
    const audit = logs.find((l) => l.fields.event === 'api_key.unblacklisted');
    assert.ok(audit);
    assert.equal(audit.fields.keyId, 'key-id-1');
  });

  it('mutates and audits when user confirms via prompt', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ id: 'key-id-2', status: 'blacklisted' }));
    const unblacklist = mockVoidById();
    const { deps } = makeCapturedDeps({
      repo: { findByPrefix, unblacklist },
      stdin: 'y\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.equal(unblacklist.mock.callCount(), 1);
  });

  it('rejects unknown flags', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run(['--bogus'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option|unknown/i);
  });
});
