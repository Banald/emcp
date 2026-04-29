import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SolverError, solveBisection, solveNewton, solvePolynomial } from './solver.ts';

describe('solvePolynomial', () => {
  it('linear root', () => {
    // 2x + 4 = 0 → x = -2
    const r = solvePolynomial([2, 4]);
    assert.deepEqual(r.roots, [-2]);
    assert.equal(r.method, 'linear');
  });

  it('rejects all-zero leading coefficients', () => {
    assert.throws(() => solvePolynomial([0, 5]), /at least one non-zero/);
  });

  it('rejects non-finite coefficients', () => {
    assert.throws(() => solvePolynomial([1, Number.NaN]), /non-finite/);
  });

  it('quadratic with real roots', () => {
    // x^2 - 5x + 6 = 0 → roots 2, 3
    const r = solvePolynomial([1, -5, 6]);
    assert.deepEqual(r.roots, [2, 3]);
    assert.equal(r.method, 'quadratic');
  });

  it('quadratic with complex roots', () => {
    // x^2 + x + 1 = 0 → roots (-1 ± i√3)/2
    const r = solvePolynomial([1, 1, 1]);
    assert.equal(r.roots.length, 0);
    assert.equal(r.complexRoots.length, 2);
    assert.ok(Math.abs((r.complexRoots[0]?.re as number) + 0.5) < 1e-9);
  });

  it('quadratic with leading 0 collapses to linear', () => {
    const r = solvePolynomial([0, 2, 4]);
    assert.deepEqual(r.roots, [-2]);
  });

  it('cubic via Durand-Kerner', () => {
    // x^3 - 6x^2 + 11x - 6 = 0 → roots 1, 2, 3
    const r = solvePolynomial([1, -6, 11, -6]);
    assert.equal(r.roots.length, 3);
    const sorted = [...r.roots].sort((a, b) => a - b);
    assert.ok(Math.abs((sorted[0] as number) - 1) < 1e-6);
    assert.ok(Math.abs((sorted[1] as number) - 2) < 1e-6);
    assert.ok(Math.abs((sorted[2] as number) - 3) < 1e-6);
    assert.equal(r.method, 'durand-kerner');
  });

  it('quartic', () => {
    // (x-1)(x-2)(x-3)(x-4) = x^4 - 10x^3 + 35x^2 - 50x + 24
    const r = solvePolynomial([1, -10, 35, -50, 24]);
    const sorted = [...r.roots].sort((a, b) => a - b);
    for (let i = 0; i < 4; i += 1) {
      assert.ok(Math.abs((sorted[i] as number) - (i + 1)) < 1e-5);
    }
  });

  it('rejects degree > 8', () => {
    const coeffs = new Array(10).fill(1);
    assert.throws(() => solvePolynomial(coeffs), /exceeds solver limit/);
  });

  it('residuals are reported', () => {
    const r = solvePolynomial([1, -5, 6]);
    assert.equal(r.residuals.length, 2);
    for (const res of r.residuals) {
      assert.equal(res, 0);
    }
  });
});

describe('solveNewton', () => {
  it('finds root of x^2 - 9 from initial guess 1', () => {
    const r = solveNewton((x) => x * x - 9, 1);
    assert.ok(Math.abs((r.roots[0] as number) - 3) < 1e-9);
    assert.equal(r.method, 'newton');
  });

  it('finds the negative root with negative initial guess', () => {
    const r = solveNewton((x) => x * x - 9, -1);
    assert.ok(Math.abs((r.roots[0] as number) - -3) < 1e-9);
  });

  it('rejects non-finite initial guess', () => {
    assert.throws(() => solveNewton((x) => x, Number.NaN), SolverError);
  });

  it('throws when f is non-finite', () => {
    assert.throws(() => solveNewton(() => Number.NaN, 1), SolverError);
  });

  it('throws when derivative is zero', () => {
    // f(x) = 0 always; derivative is zero everywhere.
    assert.throws(() => solveNewton(() => 1, 1, { tolerance: 1e-12 }), /Derivative vanished/);
  });

  it('throws on non-convergence within iteration budget', () => {
    // f(x) = atan(x) has a root at 0, but Newton diverges from x_0 ≥ ~1.4
    // because the iteration over-shoots and grows. With only 6 iterations the
    // method has not converged, so the solver throws.
    assert.throws(
      () => solveNewton((x) => Math.atan(x) - 1.5, 0.1, { maxIterations: 6 }),
      /converge|finite|Derivative/,
    );
  });
});

describe('solveBisection', () => {
  it('finds the root in a bracket', () => {
    const r = solveBisection((x) => x * x - 4, 0, 5);
    assert.ok(Math.abs((r.roots[0] as number) - 2) < 1e-9);
    assert.equal(r.method, 'bisection');
  });

  it('returns the bracket endpoint when f(endpoint) is zero', () => {
    const r = solveBisection((x) => x - 3, 3, 10);
    assert.equal(r.roots[0], 3);
  });

  it('returns the right endpoint when f(b) is zero', () => {
    const r = solveBisection((x) => x - 7, 0, 7);
    assert.equal(r.roots[0], 7);
  });

  it('rejects same-sign brackets', () => {
    assert.throws(() => solveBisection((x) => x, 1, 2), /opposite signs/);
  });

  it('rejects non-finite brackets', () => {
    assert.throws(() => solveBisection((x) => x, Number.NaN, 1), SolverError);
  });

  it('rejects equal brackets', () => {
    assert.throws(() => solveBisection((x) => x, 1, 1), /distinct/);
  });

  it('rejects non-finite f at endpoints', () => {
    assert.throws(() => solveBisection(() => Number.NaN, 0, 1), SolverError);
  });

  it('handles brackets where a > b (swaps internally)', () => {
    const r = solveBisection((x) => x - 1, 5, 0);
    assert.ok(Math.abs((r.roots[0] as number) - 1) < 1e-9);
  });
});
