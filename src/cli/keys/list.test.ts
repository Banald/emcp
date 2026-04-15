import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeCapturedDeps, makeRecord, mockList } from '../../../tests/_helpers/cli.ts';
import { run } from './list.ts';

describe('keys list', () => {
  it('returns 0 and prints a placeholder when there are no rows', async () => {
    const list = mockList();
    const { deps, stdoutText } = makeCapturedDeps({ repo: { list } });
    const code = await run([], deps);
    assert.equal(code, 0);
    assert.match(stdoutText(), /\(no keys\)/);
    // Default filter: empty object (means "all non-deleted").
    assert.deepEqual(list.mock.calls[0]?.arguments[0], {});
  });

  it('prints a header + a row per key', async () => {
    const list = mockList([
      makeRecord({ id: 'a-id', keyPrefix: 'mcp_live_aaa', name: 'A' }),
      makeRecord({
        id: 'b-id',
        keyPrefix: 'mcp_live_bbb',
        name: 'B',
        status: 'blacklisted',
      }),
    ]);
    const { deps, stdoutText } = makeCapturedDeps({ repo: { list } });
    const code = await run([], deps);
    assert.equal(code, 0);
    const out = stdoutText();
    assert.match(out, /ID\s+PREFIX\s+NAME\s+STATUS\s+CREATED/);
    assert.match(out, /a-id\s+mcp_live_aaa\s+A\s+active/);
    assert.match(out, /b-id\s+mcp_live_bbb\s+B\s+blacklisted/);
  });

  it('passes --status through to the repo', async () => {
    const list = mockList();
    const { deps } = makeCapturedDeps({ repo: { list } });
    await run(['--status', 'blacklisted'], deps);
    assert.deepEqual(list.mock.calls[0]?.arguments[0], { status: 'blacklisted' });
  });

  it('accepts --status all', async () => {
    const list = mockList();
    const { deps } = makeCapturedDeps({ repo: { list } });
    const code = await run(['--status', 'all'], deps);
    assert.equal(code, 0);
    assert.deepEqual(list.mock.calls[0]?.arguments[0], { status: 'all' });
  });

  it('rejects an invalid --status', async () => {
    const list = mockList();
    const { deps, stderrText } = makeCapturedDeps({ repo: { list } });
    const code = await run(['--status', 'weird'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /--status must be one of/);
    assert.equal(list.mock.callCount(), 0);
  });

  it('rejects unknown flags', async () => {
    const list = mockList();
    const { deps, stderrText } = makeCapturedDeps({ repo: { list } });
    const code = await run(['--bogus'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option|unknown/i);
  });
});
