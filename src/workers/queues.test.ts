import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { producerConnection, workerConnection } from './_connection.ts';
import { fetchQueue, queues } from './queues.ts';

// queues.ts imports _connection.ts which creates Redis connections.
// These connect to REDIS_URL from the test env (tests/setup.ts).
// Close everything after tests to prevent lingering connections.
after(async () => {
  await fetchQueue.close();
  producerConnection.disconnect();
  workerConnection.disconnect();
});

describe('queues', () => {
  it('fetchQueue has correct name', () => {
    assert.equal(fetchQueue.name, 'fetch');
  });

  it('fetchQueue has 5 retry attempts with exponential backoff', () => {
    const jobOpts = fetchQueue.jobsOpts;
    assert.equal(jobOpts.attempts, 5);
    assert.deepEqual(jobOpts.backoff, { type: 'exponential', delay: 2000 });
  });

  it('fetchQueue configures removeOnComplete retention', () => {
    const jobOpts = fetchQueue.jobsOpts;
    assert.deepEqual(jobOpts.removeOnComplete, { age: 86400, count: 1000 });
  });

  it('fetchQueue configures removeOnFail retention', () => {
    const jobOpts = fetchQueue.jobsOpts;
    assert.deepEqual(jobOpts.removeOnFail, { age: 604800 });
  });

  it('queues map exposes fetch entry', () => {
    assert.strictEqual(queues.fetch, fetchQueue);
  });

  it('queues map has only the fetch entry', () => {
    const keys = Object.keys(queues);
    assert.deepEqual(keys, ['fetch']);
  });
});
