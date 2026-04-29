import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CalculusError, derivative, integrate } from './calculus.ts';

describe('derivative', () => {
  it('d/dx x^2 at x=3 ≈ 6', () => {
    const r = derivative((x) => x * x, 3);
    assert.ok(Math.abs(r.value - 6) < 1e-7);
    assert.ok(r.errorEstimate >= 0);
  });

  it('d/dx sin(x) at 0 ≈ 1', () => {
    const r = derivative(Math.sin, 0);
    assert.ok(Math.abs(r.value - 1) < 1e-7);
  });

  it('d/dx exp(x) at x=0 ≈ 1', () => {
    const r = derivative(Math.exp, 0);
    assert.ok(Math.abs(r.value - 1) < 1e-7);
  });

  it('rejects non-finite x', () => {
    assert.throws(() => derivative((x) => x, Number.NaN), CalculusError);
  });

  it('rejects when sample is non-finite', () => {
    assert.throws(() => derivative(() => Number.NaN, 1), CalculusError);
  });

  it('honors a custom initialStep', () => {
    const r = derivative((x) => x * x * x, 1, { initialStep: 1e-3 });
    assert.ok(Math.abs(r.value - 3) < 1e-6);
  });
});

describe('integrate', () => {
  it('∫x dx from 0 to 1 = 0.5', () => {
    const r = integrate((x) => x, 0, 1);
    assert.ok(Math.abs(r.value - 0.5) < 1e-9);
  });

  it('∫sin(x) dx from 0 to π = 2', () => {
    const r = integrate(Math.sin, 0, Math.PI);
    assert.ok(Math.abs(r.value - 2) < 1e-9);
  });

  it('reverses sign on swapped bounds', () => {
    const fwd = integrate((x) => x, 0, 1).value;
    const rev = integrate((x) => x, 1, 0).value;
    assert.ok(Math.abs(fwd + rev) < 1e-12);
  });

  it('returns 0 when bounds equal', () => {
    const r = integrate((x) => x, 5, 5);
    assert.equal(r.value, 0);
    assert.equal(r.errorEstimate, 0);
  });

  it('rejects non-finite bounds', () => {
    assert.throws(() => integrate((x) => x, 0, Number.POSITIVE_INFINITY), CalculusError);
    assert.throws(() => integrate((x) => x, Number.NaN, 1), CalculusError);
  });

  it('rejects integrand non-finite at sample', () => {
    assert.throws(() => integrate(() => Number.NaN, 0, 1), CalculusError);
  });

  it('approximates ∫exp(-x^2) from -3 to 3 ≈ √π * erf(3)', () => {
    const r = integrate((x) => Math.exp(-x * x), -3, 3);
    // erf(3) ≈ 0.999977909
    const expected = Math.sqrt(Math.PI) * 0.999977909;
    assert.ok(Math.abs(r.value - expected) < 1e-6);
  });

  it('handles very tight tolerance request', () => {
    const r = integrate((x) => x * x, 0, 1, { tolerance: 1e-12 });
    assert.ok(Math.abs(r.value - 1 / 3) < 1e-9);
  });
});
