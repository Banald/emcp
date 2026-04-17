import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldWarnBareBindHost } from './bind-host-warning.ts';

describe('shouldWarnBareBindHost', () => {
  it('warns when production + 0.0.0.0 + not under compose', () => {
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'production',
        bindHost: '0.0.0.0',
        composeProjectName: undefined,
      }),
      true,
    );
  });

  it('stays silent when under compose (COMPOSE_PROJECT_NAME is set)', () => {
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'production',
        bindHost: '0.0.0.0',
        composeProjectName: 'echo',
      }),
      false,
    );
    // Even an empty string counts as defined and suppresses the warning.
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'production',
        bindHost: '0.0.0.0',
        composeProjectName: '',
      }),
      false,
    );
  });

  it('stays silent outside production', () => {
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'development',
        bindHost: '0.0.0.0',
        composeProjectName: undefined,
      }),
      false,
    );
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'test',
        bindHost: '0.0.0.0',
        composeProjectName: undefined,
      }),
      false,
    );
  });

  it('stays silent when BIND_HOST is loopback-scoped', () => {
    assert.equal(
      shouldWarnBareBindHost({
        nodeEnv: 'production',
        bindHost: '127.0.0.1',
        composeProjectName: undefined,
      }),
      false,
    );
  });
});
