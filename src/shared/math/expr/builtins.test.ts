import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILTINS,
  binomCdf,
  binomPmf,
  CONSTANTS,
  erf,
  erfc,
  factorial,
  gammaReal,
  isDomainError,
  lnFactorial,
  lnGammaAbs,
  normCdf,
  normInv,
  normPdf,
  poisCdf,
  poisPmf,
  RESERVED_NAMES,
  uniformCdf,
  uniformPdf,
} from './builtins.ts';

describe('CONSTANTS', () => {
  it('exposes pi, e, tau, phi', () => {
    assert.equal(CONSTANTS.pi, Math.PI);
    assert.equal(CONSTANTS.e, Math.E);
    assert.equal(CONSTANTS.tau, Math.PI * 2);
    assert.ok(Math.abs((CONSTANTS.phi as number) - 1.618033988749895) < 1e-12);
  });

  it('is frozen', () => {
    assert.throws(() => {
      (CONSTANTS as Record<string, number>).pi = 0;
    });
  });
});

describe('isDomainError', () => {
  it('detects the sentinel shape', () => {
    assert.equal(isDomainError({ _domainError: true, message: 'x' }), true);
    assert.equal(isDomainError(null), false);
    assert.equal(isDomainError(0), false);
    assert.equal(isDomainError({ _domainError: false }), false);
  });
});

describe('factorial', () => {
  it('returns exact factorials for small n', () => {
    assert.equal(factorial(0), 1);
    assert.equal(factorial(1), 1);
    assert.equal(factorial(5), 120);
    assert.equal(factorial(10), 3628800);
  });

  it('rejects non-integers', () => {
    const r = factorial(2.5);
    assert.equal(isDomainError(r), true);
  });

  it('rejects negative integers', () => {
    const r = factorial(-3);
    assert.equal(isDomainError(r), true);
  });

  it('rejects values that overflow', () => {
    const r = factorial(200);
    assert.equal(isDomainError(r), true);
  });

  it('rejects non-finite input', () => {
    const r = factorial(Number.POSITIVE_INFINITY);
    assert.equal(isDomainError(r), true);
  });
});

describe('lnFactorial', () => {
  it('matches log(factorial) for small n', () => {
    for (let n = 2; n <= 20; n += 1) {
      const expected = Math.log(factorial(n) as number);
      const got = lnFactorial(n);
      assert.ok(Math.abs(got - expected) < 1e-9, `n=${n}: ${got} vs ${expected}`);
    }
  });

  it('returns 0 for 0 and 1', () => {
    assert.equal(lnFactorial(0), 0);
    assert.equal(lnFactorial(1), 0);
  });

  it('returns NaN for negative or non-integer', () => {
    assert.ok(Number.isNaN(lnFactorial(-1)));
    assert.ok(Number.isNaN(lnFactorial(0.5)));
  });
});

describe('erf / erfc', () => {
  it('erf(0) is 0', () => {
    assert.ok(Math.abs(erf(0)) < 1e-9);
  });

  it('erf is odd', () => {
    for (const x of [0.5, 1, 2]) {
      assert.ok(Math.abs(erf(x) + erf(-x)) < 1e-7);
    }
  });

  it('erf approaches 1 as x grows', () => {
    assert.ok(Math.abs(erf(5) - 1) < 1e-6);
  });

  it('erfc(x) = 1 - erf(x)', () => {
    assert.ok(Math.abs(erfc(0.7) - (1 - erf(0.7))) < 1e-12);
  });
});

describe('normPdf / normCdf / normInv', () => {
  it('rejects sd <= 0', () => {
    const r = normPdf(0, 0, 0);
    assert.equal(isDomainError(r), true);
  });

  it('normPdf at the mean equals 1/(σ√2π)', () => {
    const r = normPdf(0, 0, 1);
    const expected = 1 / Math.sqrt(2 * Math.PI);
    assert.ok(typeof r === 'number' && Math.abs(r - expected) < 1e-9);
  });

  it('normCdf(0) = 0.5', () => {
    const r = normCdf(0, 0, 1);
    assert.ok(typeof r === 'number' && Math.abs(r - 0.5) < 1e-7);
  });

  it('normCdf(∞) ≈ 1', () => {
    const r = normCdf(10, 0, 1);
    assert.ok(typeof r === 'number' && r > 0.999999);
  });

  it('normInv(0.5) = 0', () => {
    const r = normInv(0.5, 0, 1);
    assert.ok(typeof r === 'number' && Math.abs(r) < 1e-7);
  });

  it('normInv inverts normCdf', () => {
    for (const p of [0.1, 0.25, 0.75, 0.9, 0.97]) {
      const z = normInv(p, 0, 1) as number;
      const back = normCdf(z, 0, 1) as number;
      assert.ok(Math.abs(back - p) < 1e-6, `p=${p}: ${back}`);
    }
  });

  it('normInv handles edge probabilities', () => {
    assert.equal(normInv(0, 0, 1), Number.NEGATIVE_INFINITY);
    assert.equal(normInv(1, 0, 1), Number.POSITIVE_INFINITY);
    assert.equal(isDomainError(normInv(-0.1, 0, 1)), true);
    assert.equal(isDomainError(normInv(1.5, 0, 1)), true);
  });

  it('normInv with location/scale', () => {
    const r = normInv(0.975, 5, 2) as number;
    // P(Z<1.96)=0.975 → x = 5 + 2*1.96 ≈ 8.9199
    assert.ok(Math.abs(r - 8.9199) < 0.01);
  });
});

describe('binomPmf / binomCdf', () => {
  it('PMF sums to 1 over support', () => {
    let s = 0;
    for (let k = 0; k <= 10; k += 1) s += binomPmf(k, 10, 0.3) as number;
    assert.ok(Math.abs(s - 1) < 1e-9);
  });

  it('binomPmf(0, n, 0) = 1; PMF(k>0, n, 0) = 0', () => {
    assert.equal(binomPmf(0, 5, 0), 1);
    assert.equal(binomPmf(2, 5, 0), 0);
  });

  it('binomPmf(n, n, 1) = 1; binomPmf(k<n, n, 1) = 0', () => {
    assert.equal(binomPmf(5, 5, 1), 1);
    assert.equal(binomPmf(3, 5, 1), 0);
  });

  it('binomPmf rejects bad params', () => {
    assert.equal(isDomainError(binomPmf(0, -1, 0.5)), true);
    assert.equal(isDomainError(binomPmf(0.5, 5, 0.5)), true);
    assert.equal(isDomainError(binomPmf(0, 5, -0.1)), true);
  });

  it('binomPmf returns 0 when k out of range', () => {
    assert.equal(binomPmf(-1, 5, 0.5), 0);
    assert.equal(binomPmf(6, 5, 0.5), 0);
  });

  it('binomCdf accumulates PMF', () => {
    const c = binomCdf(3, 10, 0.5) as number;
    let manual = 0;
    for (let k = 0; k <= 3; k += 1) manual += binomPmf(k, 10, 0.5) as number;
    assert.ok(Math.abs(c - manual) < 1e-9);
  });

  it('binomCdf saturates at 0 / 1 outside support', () => {
    assert.equal(binomCdf(-1, 5, 0.5), 0);
    assert.equal(binomCdf(10, 5, 0.5), 1);
  });
});

describe('poisPmf / poisCdf', () => {
  it('poisPmf at lambda=0', () => {
    assert.equal(poisPmf(0, 0), 1);
    assert.equal(poisPmf(3, 0), 0);
  });

  it('poisPmf sums to ~1', () => {
    let s = 0;
    for (let k = 0; k <= 30; k += 1) s += poisPmf(k, 3) as number;
    assert.ok(Math.abs(s - 1) < 1e-9);
  });

  it('poisCdf(k=∞) ≈ 1', () => {
    const r = poisCdf(50, 5) as number;
    assert.ok(r > 1 - 1e-9);
  });

  it('rejects bad inputs', () => {
    assert.equal(isDomainError(poisPmf(0, -1)), true);
    assert.equal(isDomainError(poisPmf(-1, 1)), true);
    assert.equal(isDomainError(poisCdf(-1, 1)), true);
    assert.equal(isDomainError(poisCdf(2, -1)), true);
  });
});

describe('uniformPdf / uniformCdf', () => {
  it('PDF is constant 1/(b-a) inside, 0 outside', () => {
    assert.equal(uniformPdf(0.5, 0, 1), 1);
    assert.equal(uniformPdf(0, 0, 1), 1);
    assert.equal(uniformPdf(1, 0, 1), 1);
    assert.equal(uniformPdf(-1, 0, 1), 0);
    assert.equal(uniformPdf(2, 0, 1), 0);
  });

  it('CDF is linear', () => {
    assert.equal(uniformCdf(0.25, 0, 1), 0.25);
    assert.equal(uniformCdf(-1, 0, 1), 0);
    assert.equal(uniformCdf(2, 0, 1), 1);
  });

  it('rejects high <= low', () => {
    assert.equal(isDomainError(uniformPdf(0, 1, 1)), true);
    assert.equal(isDomainError(uniformCdf(0, 2, 1)), true);
  });
});

describe('BUILTINS table', () => {
  function call(name: string, args: number[], angleUnit: 'radian' | 'degree' = 'radian'): number {
    const def = BUILTINS[name];
    if (!def) throw new Error(`no builtin ${name}`);
    const r = def.impl(args, { angleUnit });
    if (typeof r !== 'number') throw new Error(String(r));
    return r;
  }

  it('basic math: abs, sign, floor, ceil, round, trunc', () => {
    assert.equal(call('abs', [-3.5]), 3.5);
    assert.equal(call('sign', [-7]), -1);
    assert.equal(call('floor', [3.7]), 3);
    assert.equal(call('ceil', [3.2]), 4);
    assert.equal(call('round', [3.5]), 4);
    assert.equal(call('trunc', [-3.9]), -3);
  });

  it('sqrt rejects negatives, accepts zero', () => {
    assert.equal(call('sqrt', [16]), 4);
    assert.equal(call('sqrt', [0]), 0);
    const def = BUILTINS.sqrt;
    if (!def) throw new Error('no sqrt');
    assert.equal(isDomainError(def.impl([-1], { angleUnit: 'radian' })), true);
  });

  it('cbrt accepts negatives', () => {
    assert.ok(Math.abs(call('cbrt', [-8]) - -2) < 1e-12);
  });

  it('exp produces non-finite domain error on overflow', () => {
    const def = BUILTINS.exp;
    if (!def) throw new Error('no exp');
    assert.equal(isDomainError(def.impl([1000], { angleUnit: 'radian' })), true);
  });

  it('ln rejects non-positive', () => {
    const def = BUILTINS.ln;
    if (!def) throw new Error('no ln');
    assert.equal(isDomainError(def.impl([0], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(def.impl([-1], { angleUnit: 'radian' })), true);
    assert.ok(Math.abs(call('ln', [Math.E]) - 1) < 1e-12);
  });

  it('log accepts an optional base argument', () => {
    assert.ok(Math.abs(call('log', [Math.E]) - 1) < 1e-12);
    assert.ok(Math.abs(call('log', [1000, 10]) - 3) < 1e-12);
    const def = BUILTINS.log;
    if (!def) throw new Error('no log');
    assert.equal(isDomainError(def.impl([1, 1], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(def.impl([1, -2], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(def.impl([0], { angleUnit: 'radian' })), true);
  });

  it('log10 / log2 reject non-positive', () => {
    const log10 = BUILTINS.log10;
    const log2 = BUILTINS.log2;
    if (!log10 || !log2) throw new Error('missing logs');
    assert.equal(isDomainError(log10.impl([0], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(log2.impl([-1], { angleUnit: 'radian' })), true);
    assert.ok(Math.abs(call('log10', [1000]) - 3) < 1e-12);
    assert.ok(Math.abs(call('log2', [8]) - 3) < 1e-12);
  });

  it('pow handles ordinary cases', () => {
    assert.equal(call('pow', [2, 10]), 1024);
  });

  it('hypot computes Euclidean magnitude', () => {
    assert.ok(Math.abs(call('hypot', [3, 4]) - 5) < 1e-12);
    assert.equal(call('hypot', [5]), 5);
  });

  it('trig functions respect angle_unit', () => {
    assert.ok(Math.abs(call('sin', [Math.PI / 2]) - 1) < 1e-12);
    assert.ok(Math.abs(call('sin', [90], 'degree') - 1) < 1e-12);
    assert.ok(Math.abs(call('cos', [0]) - 1) < 1e-12);
    assert.ok(Math.abs(call('tan', [45], 'degree') - 1) < 1e-12);
  });

  it('asin/acos reject out-of-range; atan/atan2 accept anything finite', () => {
    const asin = BUILTINS.asin;
    const acos = BUILTINS.acos;
    if (!asin || !acos) throw new Error('missing inverse trig');
    assert.equal(isDomainError(asin.impl([1.5], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(acos.impl([-2], { angleUnit: 'radian' })), true);
    assert.ok(Math.abs(call('atan', [1]) - Math.PI / 4) < 1e-12);
    assert.ok(Math.abs(call('atan', [1], 'degree') - 45) < 1e-12);
    assert.ok(Math.abs(call('atan2', [1, 1]) - Math.PI / 4) < 1e-12);
  });

  it('hyperbolic trig roundtrips', () => {
    assert.ok(Math.abs(call('sinh', [0]) - 0) < 1e-12);
    assert.ok(Math.abs(call('cosh', [0]) - 1) < 1e-12);
    assert.ok(Math.abs(call('tanh', [0]) - 0) < 1e-12);
    assert.ok(Math.abs(call('asinh', [Math.sinh(2)]) - 2) < 1e-9);
    const acosh = BUILTINS.acosh;
    const atanh = BUILTINS.atanh;
    if (!acosh || !atanh) throw new Error('missing');
    assert.equal(isDomainError(acosh.impl([0.5], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(atanh.impl([1], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(atanh.impl([-1], { angleUnit: 'radian' })), true);
  });

  it('aggregates: min, max, sum, mean', () => {
    assert.equal(call('min', [3, 1, 2]), 1);
    assert.equal(call('max', [3, 1, 2]), 3);
    assert.equal(call('sum', [1, 2, 3, 4]), 10);
    assert.equal(call('mean', [2, 4, 6]), 4);
  });

  it('factorial via builtin', () => {
    assert.equal(call('factorial', [5]), 120);
  });

  it('gamma, lnGamma reject non-positive integers', () => {
    const gamma = BUILTINS.gamma;
    const lng = BUILTINS.lnGamma;
    if (!gamma || !lng) throw new Error('missing gamma');
    assert.equal(isDomainError(gamma.impl([0], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(gamma.impl([-3], { angleUnit: 'radian' })), true);
    assert.equal(isDomainError(lng.impl([-1], { angleUnit: 'radian' })), true);
    assert.ok(Math.abs(call('gamma', [5]) - 24) < 1e-9);
    assert.ok(Math.abs(call('lnGamma', [10]) - Math.log(362880)) < 1e-9);
  });

  it('gamma returns the correct signed value for negative non-integers', () => {
    // Γ(-0.5) = -2√π ≈ -3.5449077018110318
    assert.ok(Math.abs(call('gamma', [-0.5]) - -2 * Math.sqrt(Math.PI)) < 1e-9);
    // Γ(-1.5) = (4/3)√π ≈ 2.3632718012073494
    assert.ok(Math.abs(call('gamma', [-1.5]) - (4 / 3) * Math.sqrt(Math.PI)) < 1e-9);
    // Γ(-2.5) = -(8/15)√π ≈ -0.9453087204829418
    assert.ok(Math.abs(call('gamma', [-2.5]) - -(8 / 15) * Math.sqrt(Math.PI)) < 1e-9);
    // Γ(0.5) = √π
    assert.ok(Math.abs(call('gamma', [0.5]) - Math.sqrt(Math.PI)) < 1e-9);
    // Sanity: gammaReal directly
    assert.ok(Math.abs(gammaReal(-0.5) - -2 * Math.sqrt(Math.PI)) < 1e-9);
  });

  it('lnGamma returns ln|Γ(x)| for negative non-integer x', () => {
    // ln|Γ(-0.5)| = ln(2√π) ≈ 1.2655121234846454
    assert.ok(Math.abs(call('lnGamma', [-0.5]) - Math.log(2 * Math.sqrt(Math.PI))) < 1e-9);
    // ln|Γ(-1.5)| = ln((4/3)√π)
    assert.ok(Math.abs(call('lnGamma', [-1.5]) - Math.log((4 / 3) * Math.sqrt(Math.PI))) < 1e-9);
    // lnGammaAbs directly
    assert.ok(Math.abs(lnGammaAbs(-0.5) - Math.log(2 * Math.sqrt(Math.PI))) < 1e-9);
  });

  it('distribution builtins delegate to standalone functions', () => {
    assert.ok(Math.abs(call('normPdf', [0, 0, 1]) - 1 / Math.sqrt(2 * Math.PI)) < 1e-9);
    assert.ok(Math.abs(call('normCdf', [0, 0, 1]) - 0.5) < 1e-7);
    assert.ok(Math.abs(call('uniformPdf', [0.5, 0, 1]) - 1) < 1e-12);
    assert.ok(Math.abs(call('uniformCdf', [0.25, 0, 1]) - 0.25) < 1e-12);
    assert.equal(call('binomPmf', [0, 5, 0]), 1);
    assert.equal(call('poisPmf', [0, 0]), 1);
    assert.ok(Math.abs(call('binomCdf', [3, 10, 0.5]) - 0.171875) < 1e-6);
    assert.ok(Math.abs(call('poisCdf', [3, 2]) - 0.857123) < 1e-5);
  });

  it('frozen — cannot replace entries', () => {
    assert.throws(() => {
      (BUILTINS as Record<string, unknown>).sin = null;
    });
  });
});

describe('RESERVED_NAMES', () => {
  it('contains every builtin and constant', () => {
    for (const k of Object.keys(BUILTINS)) assert.equal(RESERVED_NAMES.has(k), true);
    for (const k of Object.keys(CONSTANTS)) assert.equal(RESERVED_NAMES.has(k), true);
  });

  it('does not contain user-style names', () => {
    assert.equal(RESERVED_NAMES.has('x'), false);
    assert.equal(RESERVED_NAMES.has('myvar'), false);
  });
});
