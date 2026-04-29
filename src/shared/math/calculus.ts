// Numerical calculus: derivative via central-difference + Richardson
// extrapolation, definite integral via adaptive Simpson.
//
// Both helpers take a function `(number) => number` (already compiled from
// an expression by the caller) so they can sample without re-walking the AST.

const DEFAULT_DERIV_TOL = 1e-9;
const DEFAULT_INTEGRAL_TOL = 1e-9;
const ADAPT_DEPTH_LIMIT = 24;

export class CalculusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculusError';
  }
}

export interface DerivativeResult {
  readonly value: number;
  readonly errorEstimate: number;
}

// 5-point central-difference + Richardson extrapolation. Returns the
// estimated derivative and a Richardson-derived error bound.
//
// f'(x) ≈ ( -f(x+2h) + 8 f(x+h) - 8 f(x-h) + f(x-2h) ) / (12 h)
//
// Halving h and combining the two estimates gives an extra order of accuracy
// and a cheap error proxy.
export function derivative(
  f: (x: number) => number,
  x: number,
  options: { readonly initialStep?: number; readonly tolerance?: number } = {},
): DerivativeResult {
  if (!Number.isFinite(x)) {
    throw new CalculusError(`derivative requires a finite point; got ${x}.`);
  }
  const h0 = options.initialStep ?? Math.max(1e-4, Math.abs(x) * 1e-5 || 1e-4);
  const tol = options.tolerance ?? DEFAULT_DERIV_TOL;

  let prev = sample5(f, x, h0);
  let err = Number.POSITIVE_INFINITY;
  let h = h0;
  for (let iter = 0; iter < 12; iter += 1) {
    h /= 2;
    const cur = sample5(f, x, h);
    err = Math.abs(cur - prev);
    if (err < tol * Math.max(1, Math.abs(cur))) {
      return { value: cur, errorEstimate: err };
    }
    prev = cur;
  }
  return { value: prev, errorEstimate: err };
}

function sample5(f: (x: number) => number, x: number, h: number): number {
  const a = f(x - 2 * h);
  const b = f(x - h);
  const c = f(x + h);
  const d = f(x + 2 * h);
  if (![a, b, c, d].every(Number.isFinite)) {
    throw new CalculusError(
      `derivative sample produced a non-finite value at x=${x} with step ${h}.`,
    );
  }
  return (a - 8 * b + 8 * c - d) / (12 * h);
}

export interface IntegralResult {
  readonly value: number;
  readonly errorEstimate: number;
}

// Adaptive Simpson's rule. Splits each subinterval until the local error
// estimate is below the requested tolerance, bounded by depth.
export function integrate(
  f: (x: number) => number,
  a: number,
  b: number,
  options: { readonly tolerance?: number } = {},
): IntegralResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new CalculusError(`integrate requires finite bounds; got [${a}, ${b}].`);
  }
  if (a === b) return { value: 0, errorEstimate: 0 };
  const tol = options.tolerance ?? DEFAULT_INTEGRAL_TOL;

  const sign = a < b ? 1 : -1;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  const fa = f(lo);
  const fb = f(hi);
  const c = (lo + hi) / 2;
  const fc = f(c);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || !Number.isFinite(fc)) {
    throw new CalculusError(`integrand is non-finite on [${a}, ${b}].`);
  }
  const whole = simpson(fa, fc, fb, hi - lo);

  const { value, error } = adapt(f, lo, hi, fa, fc, fb, whole, tol, 0);
  return { value: sign * value, errorEstimate: error };
}

function simpson(fa: number, fc: number, fb: number, width: number): number {
  return (width / 6) * (fa + 4 * fc + fb);
}

function adapt(
  f: (x: number) => number,
  lo: number,
  hi: number,
  fa: number,
  fc: number,
  fb: number,
  whole: number,
  tol: number,
  depth: number,
): { readonly value: number; readonly error: number } {
  const c = (lo + hi) / 2;
  const d = (lo + c) / 2;
  const e = (c + hi) / 2;
  const fd = f(d);
  const fe = f(e);
  if (!Number.isFinite(fd) || !Number.isFinite(fe)) {
    throw new CalculusError(`integrand is non-finite at midpoint sample.`);
  }
  const left = simpson(fa, fd, fc, c - lo);
  const right = simpson(fc, fe, fb, hi - c);
  const both = left + right;
  const err = Math.abs(both - whole) / 15;
  if (depth >= ADAPT_DEPTH_LIMIT || err < tol) {
    // Richardson-corrected return.
    return { value: both + (both - whole) / 15, error: err };
  }
  const newTol = tol / 2;
  const leftRes = adapt(f, lo, c, fa, fd, fc, left, newTol, depth + 1);
  const rightRes = adapt(f, c, hi, fc, fe, fb, right, newTol, depth + 1);
  return {
    value: leftRes.value + rightRes.value,
    error: leftRes.error + rightRes.error,
  };
}
