import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeCapturedDeps, makeRecord, mockCreate } from '../../../tests/_helpers/cli.ts';
import { KEY_BODY_REGEX } from '../../core/auth-hash.ts';
import { run } from './create.ts';

describe('keys create', () => {
  it('returns 2 when --name is missing', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: { create: mockCreate() } });
    const code = await run([], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /--name is required/);
  });

  it('returns 2 when --name is only whitespace', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: { create: mockCreate() } });
    const code = await run(['--name', '   '], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /--name is required/);
  });

  it('returns 2 on unknown flags', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: { create: mockCreate() } });
    const code = await run(['--name', 'X', '--what'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /Unknown option/i);
  });

  it('returns 2 when --rate-limit is non-numeric', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: { create: mockCreate() } });
    const code = await run(['--name', 'X', '--rate-limit', 'abc'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /positive integer/);
  });

  it('returns 2 when --rate-limit is zero or negative', async () => {
    const { deps, stderrText } = makeCapturedDeps({ repo: { create: mockCreate() } });
    const code = await run(['--name', 'X', '--rate-limit', '0'], deps);
    assert.equal(code, 2);
    assert.match(stderrText(), /positive integer/);
  });

  it('creates, prints the raw key exactly once with the warning, and returns 0', async () => {
    const create = mockCreate(async () => makeRecord({ name: 'Production CI' }));
    const { deps, stdoutText, stderrText } = makeCapturedDeps({ repo: { create } });
    const code = await run(['--name', 'Production CI'], deps);
    assert.equal(code, 0);
    assert.equal(stderrText(), '');
    const out = stdoutText();
    assert.match(out, /SAVE THIS KEY NOW/);
    // Raw key must appear exactly once — find the mcp_live_xxx line and assert it matches the format.
    const rawKeyLines = out.split('\n').filter((line) => KEY_BODY_REGEX.test(line.trim()));
    assert.equal(rawKeyLines.length, 1);
    const rawKeyLine = rawKeyLines[0] ?? '';
    assert.match(rawKeyLine, /^mcp_live_[A-Za-z0-9_-]{43}$/);
    assert.match(out, /ID:\s+7c4f8b1d-/);
    assert.match(out, /Prefix:\s+mcp_live_abc/);
    assert.match(out, /Name:\s+Production CI/);
  });

  it('passes --rate-limit through to the repo', async () => {
    const create = mockCreate(async () => makeRecord({ rateLimitPerMinute: 120 }));
    const { deps } = makeCapturedDeps({ repo: { create } });
    await run(['--name', 'CI', '--rate-limit', '120'], deps);
    const arg = create.mock.calls[0]?.arguments[0];
    assert.equal(arg?.rateLimitPerMinute, 120);
  });

  it('passes --allow-no-origin through to the repo', async () => {
    const create = mockCreate(async () => makeRecord({ allowNoOrigin: true }));
    const { deps } = makeCapturedDeps({ repo: { create } });
    await run(['--name', 'CI', '--allow-no-origin'], deps);
    const arg = create.mock.calls[0]?.arguments[0];
    assert.equal(arg?.allowNoOrigin, true);
  });

  it('defaults allow_no_origin to false when flag is absent', async () => {
    const create = mockCreate();
    const { deps } = makeCapturedDeps({ repo: { create } });
    await run(['--name', 'CI'], deps);
    const arg = create.mock.calls[0]?.arguments[0];
    assert.equal(arg?.allowNoOrigin, false);
  });

  it('emits an audit log with event=api_key.created and never the raw key', async () => {
    const record = makeRecord({ name: 'Production CI' });
    const create = mockCreate(async () => record);
    const { deps, logs, stdoutText } = makeCapturedDeps({ repo: { create } });
    await run(['--name', 'Production CI'], deps);
    const audit = logs.find((entry) => entry.fields.event === 'api_key.created');
    assert.ok(audit, 'expected api_key.created audit log');
    assert.equal(audit.fields.audit, true);
    assert.equal(audit.fields.keyId, record.id);
    assert.equal(audit.fields.keyPrefix, record.keyPrefix);
    assert.equal(audit.fields.name, record.name);
    assert.equal(audit.fields.rateLimitPerMinute, record.rateLimitPerMinute);
    // No log entry contains the raw key — that would be a Rule-5 violation.
    const rawKey = stdoutText()
      .split('\n')
      .find((line) => KEY_BODY_REGEX.test(line.trim()));
    assert.ok(rawKey, 'expected a raw key line in stdout');
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      assert.ok(!serialized.includes(rawKey), 'raw key must not appear in any log entry');
    }
  });
});
