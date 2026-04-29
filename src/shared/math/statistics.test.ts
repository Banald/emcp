import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  correlation,
  describe as describeStats,
  evaluateDistribution,
  linearRegression,
  mean,
  median,
  mode,
  percentile,
  StatsError,
  stddev,
  sum,
  variance,
} from './statistics.ts';

describe('basic stats', () => {
  it('sum / mean / median', () => {
    assert.equal(sum([1, 2, 3, 4]), 10);
    assert.equal(mean([2, 4, 6]), 4);
    assert.equal(median([1, 2, 3, 4, 5]), 3);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it('rejects empty / non-finite data', () => {
    assert.throws(() => mean([]), StatsError);
    assert.throws(() => mean([1, Number.NaN]), StatsError);
    assert.throws(() => median([]), StatsError);
    assert.throws(() => sum([1, Number.POSITIVE_INFINITY]), StatsError);
  });

  it('mode returns sorted modes; empty if all unique', () => {
    assert.deepEqual(mode([1, 2, 3]), []);
    assert.deepEqual(mode([1, 1, 2, 3]), [1]);
    assert.deepEqual(mode([3, 3, 1, 1, 2]), [1, 3]); // bimodal
  });

  it('variance and stddev (sample by default)', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    // Population variance = 32/8 = 4. Sample variance (n-1) = 32/7.
    assert.ok(Math.abs(variance(data, true) - 4) < 1e-9);
    assert.ok(Math.abs(variance(data) - 32 / 7) < 1e-9);
    assert.ok(Math.abs(stddev(data, true) - 2) < 1e-9);
  });

  it('population variance differs from sample', () => {
    const data = [1, 2, 3];
    assert.ok(Math.abs(variance(data) - 1) < 1e-12); // sample, n-1
    assert.ok(Math.abs(variance(data, true) - 2 / 3) < 1e-12); // population, n
  });

  it('sample variance with n=1 throws', () => {
    assert.throws(() => variance([5]), StatsError);
    // Population variance with n=1 should be 0.
    assert.equal(variance([5], true), 0);
  });
});

describe('percentile', () => {
  it('basic percentiles by linear interpolation', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
    assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  });

  it('interpolates between samples', () => {
    // Type-7: rank = (p/100) * (n-1); for [1,2,3,4] at 25% → rank=0.75 → 1*0.25 + 2*0.75 = 1.75
    assert.ok(Math.abs(percentile([1, 2, 3, 4], 25) - 1.75) < 1e-9);
  });

  it('handles single-element', () => {
    assert.equal(percentile([7], 50), 7);
  });

  it('rejects out-of-range p', () => {
    assert.throws(() => percentile([1, 2], -1), StatsError);
    assert.throws(() => percentile([1, 2], 200), StatsError);
    assert.throws(() => percentile([1, 2], Number.NaN), StatsError);
  });
});

describe('describe', () => {
  it('produces a full stat block', () => {
    const r = describeStats([1, 2, 3, 4, 5]);
    assert.equal(r.count, 5);
    assert.equal(r.sum, 15);
    assert.equal(r.mean, 3);
    assert.equal(r.median, 3);
    assert.deepEqual(r.mode, []);
    assert.ok(Math.abs(r.stddev - Math.sqrt(2.5)) < 1e-9);
    assert.equal(r.min, 1);
    assert.equal(r.max, 5);
    assert.equal(r.range, 4);
    assert.ok(Math.abs(r.q1 - 2) < 1e-9);
    assert.ok(Math.abs(r.q3 - 4) < 1e-9);
    assert.ok(Math.abs(r.iqr - 2) < 1e-9);
  });

  it('handles n=1', () => {
    const r = describeStats([42]);
    assert.equal(r.count, 1);
    assert.equal(r.variance, 0);
    assert.equal(r.stddev, 0);
    assert.equal(r.range, 0);
  });
});

describe('correlation', () => {
  it('perfect positive', () => {
    assert.ok(Math.abs(correlation([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  });

  it('perfect negative', () => {
    assert.ok(Math.abs(correlation([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9);
  });

  it('uncorrelated data is small', () => {
    const r = correlation([1, 2, 3, 4, 5], [2, 1, 4, 5, 3]);
    assert.ok(Math.abs(r) < 1);
  });

  it('rejects mismatched lengths', () => {
    assert.throws(() => correlation([1, 2], [1, 2, 3]), StatsError);
  });

  it('rejects too-short series', () => {
    assert.throws(() => correlation([1], [1]), StatsError);
  });

  it('rejects zero-variance series', () => {
    assert.throws(() => correlation([1, 1, 1], [1, 2, 3]), StatsError);
  });
});

describe('linearRegression', () => {
  it('recovers exact line', () => {
    // y = 2x + 1
    const r = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    assert.ok(Math.abs(r.slope - 2) < 1e-9);
    assert.ok(Math.abs(r.intercept - 1) < 1e-9);
    assert.ok(Math.abs(r.r - 1) < 1e-9);
    assert.ok(Math.abs(r.r_squared - 1) < 1e-9);
    assert.equal(r.n, 4);
  });

  it('rejects mismatched lengths', () => {
    assert.throws(() => linearRegression([1, 2], [1]), StatsError);
  });

  it('rejects single-point inputs', () => {
    assert.throws(() => linearRegression([1], [1]), StatsError);
  });

  it('rejects zero-variance x', () => {
    assert.throws(() => linearRegression([1, 1, 1], [1, 2, 3]), StatsError);
  });
});

describe('evaluateDistribution', () => {
  it('normal pdf/cdf/quantile', () => {
    assert.ok(
      Math.abs(
        evaluateDistribution('normal', 'pdf', 0, { mean: 0, stddev: 1 }) -
          1 / Math.sqrt(2 * Math.PI),
      ) < 1e-9,
    );
    assert.ok(Math.abs(evaluateDistribution('normal', 'cdf', 0, {}) - 0.5) < 1e-7);
    assert.ok(Math.abs(evaluateDistribution('normal', 'quantile', 0.5, {})) < 1e-7);
  });

  it('binomial pdf/cdf', () => {
    assert.equal(evaluateDistribution('binomial', 'pdf', 0, { n: 5, p: 0 }), 1);
    const c = evaluateDistribution('binomial', 'cdf', 3, { n: 10, p: 0.5 });
    assert.ok(Math.abs(c - 0.171875) < 1e-6);
  });

  it('binomial quantile is unsupported', () => {
    assert.throws(
      () => evaluateDistribution('binomial', 'quantile', 0.5, { n: 5, p: 0.5 }),
      /not supported/,
    );
  });

  it('binomial requires n and p', () => {
    assert.throws(() => evaluateDistribution('binomial', 'pdf', 0, {}), /requires n and p/);
  });

  it('poisson pdf/cdf', () => {
    assert.equal(evaluateDistribution('poisson', 'pdf', 0, { lambda: 0 }), 1);
    assert.ok(evaluateDistribution('poisson', 'cdf', 50, { lambda: 5 }) > 0.999999);
  });

  it('poisson requires lambda', () => {
    assert.throws(() => evaluateDistribution('poisson', 'pdf', 0, {}), /requires lambda/);
  });

  it('poisson quantile is unsupported', () => {
    assert.throws(
      () => evaluateDistribution('poisson', 'quantile', 0.5, { lambda: 1 }),
      /not supported/,
    );
  });

  it('uniform pdf/cdf/quantile', () => {
    assert.equal(evaluateDistribution('uniform', 'pdf', 0.5, { low: 0, high: 1 }), 1);
    assert.equal(evaluateDistribution('uniform', 'cdf', 0.25, { low: 0, high: 1 }), 0.25);
    assert.equal(evaluateDistribution('uniform', 'quantile', 0.5, { low: 0, high: 10 }), 5);
  });

  it('uniform quantile rejects out-of-range probability', () => {
    assert.throws(
      () => evaluateDistribution('uniform', 'quantile', 1.5, { low: 0, high: 1 }),
      /requires 0 ≤ p ≤ 1/,
    );
  });

  it('uniform requires low and high', () => {
    assert.throws(() => evaluateDistribution('uniform', 'pdf', 0, {}), /requires low and high/);
  });

  it('rejects non-finite value', () => {
    assert.throws(
      () => evaluateDistribution('uniform', 'pdf', Number.POSITIVE_INFINITY, { low: 0, high: 1 }),
      /must be finite/,
    );
  });

  it('propagates domain errors from underlying functions', () => {
    assert.throws(() => evaluateDistribution('normal', 'pdf', 0, { mean: 0, stddev: 0 }), /sd > 0/);
  });
});
