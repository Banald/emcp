// Builtin functions and constants for the expression evaluator.
// All functions are total: they never throw — they signal "domain error"
// by returning a specific message via a sentinel object that the evaluator
// converts to a typed RuntimeError. Why a sentinel? It keeps each builtin
// implementation a pure (readonly args, ctx) → number | DomainError function.

export type AngleUnit = 'radian' | 'degree';

export interface BuiltinContext {
  readonly angleUnit: AngleUnit;
}

export interface DomainError {
  readonly _domainError: true;
  readonly message: string;
}

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

export function isDomainError(v: unknown): v is DomainError {
  return (
    typeof v === 'object' && v !== null && (v as { _domainError?: unknown })._domainError === true
  );
}

function domain(message: string): DomainError {
  return { _domainError: true, message };
}

function toRadians(angle: number, unit: AngleUnit): number {
  return unit === 'degree' ? angle * RAD_PER_DEG : angle;
}

function fromRadians(angle: number, unit: AngleUnit): number {
  return unit === 'degree' ? angle * DEG_PER_RAD : angle;
}

export interface BuiltinDefinition {
  readonly arity: number | { readonly min: number; readonly max: number };
  readonly impl: (args: readonly number[], ctx: BuiltinContext) => number | DomainError;
}

// Constants are also values the evaluator can bind directly.
export const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: Math.PI * 2,
  TAU: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
  PHI: (1 + Math.sqrt(5)) / 2,
  inf: Number.POSITIVE_INFINITY,
  Infinity: Number.POSITIVE_INFINITY,
  nan: Number.NaN,
  NaN: Number.NaN,
});

function mkUnary(fn: (x: number) => number): BuiltinDefinition {
  return {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      const r = fn(x);
      return r;
    },
  };
}

function mkUnaryFinite(fn: (x: number) => number, name: string): BuiltinDefinition {
  return {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      const r = fn(x);
      if (!Number.isFinite(r)) {
        return domain(`${name}(${x}) produced a non-finite value.`);
      }
      return r;
    },
  };
}

function mkVariadic(min: number, fn: (xs: readonly number[]) => number): BuiltinDefinition {
  return {
    arity: { min, max: 1024 },
    impl: (args) => fn(args),
  };
}

// Lanczos approximation for x ≥ 0.5. Numerical Recipes coefficients (g=7, n=9).
// For x < 0.5, callers must use a reflection-based wrapper (lnGammaAbs / gammaReal).
function lnGammaPositive(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const z = x - 1;
  let acc = c[0] as number;
  for (let i = 1; i < g + 2; i += 1) {
    acc += (c[i] as number) / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

// ln|Γ(x)| for any real x except non-positive integers (where Γ has poles).
// Uses reflection |Γ(x)·Γ(1−x)| = π/|sin(πx)| for x < 0.5; the absolute value
// is required because Γ(x) is negative on (-1, 0), (-3, -2), etc., so a naive
// log(π/sin(πx)) would yield NaN.
export function lnGammaAbs(x: number): number {
  if (x < 0.5) {
    const s = Math.sin(Math.PI * x);
    if (s === 0) return Number.POSITIVE_INFINITY;
    return Math.log(Math.PI / Math.abs(s)) - lnGammaAbs(1 - x);
  }
  return lnGammaPositive(x);
}

// Signed Γ(x) for any real x except non-positive integers (where the function
// has poles and the implementation returns NaN). Uses reflection for x < 0.5.
export function gammaReal(x: number): number {
  if (Number.isInteger(x) && x <= 0) return Number.NaN;
  if (x < 0.5) {
    const s = Math.sin(Math.PI * x);
    return Math.PI / (s * gammaReal(1 - x));
  }
  return Math.exp(lnGammaPositive(x));
}

export function lnFactorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return Number.NaN;
  if (n < 2) return 0;
  return lnGammaPositive(n + 1);
}

export function factorial(n: number): number | DomainError {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return domain(`factorial expects a non-negative integer; got ${n}.`);
  }
  if (n < 0) {
    return domain(`factorial of a negative number (${n}) is undefined.`);
  }
  if (n > 170) {
    // 170! ≈ 7.3e306, the largest exact double-representable factorial.
    return domain(`factorial(${n}) overflows double precision (max 170).`);
  }
  let r = 1;
  for (let i = 2; i <= n; i += 1) r *= i;
  return r;
}

// --- Probability distributions ----------------------------------------------

// Abramowitz & Stegun 7.1.26 erf approximation, ~1e-7 abs error.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function erfc(x: number): number {
  return 1 - erf(x);
}

export function normPdf(x: number, mean: number, sd: number): number | DomainError {
  if (sd <= 0) return domain(`normPdf requires sd > 0; got ${sd}.`);
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

export function normCdf(x: number, mean: number, sd: number): number | DomainError {
  if (sd <= 0) return domain(`normCdf requires sd > 0; got ${sd}.`);
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

// Acklam's algorithm for the inverse standard-normal CDF, ~1.15e-9 max error.
export function normInv(p: number, mean: number, sd: number): number | DomainError {
  if (sd <= 0) return domain(`normInv requires sd > 0; got ${sd}.`);
  if (p <= 0 || p >= 1) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    return domain(`normInv requires 0 ≤ p ≤ 1; got ${p}.`);
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  let z: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    z =
      (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) *
        q +
        (c[4] as number)) *
        q +
      (c[5] as number);
    z /=
      ((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
      1;
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    z =
      (((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) *
        r +
        (a[4] as number)) *
        r +
      (a[5] as number);
    z *= q;
    z /=
      (((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) *
        r +
        (b[4] as number)) *
        r +
      1;
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    z =
      -(
        ((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
          (c[3] as number)) *
          q +
        (c[4] as number)
      ) *
        q -
      (c[5] as number);
    z /=
      ((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
      1;
  }
  return mean + sd * z;
}

export function binomPmf(k: number, n: number, p: number): number | DomainError {
  if (!Number.isInteger(n) || n < 0) return domain(`binomPmf requires integer n ≥ 0; got ${n}.`);
  if (!Number.isInteger(k)) return domain(`binomPmf requires integer k; got ${k}.`);
  if (p < 0 || p > 1) return domain(`binomPmf requires 0 ≤ p ≤ 1; got ${p}.`);
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  const logC = lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

export function binomCdf(k: number, n: number, p: number): number | DomainError {
  if (!Number.isInteger(n) || n < 0) return domain(`binomCdf requires integer n ≥ 0; got ${n}.`);
  if (!Number.isInteger(k)) return domain(`binomCdf requires integer k; got ${k}.`);
  if (p < 0 || p > 1) return domain(`binomCdf requires 0 ≤ p ≤ 1; got ${p}.`);
  if (k < 0) return 0;
  if (k >= n) return 1;
  let total = 0;
  for (let i = 0; i <= k; i += 1) {
    const term = binomPmf(i, n, p);
    if (isDomainError(term)) return term;
    total += term;
  }
  return Math.min(1, total);
}

export function poisPmf(k: number, lambda: number): number | DomainError {
  if (lambda < 0) return domain(`poisPmf requires lambda ≥ 0; got ${lambda}.`);
  if (!Number.isInteger(k) || k < 0) return domain(`poisPmf requires integer k ≥ 0; got ${k}.`);
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - lnFactorial(k));
}

export function poisCdf(k: number, lambda: number): number | DomainError {
  if (lambda < 0) return domain(`poisCdf requires lambda ≥ 0; got ${lambda}.`);
  if (!Number.isInteger(k) || k < 0) return domain(`poisCdf requires integer k ≥ 0; got ${k}.`);
  let total = 0;
  for (let i = 0; i <= k; i += 1) {
    const term = poisPmf(i, lambda);
    if (isDomainError(term)) return term;
    total += term;
  }
  return Math.min(1, total);
}

export function uniformPdf(x: number, low: number, high: number): number | DomainError {
  if (high <= low) return domain(`uniformPdf requires high > low; got [${low}, ${high}].`);
  if (x < low || x > high) return 0;
  return 1 / (high - low);
}

export function uniformCdf(x: number, low: number, high: number): number | DomainError {
  if (high <= low) return domain(`uniformCdf requires high > low; got [${low}, ${high}].`);
  if (x <= low) return 0;
  if (x >= high) return 1;
  return (x - low) / (high - low);
}

// Builtin function table. Frozen so the evaluator can never mutate it.
export const BUILTINS: Readonly<Record<string, BuiltinDefinition>> = Object.freeze({
  // Basic math
  abs: mkUnary(Math.abs),
  sign: mkUnary(Math.sign),
  floor: mkUnary(Math.floor),
  ceil: mkUnary(Math.ceil),
  round: mkUnary((x) => Math.round(x)),
  trunc: mkUnary(Math.trunc),
  sqrt: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x < 0) return domain(`sqrt of a negative number (${x}) is not real.`);
      return Math.sqrt(x);
    },
  },
  cbrt: mkUnary(Math.cbrt),
  exp: mkUnaryFinite(Math.exp, 'exp'),
  ln: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x <= 0) return domain(`ln of a non-positive number (${x}) is undefined.`);
      return Math.log(x);
    },
  },
  log: {
    // log(x) ≡ natural log; matches Math.log convention.
    arity: { min: 1, max: 2 },
    impl: (args) => {
      const x = args[0] as number;
      if (x <= 0) return domain(`log of a non-positive number (${x}) is undefined.`);
      if (args.length === 2) {
        const base = args[1] as number;
        if (base <= 0 || base === 1) return domain(`log base must be > 0 and ≠ 1; got ${base}.`);
        return Math.log(x) / Math.log(base);
      }
      return Math.log(x);
    },
  },
  log10: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x <= 0) return domain(`log10 of a non-positive number (${x}) is undefined.`);
      return Math.log10(x);
    },
  },
  log2: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x <= 0) return domain(`log2 of a non-positive number (${x}) is undefined.`);
      return Math.log2(x);
    },
  },
  pow: {
    arity: 2,
    impl: (args) => {
      const x = args[0] as number;
      const y = args[1] as number;
      const r = x ** y;
      if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) {
        return domain(`pow(${x}, ${y}) produced a non-finite value.`);
      }
      return r;
    },
  },
  hypot: mkVariadic(1, (xs) => Math.hypot(...xs)),

  // Trigonometry — angle-unit aware
  sin: { arity: 1, impl: (args, ctx) => Math.sin(toRadians(args[0] as number, ctx.angleUnit)) },
  cos: { arity: 1, impl: (args, ctx) => Math.cos(toRadians(args[0] as number, ctx.angleUnit)) },
  tan: { arity: 1, impl: (args, ctx) => Math.tan(toRadians(args[0] as number, ctx.angleUnit)) },
  asin: {
    arity: 1,
    impl: (args, ctx) => {
      const x = args[0] as number;
      if (x < -1 || x > 1) return domain(`asin requires -1 ≤ x ≤ 1; got ${x}.`);
      return fromRadians(Math.asin(x), ctx.angleUnit);
    },
  },
  acos: {
    arity: 1,
    impl: (args, ctx) => {
      const x = args[0] as number;
      if (x < -1 || x > 1) return domain(`acos requires -1 ≤ x ≤ 1; got ${x}.`);
      return fromRadians(Math.acos(x), ctx.angleUnit);
    },
  },
  atan: { arity: 1, impl: (args, ctx) => fromRadians(Math.atan(args[0] as number), ctx.angleUnit) },
  atan2: {
    arity: 2,
    impl: (args, ctx) =>
      fromRadians(Math.atan2(args[0] as number, args[1] as number), ctx.angleUnit),
  },
  sinh: mkUnary(Math.sinh),
  cosh: mkUnary(Math.cosh),
  tanh: mkUnary(Math.tanh),
  asinh: mkUnary(Math.asinh),
  acosh: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x < 1) return domain(`acosh requires x ≥ 1; got ${x}.`);
      return Math.acosh(x);
    },
  },
  atanh: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (x <= -1 || x >= 1) return domain(`atanh requires -1 < x < 1; got ${x}.`);
      return Math.atanh(x);
    },
  },

  // Aggregates
  min: mkVariadic(1, (xs) => Math.min(...xs)),
  max: mkVariadic(1, (xs) => Math.max(...xs)),
  sum: mkVariadic(1, (xs) => xs.reduce((a, b) => a + b, 0)),
  mean: mkVariadic(1, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length),

  // Combinatorial
  factorial: { arity: 1, impl: (args) => factorial(args[0] as number) },
  gamma: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (Number.isInteger(x) && x <= 0)
        return domain(`gamma is undefined at non-positive integers (${x}).`);
      const r = gammaReal(x);
      if (!Number.isFinite(r)) return domain(`gamma(${x}) overflows.`);
      return r;
    },
  },
  lnGamma: {
    arity: 1,
    impl: (args) => {
      const x = args[0] as number;
      if (Number.isInteger(x) && x <= 0)
        return domain(`lnGamma is undefined at non-positive integers (${x}).`);
      // Returns ln|Γ(x)| — for negative non-integer x where Γ is negative, the
      // sign of Γ is lost. Callers needing the signed value should use gamma(x).
      return lnGammaAbs(x);
    },
  },

  // Distributions
  erf: mkUnary(erf),
  erfc: mkUnary(erfc),
  normPdf: {
    arity: 3,
    impl: (args) => normPdf(args[0] as number, args[1] as number, args[2] as number),
  },
  normCdf: {
    arity: 3,
    impl: (args) => normCdf(args[0] as number, args[1] as number, args[2] as number),
  },
  normInv: {
    arity: 3,
    impl: (args) => normInv(args[0] as number, args[1] as number, args[2] as number),
  },
  binomPmf: {
    arity: 3,
    impl: (args) => binomPmf(args[0] as number, args[1] as number, args[2] as number),
  },
  binomCdf: {
    arity: 3,
    impl: (args) => binomCdf(args[0] as number, args[1] as number, args[2] as number),
  },
  poisPmf: { arity: 2, impl: (args) => poisPmf(args[0] as number, args[1] as number) },
  poisCdf: { arity: 2, impl: (args) => poisCdf(args[0] as number, args[1] as number) },
  uniformPdf: {
    arity: 3,
    impl: (args) => uniformPdf(args[0] as number, args[1] as number, args[2] as number),
  },
  uniformCdf: {
    arity: 3,
    impl: (args) => uniformCdf(args[0] as number, args[1] as number, args[2] as number),
  },
});

// Builtin and constant names a user variable may not shadow.
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(BUILTINS),
  ...Object.keys(CONSTANTS),
]);
