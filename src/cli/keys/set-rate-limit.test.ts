import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeCapturedDeps,
  makeRecord,
  mockFindById,
  mockFindByPrefix,
  mockSetRateLimit,
} from '../../../tests/_helpers/cli.ts';
import { run } from './set-rate-limit.ts';

describe('keys set-rate-limit', () => {
  it('returns 2 when arguments are missing', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run([], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /usage: keys set-rate-limit/);
  });

  it('returns 2 when the second positional is missing', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /usage: keys set-rate-limit/);
  });

  it('returns 2 when per-minute is not a positive integer', async () => {
    const setRateLimit = mockSetRateLimit();
    const { deps, stderrText } = makeCapturedDeps({ repo: { setRateLimit } });
    for (const bad of ['abc', '0', '-5', '1.5']) {
      const code = await run(['mcp_live_abc', bad], deps);
      assert.equal(code, 2);
    }
    assert.match(stderrText(), /positive integer/);
    assert.equal(setRateLimit.mock.callCount(), 0);
  });

  it('returns 1 when the key is not found', async () => {
    const findByPrefixUnique = mockFindByPrefix(null);
    const { deps, stderrText } = makeCapturedDeps({ repo: { findByPrefixUnique } });
    const code = await run(['mcp_live_zzz', '120'], deps);
    assert.equal(code, 1);
    assert.match(stderrText(), /not found/);
  });

  it('updates, prints confirmation, and audits on success', async () => {
    const findByPrefixUnique = mockFindByPrefix(
      makeRecord({ id: 'key-id-1', rateLimitPerMinute: 60 }),
    );
    const setRateLimit = mockSetRateLimit();
    const { deps, stdoutText, logs } = makeCapturedDeps({
      repo: { findByPrefixUnique, setRateLimit },
    });
    const code = await run(['mcp_live_abc', '180'], deps);
    assert.equal(code, 0);
    assert.deepEqual(setRateLimit.mock.calls[0]?.arguments, ['key-id-1', 180]);
    assert.match(stdoutText(), /set to 180/);
    const audit = logs.find((l) => l.fields.event === 'api_key.rate_limit_changed');
    assert.ok(audit);
    assert.equal(audit.fields.keyId, 'key-id-1');
    assert.equal(audit.fields.previousRateLimitPerMinute, 60);
    assert.equal(audit.fields.rateLimitPerMinute, 180);
  });

  it('works with a UUID argument (routes via findById)', async () => {
    const findById = mockFindById(makeRecord({ id: '7c4f8b1d-0000-4000-8000-000000000000' }));
    const setRateLimit = mockSetRateLimit();
    const { deps } = makeCapturedDeps({ repo: { findById, setRateLimit } });
    const code = await run(['7c4f8b1d-0000-4000-8000-000000000000', '120'], deps);
    assert.equal(code, 0);
    assert.equal(findById.mock.callCount(), 1);
  });
});
