import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeCapturedDeps,
  makeRecord,
  mockFindById,
  mockFindByPrefix,
} from '../../../tests/_helpers/cli.ts';
import { run } from './show.ts';

describe('keys show', () => {
  it('returns 2 when no positional argument is given', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run([], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /missing positional/);
  });

  it('uses findById when the argument looks like a UUID', async () => {
    const findById = mockFindById(
      makeRecord({
        id: '7c4f8b1d-0000-4000-8000-000000000000',
        lastUsedAt: new Date('2026-02-01T00:00:00Z'),
        requestCount: 42n,
      }),
    );
    const findByPrefix = mockFindByPrefix(null);
    const { deps, stdoutText } = makeCapturedDeps({ repo: { findById, findByPrefix } });
    const code = await run(['7c4f8b1d-0000-4000-8000-000000000000'], deps);
    assert.equal(code, 0);
    assert.equal(findById.mock.callCount(), 1);
    assert.equal(findByPrefix.mock.callCount(), 0);
    const out = stdoutText();
    assert.match(out, /ID:\s+7c4f8b1d-0000-4000-8000-000000000000/);
    assert.match(out, /Requests:\s+42/);
    assert.match(out, /Last used:\s+2026-02-01T00:00:00\.000Z/);
  });

  it('uses findByPrefix when the argument is not a UUID', async () => {
    const findById = mockFindById(null);
    const findByPrefix = mockFindByPrefix(makeRecord());
    const { deps } = makeCapturedDeps({ repo: { findById, findByPrefix } });
    const code = await run(['mcp_live_abc'], deps);
    assert.equal(code, 0);
    assert.equal(findById.mock.callCount(), 0);
    assert.equal(findByPrefix.mock.callCount(), 1);
    assert.deepEqual(findByPrefix.mock.calls[0]?.arguments, ['mcp_live_abc']);
  });

  it('returns 1 (not found) when the repo returns null', async () => {
    const findByPrefix = mockFindByPrefix(null);
    const { deps, stderrText } = makeCapturedDeps({ repo: { findByPrefix } });
    const code = await run(['mcp_live_zzz'], deps);
    assert.equal(code, 1);
    assert.match(stderrText(), /not found: mcp_live_zzz/);
  });

  it('prints never/no for absent timestamps', async () => {
    const findByPrefix = mockFindByPrefix(makeRecord());
    const { deps, stdoutText } = makeCapturedDeps({ repo: { findByPrefix } });
    await run(['mcp_live_abc'], deps);
    const out = stdoutText();
    assert.match(out, /Last used:\s+\(never\)/);
    assert.match(out, /Blacklisted:\s+\(no\)/);
    assert.match(out, /Deleted:\s+\(no\)/);
  });

  it('prints ISO timestamps when present', async () => {
    const findByPrefix = mockFindByPrefix(
      makeRecord({
        blacklistedAt: new Date('2026-03-01T00:00:00Z'),
        deletedAt: new Date('2026-04-01T00:00:00Z'),
        status: 'deleted',
      }),
    );
    const { deps, stdoutText } = makeCapturedDeps({ repo: { findByPrefix } });
    await run(['mcp_live_abc'], deps);
    const out = stdoutText();
    assert.match(out, /Blacklisted:\s+2026-03-01T00:00:00\.000Z/);
    assert.match(out, /Deleted:\s+2026-04-01T00:00:00\.000Z/);
  });

  it('rejects unknown flags', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: {} });
    const code = await run(['--bogus', 'x'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option|unknown/i);
  });
});
