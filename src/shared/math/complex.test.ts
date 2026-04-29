import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abs,
  add,
  arg,
  complex,
  conj,
  div,
  equals,
  exp,
  format,
  fromPolar,
  log,
  mul,
  negate,
  pow,
  powScalar,
  sqrt,
  sub,
} from './complex.ts';

describe('complex constructor', () => {
  it('creates with explicit re/im', () => {
    const z = complex(3, 4);
    assert.equal(z.re, 3);
    assert.equal(z.im, 4);
  });

  it('defaults im to 0', () => {
    assert.equal(complex(7).im, 0);
  });
});

describe('abs / arg / conj', () => {
  it('abs is the magnitude', () => {
    assert.ok(Math.abs(abs(complex(3, 4)) - 5) < 1e-12);
    assert.equal(abs(complex(0, 0)), 0);
  });

  it('arg is the principal angle', () => {
    assert.ok(Math.abs(arg(complex(1, 0))) < 1e-12);
    assert.ok(Math.abs(arg(complex(0, 1)) - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(arg(complex(-1, 0)) - Math.PI) < 1e-12);
  });

  it('conjugate flips imaginary sign', () => {
    assert.deepEqual(conj(complex(1, 2)), { re: 1, im: -2 });
    assert.deepEqual(conj(complex(0, 0)), { re: 0, im: -0 });
  });

  it('negate flips both signs', () => {
    assert.deepEqual(negate(complex(2, -3)), { re: -2, im: 3 });
  });
});

describe('add / sub / mul / div', () => {
  it('add', () => {
    assert.deepEqual(add(complex(1, 2), complex(3, 4)), { re: 4, im: 6 });
  });

  it('sub', () => {
    assert.deepEqual(sub(complex(5, 1), complex(2, -1)), { re: 3, im: 2 });
  });

  it('mul', () => {
    // (1+2i)(3+4i) = 3+4i+6i-8 = -5+10i
    assert.deepEqual(mul(complex(1, 2), complex(3, 4)), { re: -5, im: 10 });
  });

  it('div', () => {
    // (1+2i)/(3+4i) = ((1*3+2*4)+i(2*3-1*4))/(9+16) = (11+2i)/25
    const r = div(complex(1, 2), complex(3, 4));
    assert.ok(Math.abs(r.re - 11 / 25) < 1e-12);
    assert.ok(Math.abs(r.im - 2 / 25) < 1e-12);
  });

  it('div by zero produces NaN/Infinity', () => {
    const r1 = div(complex(0, 0), complex(0, 0));
    assert.ok(Number.isNaN(r1.re));
    const r2 = div(complex(1, 0), complex(0, 0));
    assert.equal(r2.re, Number.POSITIVE_INFINITY);
    const r3 = div(complex(0, 1), complex(0, 0));
    assert.equal(r3.im, Number.POSITIVE_INFINITY);
    const r4 = div(complex(-2, 0), complex(0, 0));
    assert.equal(r4.re, Number.NEGATIVE_INFINITY);
    const r5 = div(complex(0, -2), complex(0, 0));
    assert.equal(r5.im, Number.NEGATIVE_INFINITY);
  });
});

describe('exp / log', () => {
  it('exp(0) = 1', () => {
    assert.ok(equals(exp(complex(0, 0)), complex(1, 0)));
  });

  it('exp(i*pi) = -1 (Euler)', () => {
    const r = exp(complex(0, Math.PI));
    assert.ok(Math.abs(r.re - -1) < 1e-12);
    assert.ok(Math.abs(r.im) < 1e-12);
  });

  it('log/exp roundtrip', () => {
    const z = complex(0.7, 1.3);
    const back = exp(log(z));
    assert.ok(equals(back, z, 1e-9));
  });
});

describe('pow / powScalar', () => {
  it('pow with integer-exponent uses repeated squaring', () => {
    const r = powScalar(complex(2, 3), 4);
    // (2+3i)^2 = -5+12i; (-5+12i)^2 = 25-120i+(-144) = -119 - 120i
    assert.ok(Math.abs(r.re - -119) < 1e-9);
    assert.ok(Math.abs(r.im - -120) < 1e-9);
  });

  it('powScalar(z, 0) = 1', () => {
    const r = powScalar(complex(7, -4), 0);
    assert.ok(equals(r, complex(1, 0)));
  });

  it('powScalar with non-integer falls back to log/exp', () => {
    const r = powScalar(complex(1, 0), 0.5);
    assert.ok(Math.abs(r.re - 1) < 1e-12);
  });

  it('powScalar with large exponent uses log/exp', () => {
    const r = powScalar(complex(1, 0), 100);
    assert.ok(Math.abs(r.re - 1) < 1e-9);
  });

  it('pow(0, 0) = 1 by convention', () => {
    assert.deepEqual(pow(complex(0, 0), complex(0, 0)), { re: 1, im: 0 });
  });

  it('pow(0, positive_real) = 0', () => {
    assert.deepEqual(pow(complex(0, 0), complex(2, 0)), { re: 0, im: 0 });
  });

  it('pow(0, negative_real) is NaN', () => {
    const r = pow(complex(0, 0), complex(-1, 0));
    assert.ok(Number.isNaN(r.re));
  });

  it('pow general case is exp(b * log(a))', () => {
    const r = pow(complex(2, 0), complex(0.5, 0));
    assert.ok(Math.abs(r.re - Math.SQRT2) < 1e-9);
  });
});

describe('sqrt', () => {
  it('sqrt(-1) = i', () => {
    const r = sqrt(complex(-1, 0));
    // Branch convention: positive imaginary part for negative-real input.
    assert.ok(Math.abs(r.re) < 1e-12);
    assert.ok(Math.abs(r.im - 1) < 1e-12);
  });

  it('sqrt(0) = 0', () => {
    assert.deepEqual(sqrt(complex(0, 0)), { re: 0, im: 0 });
  });

  it('sqrt squared gives back the input', () => {
    const z = complex(3, 4);
    const root = sqrt(z);
    const squared = mul(root, root);
    assert.ok(equals(squared, z, 1e-9));
  });

  it('sqrt for negative imaginary is on the lower branch', () => {
    const r = sqrt(complex(0, -2));
    // sqrt(-2i) = 1 - i
    assert.ok(Math.abs(r.re - 1) < 1e-12);
    assert.ok(Math.abs(r.im - -1) < 1e-12);
  });
});

describe('fromPolar', () => {
  it('fromPolar(1, 0) = 1', () => {
    assert.ok(equals(fromPolar(1, 0), complex(1, 0)));
  });

  it('fromPolar(2, pi/2) = 2i', () => {
    const r = fromPolar(2, Math.PI / 2);
    assert.ok(Math.abs(r.re) < 1e-12);
    assert.ok(Math.abs(r.im - 2) < 1e-12);
  });
});

describe('equals', () => {
  it('matches within tolerance', () => {
    assert.equal(equals(complex(1, 2), complex(1 + 1e-15, 2)), true);
    assert.equal(equals(complex(1, 2), complex(1.1, 2), 1e-12), false);
  });
});

describe('format', () => {
  it('renders pure real', () => {
    assert.equal(format(complex(Math.PI, 0), 4), '3.1416');
    assert.equal(format(complex(-7, 0)), '-7');
  });

  it('renders pure imaginary', () => {
    assert.equal(format(complex(0, 1)), 'i');
    assert.equal(format(complex(0, -1)), '-i');
    assert.equal(format(complex(0, 5)), '5i');
    assert.equal(format(complex(0, -3.5)), '-3.5i');
  });

  it('renders mixed', () => {
    assert.equal(format(complex(1, 2)), '1 + 2i');
    assert.equal(format(complex(3, -4)), '3 - 4i');
    assert.equal(format(complex(2, 1)), '2 + i');
    assert.equal(format(complex(2, -1)), '2 - i');
  });

  it('passes through non-finite components', () => {
    assert.match(format(complex(Number.POSITIVE_INFINITY, 0)), /Infinity/);
  });
});
