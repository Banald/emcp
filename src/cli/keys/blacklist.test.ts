import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeCapturedDeps,
  makeRecord,
  mockFindByPrefix,
  mockVoidById,
} from '../../../tests/_helpers/cli.ts';
import { run } from './blacklist.ts';

describe('keys blacklist', () => {
  it('returns 2 when no positional argument is given', async () => {
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
    assert.match(stderrText(), /not found: mcp_live_zzz/);
  });

  it('prompts and aborts when user declines', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord());
    const blacklist = mockVoidById();
    const { deps, stdoutText } = makeCapturedDeps({
      repo: { findByPrefix, blacklist },
      stdin: 'n\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.match(stdoutText(), /Blacklist key mcp_live_abc/);
    assert.match(stdoutText(), /aborted/);
    assert.equal(blacklist.mock.callCount(), 0);
  });

  it('prompts and mutates when user accepts', async () => {
    const record = makeRecord({ id: 'key-id-1' });
    const findByPrefix = mockFindByPrefix(record);
    const blacklist = mockVoidById();
    const { deps, stdoutText, logs } = makeCapturedDeps({
      repo: { findByPrefix, blacklist },
      stdin: 'yes\n',
    });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.equal(blacklist.mock.callCount(), 1);
    assert.deepEqual(blacklist.mock.calls[0]?.arguments, ['key-id-1']);
    assert.match(stdoutText(), /blacklisted mcp_live_abc/);
    const audit = logs.find((l) => l.fields.event === 'api_key.blacklisted');
    assert.ok(audit);
    assert.equal(audit.fields.audit, true);
    assert.equal(audit.fields.keyId, 'key-id-1');
  });

  it('skips the confirmation prompt with --yes', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord());
    const blacklist = mockVoidById();
    const { deps, stdoutText } = makeCapturedDeps({
      repo: { findByPrefix, blacklist },
    });
    const code = await run(['mcp_live_abc', '--yes'], deps);
    assert.equal(code, 0);
    assert.doesNotMatch(stdoutText(), /Blacklist key mcp_live_abc/);
    assert.equal(blacklist.mock.callCount(), 1);
  });

  it('passes --reason through to the audit log', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord({ id: 'k' }));
    const blacklist = mockVoidById();
    const { deps, logs } = makeCapturedDeps({ repo: { findByPrefix, blacklist } });
    await run(['mcp_live_abc', '--yes', '--reason', 'leaked-on-twitter'], deps);
    const audit = logs.find((l) => l.fields.event === 'api_key.blacklisted');
    assert.equal(audit?.fields.reason, 'leaked-on-twitter');
  });

  it('rejects unknown flags', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run(['--bogus', 'x'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option|unknown/i);
  });
});
