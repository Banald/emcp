// Descriptive statistics + Pearson correlation + OLS linear regression.
// Probability distributions are surfaced through the expression evaluator
// (see src/shared/math/expr/builtins.ts) and are also re-exported here for
// the calculator's `statistics` mode.

import {
  binomCdf,
  binomPmf,
  isDomainError,
  normCdf,
  normInv,
  normPdf,
  poisCdf,
  poisPmf,
  uniformCdf,
  uniformPdf,
} from './expr/builtins.ts';

export interface Describe {
  readonly count: number;
  readonly sum: number;
  readonly mean: number;
  readonly median: number;
  readonly mode: readonly number[];
  readonly variance: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly range: number;
  readonly q1: number;
  readonly q3: number;
  readonly iqr: number;
}

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsError';
  }
}

function ensureNonEmpty(data: readonly number[]): void {
  if (data.length === 0) {
    throw new StatsError('Data must contain at least one value.');
  }
  for (const v of data) {
    if (!Number.isFinite(v)) {
      throw new StatsError(`Data contains a non-finite value (${v}).`);
    }
  }
}

export function sum(data: readonly number[]): number {
  ensureNonEmpty(data);
  let acc = 0;
  for (const v of data) acc += v;
  return acc;
}

export function mean(data: readonly number[]): number {
  ensureNonEmpty(data);
  return sum(data) / data.length;
}

export function median(data: readonly number[]): number {
  ensureNonEmpty(data);
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export function mode(data: readonly number[]): readonly number[] {
  ensureNonEmpty(data);
  const counts = new Map<number, number>();
  for (const v of data) counts.set(v, (counts.get(v) ?? 0) + 1);
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  if (max === 1) return []; // every value unique → no mode
  const modes: number[] = [];
  for (const [v, c] of counts) if (c === max) modes.push(v);
  return modes.sort((a, b) => a - b);
}

// Variance: sample (Bessel-corrected, n-1) by default. Pass `population: true`
// for the population variance (n).
export function variance(data: readonly number[], population = false): number {
  ensureNonEmpty(data);
  if (data.length === 1 && !population) {
    throw new StatsError('Sample variance requires at least 2 data points.');
  }
  const m = mean(data);
  let acc = 0;
  for (const v of data) acc += (v - m) ** 2;
  return acc / (population ? data.length : data.length - 1);
}

export function stddev(data: readonly number[], population = false): number {
  return Math.sqrt(variance(data, population));
}

// Linear-interpolation percentile (a.k.a. type-7 / Excel's PERCENTILE).
export function percentile(data: readonly number[], p: number): number {
  ensureNonEmpty(data);
  if (p < 0 || p > 100 || !Number.isFinite(p)) {
    throw new StatsError(`Percentile must be in [0, 100]; got ${p}.`);
  }
  const sorted = [...data].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower] as number;
  const frac = rank - lower;
  return (sorted[lower] as number) * (1 - frac) + (sorted[upper] as number) * frac;
}

export function describe(data: readonly number[]): Describe {
  ensureNonEmpty(data);
  const n = data.length;
  const total = sum(data);
  const m = total / n;
  let varAcc = 0;
  let mn = data[0] as number;
  let mx = data[0] as number;
  for (const v of data) {
    varAcc += (v - m) ** 2;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const sampleVar = n === 1 ? 0 : varAcc / (n - 1);
  const med = median(data);
  const q1 = percentile(data, 25);
  const q3 = percentile(data, 75);

  return {
    count: n,
    sum: total,
    mean: m,
    median: med,
    mode: mode(data),
    variance: sampleVar,
    stddev: Math.sqrt(sampleVar),
    min: mn,
    max: mx,
    range: mx - mn,
    q1,
    q3,
    iqr: q3 - q1,
  };
}

// Pearson correlation coefficient.
export function correlation(a: readonly number[], b: readonly number[]): number {
  ensureNonEmpty(a);
  ensureNonEmpty(b);
  if (a.length !== b.length) {
    throw new StatsError(
      `correlation requires equal-length series; got ${a.length} vs ${b.length}.`,
    );
  }
  if (a.length < 2) {
    throw new StatsError('correlation requires at least 2 data points.');
  }
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  if (denom === 0) {
    throw new StatsError('correlation undefined when one series has zero variance.');
  }
  return cov / denom;
}

export interface RegressionResult {
  readonly slope: number;
  readonly intercept: number;
  readonly r: number;
  readonly r_squared: number;
  readonly n: number;
}

// OLS linear regression: y = slope*x + intercept.
export function linearRegression(x: readonly number[], y: readonly number[]): RegressionResult {
  ensureNonEmpty(x);
  ensureNonEmpty(y);
  if (x.length !== y.length) {
    throw new StatsError(
      `regression requires equal-length series; got ${x.length} vs ${y.length}.`,
    );
  }
  if (x.length < 2) {
    throw new StatsError('regression requires at least 2 data points.');
  }
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = (x[i] as number) - mx;
    num += dx * ((y[i] as number) - my);
    den += dx * dx;
  }
  if (den === 0) {
    throw new StatsError('regression undefined when x has zero variance.');
  }
  const slope = num / den;
  const intercept = my - slope * mx;
  const r = correlation(x, y);
  return {
    slope,
    intercept,
    r,
    r_squared: r * r,
    n: x.length,
  };
}

// --- Distribution wrappers --------------------------------------------------

export type Distribution = 'normal' | 'binomial' | 'poisson' | 'uniform';
export type DistributionOp = 'pdf' | 'cdf' | 'quantile';

export interface DistributionParams {
  readonly mean?: number;
  readonly stddev?: number;
  readonly n?: number;
  readonly p?: number;
  readonly lambda?: number;
  readonly low?: number;
  readonly high?: number;
}

export function evaluateDistribution(
  distribution: Distribution,
  op: DistributionOp,
  value: number,
  params: DistributionParams,
): number {
  const result = dispatchDistribution(distribution, op, value, params);
  if (typeof result === 'number') return result;
  throw new StatsError(result.message);
}

function dispatchDistribution(
  distribution: Distribution,
  op: DistributionOp,
  value: number,
  params: DistributionParams,
): number | { message: string } {
  if (!Number.isFinite(value) && !(distribution === 'normal' && (op === 'pdf' || op === 'cdf'))) {
    return { message: `Distribution input "value" must be finite; got ${value}.` };
  }

  switch (distribution) {
    case 'normal': {
      const m = params.mean ?? 0;
      const sd = params.stddev ?? 1;
      if (op === 'pdf') return wrap(normPdf(value, m, sd));
      if (op === 'cdf') return wrap(normCdf(value, m, sd));
      return wrap(normInv(value, m, sd));
    }
    case 'binomial': {
      if (params.n === undefined || params.p === undefined) {
        return { message: 'binomial distribution requires n and p.' };
      }
      if (op === 'pdf') return wrap(binomPmf(value, params.n, params.p));
      if (op === 'cdf') return wrap(binomCdf(value, params.n, params.p));
      return { message: 'binomial quantile is not supported (use a search loop).' };
    }
    case 'poisson': {
      if (params.lambda === undefined) {
        return { message: 'poisson distribution requires lambda.' };
      }
      if (op === 'pdf') return wrap(poisPmf(value, params.lambda));
      if (op === 'cdf') return wrap(poisCdf(value, params.lambda));
      return { message: 'poisson quantile is not supported (use a search loop).' };
    }
    case 'uniform': {
      if (params.low === undefined || params.high === undefined) {
        return { message: 'uniform distribution requires low and high.' };
      }
      const lo = params.low;
      const hi = params.high;
      if (op === 'pdf') return wrap(uniformPdf(value, lo, hi));
      if (op === 'cdf') return wrap(uniformCdf(value, lo, hi));
      // Linear inverse-CDF for uniform.
      if (value < 0 || value > 1) {
        return { message: `uniform quantile requires 0 ≤ p ≤ 1; got ${value}.` };
      }
      return lo + value * (hi - lo);
    }
  }
}

function wrap(v: number | { _domainError: true; message: string }): number | { message: string } {
  if (isDomainError(v)) return { message: v.message };
  return v;
}
