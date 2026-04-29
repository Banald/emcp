import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  amortize,
  compoundInterest,
  FinanceError,
  futureValue,
  irr,
  npv,
  payment,
  presentValue,
  simpleInterest,
} from './finance.ts';

const TOL = 1e-7;

function close(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('simpleInterest', () => {
  it('basic case', () => {
    assert.equal(simpleInterest(1000, 0.05, 3), 150);
  });

  it('rejects non-finite inputs', () => {
    assert.throws(() => simpleInterest(Number.NaN, 0.05, 1), FinanceError);
    assert.throws(() => simpleInterest(1, Number.POSITIVE_INFINITY, 1), FinanceError);
    assert.throws(() => simpleInterest(1, 0.05, Number.NaN), FinanceError);
  });
});

describe('compoundInterest', () => {
  it('1000 @ 5% for 10 years', () => {
    assert.ok(close(compoundInterest(1000, 0.05, 10), 1628.894627));
  });

  it('rate=0 leaves principal unchanged', () => {
    assert.equal(compoundInterest(1000, 0, 10), 1000);
  });
});

describe('futureValue / presentValue', () => {
  it('FV of single PV (no payments)', () => {
    // PV=1000 grows at 5% for 10 years → FV=-1628.89 (sign convention)
    assert.ok(close(futureValue(0.05, 10, 0, 1000), -1628.894627));
  });

  it('PV of single FV (no payments)', () => {
    assert.ok(close(presentValue(0.05, 10, 0, 1000), -613.913253));
  });

  it('FV of an annuity', () => {
    // PMT=-100/period, no PV, 10 periods, 5% → FV = 1257.789...
    assert.ok(close(futureValue(0.05, 10, -100, 0), 1257.78925));
  });

  it('rate=0 cases (linear)', () => {
    assert.equal(futureValue(0, 5, -100, 0), 500);
    assert.equal(presentValue(0, 5, -100, 0), 500);
    assert.equal(futureValue(0, 5, 0, 1000), -1000);
  });

  it('rejects non-finite inputs', () => {
    assert.throws(() => futureValue(Number.NaN, 1, 0, 0), FinanceError);
    assert.throws(() => presentValue(0.05, 1, Number.NaN, 0), FinanceError);
  });
});

describe('payment (PMT)', () => {
  it('mortgage-style payment', () => {
    // Borrow 100,000 at 0.5%/month for 360 months → PMT ≈ -599.55
    const pmt = payment(0.005, 360, 100000, 0);
    assert.ok(close(pmt, -599.5505255, 1e-6));
  });

  it('rate=0 splits the principal evenly', () => {
    assert.equal(payment(0, 10, 100, 0), -10);
  });

  it('with future-value target', () => {
    // Save 10000 over 10 years at 5% → PMT ≈ -795.05 (negative = outflow)
    const pmt = payment(0.05, 10, 0, 10000);
    assert.ok(close(pmt, -795.0457737, 1e-6));
  });

  it('rejects periods <= 0', () => {
    assert.throws(() => payment(0.05, 0, 100, 0), /periods > 0/);
  });

  it('rejects non-finite', () => {
    assert.throws(() => payment(Number.NaN, 10, 100, 0), FinanceError);
  });
});

describe('npv', () => {
  it('simple project', () => {
    // -1000 invested, +400 in years 1, 2, 3 at 10% discount.
    const v = npv(0.1, [-1000, 400, 400, 400]);
    // Expected: -1000 + 400/1.1 + 400/1.21 + 400/1.331 ≈ -1000 + 994.74 ≈ -5.26
    assert.ok(close(v, -5.2592035, 1e-5));
  });

  it('zero discount rate', () => {
    assert.equal(npv(0, [-100, 50, 50]), 0);
  });

  it('rejects empty cash flows', () => {
    assert.throws(() => npv(0, []), FinanceError);
  });

  it('rejects rate <= -1', () => {
    assert.throws(() => npv(-1, [1, 2]), /> -1/);
  });

  it('rejects non-finite cash flow', () => {
    assert.throws(() => npv(0, [1, Number.NaN]), FinanceError);
  });
});

describe('irr', () => {
  it('finds the rate for a simple project', () => {
    // Project: -1000 invested, +1100 next year → IRR = 10%
    const r = irr([-1000, 1100]);
    assert.ok(close(r, 0.1, 1e-6));
  });

  it('finds the rate for a multi-year project', () => {
    // Project: -1000 invested, +400, +400, +400 → IRR ≈ 9.701%
    const r = irr([-1000, 400, 400, 400]);
    assert.ok(close(r, 0.09701026, 1e-5));
  });

  it('rejects too-short cash flows', () => {
    assert.throws(() => irr([-1000]), /at least two/);
  });

  it('rejects single-sign cash flows', () => {
    assert.throws(() => irr([100, 100, 100]), /both positive and negative/);
    assert.throws(() => irr([-100, -100]), /both positive and negative/);
  });

  it('rejects non-finite inputs', () => {
    assert.throws(() => irr([1, Number.NaN, -1]), FinanceError);
  });
});

describe('amortize', () => {
  it('produces a schedule that sums to the principal', () => {
    const sched = amortize(10000, 0.05, 12);
    assert.equal(sched.length, 12);
    let totalPrincipal = 0;
    for (const row of sched) totalPrincipal += row.principal;
    assert.ok(close(totalPrincipal, 10000, 1e-6));
    // Final balance should be exactly 0.
    assert.equal(sched[11]?.balance, 0);
  });

  it('handles rate=0', () => {
    const sched = amortize(120, 0, 12);
    assert.equal(sched.length, 12);
    for (const row of sched) {
      assert.equal(row.payment, 10);
      assert.equal(row.interest, 0);
    }
    assert.equal(sched[11]?.balance, 0);
  });

  it('returns empty for zero periods', () => {
    assert.deepEqual(amortize(100, 0.05, 0), []);
  });

  it('rejects non-integer periods', () => {
    assert.throws(() => amortize(100, 0.05, 1.5), /non-negative integer/);
  });

  it('rejects negative periods', () => {
    assert.throws(() => amortize(100, 0.05, -1), /non-negative integer/);
  });
});
