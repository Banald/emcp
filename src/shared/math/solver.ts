// Equation / root-finding helpers.
// - quadratic / linear: closed-form
// - polynomial of degree 3..6 supplied as coefficients: Durand–Kerner
// - general nonlinear: Newton–Raphson with a numerical derivative
// - bisection: brackets a single root in [a, b]
//
// Polynomial coefficient extraction from an AST is intentionally NOT done
// here — it lives in the calculator tool, which knows the AST shape and
// the user's `variable` choice.

import { derivative } from './calculus.ts';
import {
  type Complex,
  abs as cabs,
  add as cadd,
  mul as cmul,
  complex,
  sub as csub,
} from './complex.ts';

export class SolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolverError';
  }
}

export type SolverMethod = 'linear' | 'quadratic' | 'durand-kerner' | 'newton' | 'bisection';

export interface RootResult {
  readonly roots: readonly number[];
  readonly complexRoots: readonly Complex[];
  readonly method: SolverMethod;
  readonly iterations: number;
  readonly residuals: readonly number[];
}

const DEFAULT_TOLERANCE = 1e-10;
const DEFAULT_MAX_ITERATIONS = 200;

// ---------------------------------------------------------------------------
// Polynomial roots from coefficient array.
// Coefficients are highest-degree first: [a_n, a_{n-1}, ..., a_0].
// ---------------------------------------------------------------------------

export function solvePolynomial(coeffs: readonly number[]): RootResult {
  // Strip leading zeros so the degree reflects the real shape.
  let i = 0;
  while (i < coeffs.length - 1 && (coeffs[i] as number) === 0) i += 1;
  const c = coeffs.slice(i);
  if (c.length <= 1) {
    throw new SolverError(
      'Polynomial must have at least one non-zero coefficient besides the constant.',
    );
  }
  for (const v of c) {
    if (!Number.isFinite(v)) {
      throw new SolverError(`Polynomial has a non-finite coefficient (${v}).`);
    }
  }

  const degree = c.length - 1;
  if (degree === 1) return solveLinear(c[0] as number, c[1] as number);
  if (degree === 2) return solveQuadratic(c[0] as number, c[1] as number, c[2] as number);
  if (degree > 8) {
    throw new SolverError(`Polynomial degree ${degree} exceeds solver limit (8).`);
  }
  return solveDurandKerner(c);
}

function solveLinear(a: number, b: number): RootResult {
  if (a === 0) {
    throw new SolverError('Linear coefficient is 0.');
  }
  const root = -b / a;
  return {
    roots: [root],
    complexRoots: [complex(root, 0)],
    method: 'linear',
    iterations: 0,
    residuals: [0],
  };
}

function solveQuadratic(a: number, b: number, c: number): RootResult {
  if (a === 0) return solveLinear(b, c);
  const disc = b * b - 4 * a * c;
  if (disc >= 0) {
    const s = Math.sqrt(disc);
    const r1 = (-b + s) / (2 * a);
    const r2 = (-b - s) / (2 * a);
    const sorted = r1 <= r2 ? [r1, r2] : [r2, r1];
    return {
      roots: sorted,
      complexRoots: [complex(sorted[0] as number, 0), complex(sorted[1] as number, 0)],
      method: 'quadratic',
      iterations: 0,
      residuals: [0, 0],
    };
  }
  const re = -b / (2 * a);
  const im = Math.sqrt(-disc) / (2 * a);
  return {
    roots: [],
    complexRoots: [complex(re, im), complex(re, -im)],
    method: 'quadratic',
    iterations: 0,
    residuals: [0, 0],
  };
}

// Durand–Kerner with Aberth-style initial guesses on a circle in the complex
// plane. Iterates until max absolute correction is below tolerance, or until
// a generous iteration budget is hit.
function solveDurandKerner(coeffs: readonly number[]): RootResult {
  const degree = coeffs.length - 1;
  // Normalize so the leading coefficient is 1.
  const lead = coeffs[0] as number;
  const norm = coeffs.map((v) => v / lead);

  // Initial spread on a circle of radius R = 1 + max|c_i / c_n|.
  let r = 1;
  for (let k = 1; k <= degree; k += 1) {
    const ck = Math.abs(norm[k] as number);
    if (ck > r - 1) r = 1 + ck;
  }
  const guesses: Complex[] = [];
  for (let k = 0; k < degree; k += 1) {
    const theta = (2 * Math.PI * k) / degree + Math.PI / (2 * degree);
    guesses.push({ re: r * Math.cos(theta), im: r * Math.sin(theta) });
  }

  const evalPoly = (z: Complex): Complex => {
    let acc: Complex = { re: 1, im: 0 };
    for (let k = 1; k <= degree; k += 1) {
      acc = cadd(cmul(acc, z), { re: norm[k] as number, im: 0 });
    }
    return acc;
  };

  const tol = DEFAULT_TOLERANCE;
  let iter = 0;
  while (iter < DEFAULT_MAX_ITERATIONS) {
    iter += 1;
    let maxDelta = 0;
    for (let k = 0; k < degree; k += 1) {
      const zk = guesses[k] as Complex;
      const num = evalPoly(zk);
      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < degree; j += 1) {
        if (j === k) continue;
        denom = cmul(denom, csub(zk, guesses[j] as Complex));
      }
      // If denom is zero, perturb slightly to escape coincident roots.
      if (denom.re === 0 && denom.im === 0) {
        guesses[k] = { re: zk.re + 1e-6, im: zk.im + 1e-6 };
        maxDelta = Math.max(maxDelta, 1e-6);
        continue;
      }
      const correction = divComplex(num, denom);
      const next = csub(zk, correction);
      const delta = cabs(correction);
      if (delta > maxDelta) maxDelta = delta;
      guesses[k] = next;
    }
    if (maxDelta < tol) break;
  }

  const realRoots: number[] = [];
  const realityTol = 1e-7;
  for (const z of guesses) {
    if (Math.abs(z.im) < realityTol * Math.max(1, Math.abs(z.re))) {
      realRoots.push(z.re);
    }
  }
  realRoots.sort((a, b) => a - b);

  // Residuals computed against the original polynomial (not the normalized one).
  const residuals = guesses.map((z) => cabs(evalOriginalAt(coeffs, z)));

  return {
    roots: realRoots,
    complexRoots: guesses,
    method: 'durand-kerner',
    iterations: iter,
    residuals,
  };
}

function evalOriginalAt(coeffs: readonly number[], z: Complex): Complex {
  let acc: Complex = { re: 0, im: 0 };
  for (const c of coeffs) {
    acc = cadd(cmul(acc, z), { re: c, im: 0 });
  }
  return acc;
}

function divComplex(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  if (denom === 0) return { re: Number.NaN, im: Number.NaN };
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
}

// ---------------------------------------------------------------------------
// Newton–Raphson for general nonlinear f(x).
// ---------------------------------------------------------------------------

export function solveNewton(
  f: (x: number) => number,
  initialGuess: number,
  options: {
    readonly tolerance?: number;
    readonly maxIterations?: number;
    readonly derivativeStep?: number;
  } = {},
): RootResult {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let x = initialGuess;
  if (!Number.isFinite(x)) {
    throw new SolverError(`Newton initial guess must be finite; got ${x}.`);
  }
  for (let i = 1; i <= maxIter; i += 1) {
    const fx = f(x);
    if (!Number.isFinite(fx)) {
      throw new SolverError(`f(${x}) is non-finite at iteration ${i}.`);
    }
    if (Math.abs(fx) < tol) {
      return {
        roots: [x],
        complexRoots: [complex(x, 0)],
        method: 'newton',
        iterations: i,
        residuals: [Math.abs(fx)],
      };
    }
    const d = derivative(f, x, { initialStep: options.derivativeStep }).value;
    if (d === 0 || !Number.isFinite(d)) {
      throw new SolverError(`Derivative vanished at x=${x}; Newton cannot proceed.`);
    }
    const next = x - fx / d;
    if (!Number.isFinite(next)) {
      throw new SolverError(`Newton step diverged at x=${x}.`);
    }
    if (Math.abs(next - x) < tol * Math.max(1, Math.abs(next))) {
      const fxNext = f(next);
      return {
        roots: [next],
        complexRoots: [complex(next, 0)],
        method: 'newton',
        iterations: i,
        residuals: [Math.abs(fxNext)],
      };
    }
    x = next;
  }
  throw new SolverError(
    `Newton did not converge after ${maxIter} iterations (last x=${x}, residual=${Math.abs(f(x))}).`,
  );
}

// ---------------------------------------------------------------------------
// Bisection for a bracketed root.
// ---------------------------------------------------------------------------

export function solveBisection(
  f: (x: number) => number,
  a: number,
  b: number,
  options: { readonly tolerance?: number; readonly maxIterations?: number } = {},
): RootResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new SolverError(`Bisection brackets must be finite; got [${a}, ${b}].`);
  }
  if (a === b) {
    throw new SolverError('Bisection requires distinct brackets.');
  }
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  let fLo = f(lo);
  let fHi = f(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) {
    throw new SolverError(`f is non-finite at one of the brackets (${lo}, ${hi}).`);
  }
  if (fLo === 0) return done(lo, 1, 0);
  if (fHi === 0) return done(hi, 1, 0);
  if (fLo * fHi > 0) {
    throw new SolverError(
      `Bisection requires f(a) and f(b) to have opposite signs; got f(${lo})=${fLo}, f(${hi})=${fHi}.`,
    );
  }

  for (let i = 1; i <= maxIter; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (!Number.isFinite(fMid)) {
      throw new SolverError(`f is non-finite at midpoint x=${mid}.`);
    }
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) {
      return done(mid, i, Math.abs(fMid));
    }
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return done((lo + hi) / 2, maxIter, Math.abs(f((lo + hi) / 2)));
}

function done(x: number, iter: number, res: number): RootResult {
  return {
    roots: [x],
    complexRoots: [complex(x, 0)],
    method: 'bisection',
    iterations: iter,
    residuals: [res],
  };
}
