import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('smoke', () => {
  it('runs node:test', () => {
    assert.equal(1 + 1, 2);
  });
});
