// Financial math: simple/compound interest, present/future value, NPV,
// IRR (bisection then Newton refinement), level periodic payment (PMT).
// All rates are decimals per period (5% per period → 0.05).

export class FinanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceError';
  }
}

function ensureFinite(label: string, x: number): void {
  if (!Number.isFinite(x)) throw new FinanceError(`${label} must be finite; got ${x}.`);
}

function ensurePositiveInteger(label: string, x: number): void {
  if (!Number.isInteger(x) || x < 0) {
    throw new FinanceError(`${label} must be a non-negative integer; got ${x}.`);
  }
}

// Simple interest: I = P * r * t. Returns interest only.
export function simpleInterest(principal: number, rate: number, periods: number): number {
  ensureFinite('principal', principal);
  ensureFinite('rate', rate);
  ensureFinite('periods', periods);
  return principal * rate * periods;
}

// Compound interest: A = P * (1+r)^n. Returns the *final balance* (P+I).
export function compoundInterest(principal: number, rate: number, periods: number): number {
  ensureFinite('principal', principal);
  ensureFinite('rate', rate);
  ensureFinite('periods', periods);
  return principal * (1 + rate) ** periods;
}

// Future value of a series: PV grown plus PMT annuity.
//   FV = -PV*(1+r)^n - PMT * ((1+r)^n - 1)/r        (when r ≠ 0)
//   FV = -PV - PMT*n                                (when r = 0)
// Convention: PV and PMT are cash *outflows* (negative); FV is the amount you
// receive. Sign convention follows Excel/Google Sheets.
export function futureValue(
  rate: number,
  periods: number,
  payment: number,
  presentValue: number,
): number {
  ensureFinite('rate', rate);
  ensureFinite('periods', periods);
  ensureFinite('payment', payment);
  ensureFinite('presentValue', presentValue);
  if (rate === 0) {
    return -presentValue - payment * periods;
  }
  const factor = (1 + rate) ** periods;
  return -presentValue * factor - (payment * (factor - 1)) / rate;
}

// Present value of a future amount + annuity.
//   PV = -FV/(1+r)^n - PMT*(1 - (1+r)^-n)/r        (r ≠ 0)
//   PV = -FV - PMT*n                                (r = 0)
export function presentValue(
  rate: number,
  periods: number,
  payment: number,
  futureValueAmount: number,
): number {
  ensureFinite('rate', rate);
  ensureFinite('periods', periods);
  ensureFinite('payment', payment);
  ensureFinite('futureValue', futureValueAmount);
  if (rate === 0) {
    return -futureValueAmount - payment * periods;
  }
  const factor = (1 + rate) ** -periods;
  return -futureValueAmount * factor - (payment * (1 - factor)) / rate;
}

// Periodic payment (PMT) to amortize a present value to a target future
// value over `periods` periods.
//   PMT = -(PV*(1+r)^n + FV) * r / ((1+r)^n - 1)   (r ≠ 0)
//   PMT = -(PV + FV)/n                              (r = 0)
export function payment(
  rate: number,
  periods: number,
  presentValueAmount: number,
  futureValueAmount = 0,
): number {
  ensureFinite('rate', rate);
  ensureFinite('periods', periods);
  ensureFinite('presentValue', presentValueAmount);
  ensureFinite('futureValue', futureValueAmount);
  if (periods <= 0) {
    throw new FinanceError(`payment requires periods > 0; got ${periods}.`);
  }
  if (rate === 0) {
    return -(presentValueAmount + futureValueAmount) / periods;
  }
  const factor = (1 + rate) ** periods;
  return (-(presentValueAmount * factor + futureValueAmount) * rate) / (factor - 1);
}

// Net present value: Σ cf_i / (1+r)^i. Cash flow cf_0 is at time 0 and is
// not discounted; cf_1 is at the end of period 1; etc.
export function npv(rate: number, cashFlows: readonly number[]): number {
  ensureFinite('rate', rate);
  if (cashFlows.length === 0) throw new FinanceError('npv requires at least one cash flow.');
  if (rate <= -1) throw new FinanceError(`npv discount rate must be > -1; got ${rate}.`);
  let acc = 0;
  for (let i = 0; i < cashFlows.length; i += 1) {
    const cf = cashFlows[i] as number;
    ensureFinite(`cashFlows[${i}]`, cf);
    acc += cf / (1 + rate) ** i;
  }
  return acc;
}

// Internal rate of return: the rate r such that NPV(r) = 0.
// Strategy: bracket via expanding bisection, then Newton refine. We require
// a sign change on the cash-flow series (otherwise IRR is undefined).
export function irr(
  cashFlows: readonly number[],
  options: {
    readonly guess?: number;
    readonly tolerance?: number;
    readonly maxIterations?: number;
  } = {},
): number {
  if (cashFlows.length < 2) {
    throw new FinanceError('irr requires at least two cash flows.');
  }
  let hasPositive = false;
  let hasNegative = false;
  for (const cf of cashFlows) {
    ensureFinite('cashFlows[i]', cf);
    if (cf > 0) hasPositive = true;
    if (cf < 0) hasNegative = true;
  }
  if (!hasPositive || !hasNegative) {
    throw new FinanceError('irr requires cash flows with both positive and negative values.');
  }

  const tol = options.tolerance ?? 1e-9;
  const maxIter = options.maxIterations ?? 100;

  // Bisection bracket. Search outward from the guess until f(low)*f(high) < 0.
  const guess = options.guess ?? 0.1;
  let lo = guess - 0.5;
  let hi = guess + 0.5;
  if (lo <= -1) lo = -0.999;
  let fLo = npv(lo, cashFlows);
  let fHi = npv(hi, cashFlows);
  let span = 1;
  while (fLo * fHi > 0 && span < 64) {
    span *= 2;
    lo = guess - span;
    hi = guess + span;
    if (lo <= -1) lo = -0.9999;
    fLo = npv(lo, cashFlows);
    fHi = npv(hi, cashFlows);
  }
  if (fLo * fHi > 0) {
    throw new FinanceError(
      'irr could not bracket a root: NPV does not change sign in the searched range. Cash flows with multiple sign changes can have multiple IRRs; supply a closer "guess" near the rate of interest.',
    );
  }

  // Bisect to a tight bracket. Only `fLo` is consulted on subsequent iterations
  // (the sign test is `fLo * fMid`), so we don't update `fHi` inside this loop.
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, cashFlows);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) {
      return refineNewton(cashFlows, mid, tol, maxIter);
    }
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return refineNewton(cashFlows, (lo + hi) / 2, tol, maxIter);
}

function npvDerivative(rate: number, cashFlows: readonly number[]): number {
  let acc = 0;
  for (let i = 1; i < cashFlows.length; i += 1) {
    const cf = cashFlows[i] as number;
    acc -= (i * cf) / (1 + rate) ** (i + 1);
  }
  return acc;
}

function refineNewton(
  cashFlows: readonly number[],
  start: number,
  tol: number,
  maxIter: number,
): number {
  let r = start;
  for (let i = 0; i < maxIter; i += 1) {
    const f = npv(r, cashFlows);
    if (Math.abs(f) < tol) return r;
    const fp = npvDerivative(r, cashFlows);
    if (fp === 0 || !Number.isFinite(fp)) return r;
    const next = r - f / fp;
    if (!Number.isFinite(next) || next <= -1) return r;
    if (Math.abs(next - r) < tol * Math.max(1, Math.abs(next))) return next;
    r = next;
  }
  return r;
}

// Amortization breakdown for a fully-amortizing level loan. Returns an array
// of per-period entries with the interest portion, principal portion, and
// remaining balance.
export interface AmortRow {
  readonly period: number;
  readonly payment: number;
  readonly interest: number;
  readonly principal: number;
  readonly balance: number;
}

export function amortize(principal: number, rate: number, periods: number): readonly AmortRow[] {
  ensureFinite('principal', principal);
  ensureFinite('rate', rate);
  ensurePositiveInteger('periods', periods);
  if (periods === 0) return [];
  const pmt = -payment(rate, periods, principal, 0); // positive payment outflow
  const out: AmortRow[] = [];
  let balance = principal;
  for (let i = 1; i <= periods; i += 1) {
    const interest = balance * rate;
    const principalPaid = pmt - interest;
    balance = balance - principalPaid;
    if (i === periods) balance = 0; // snap final balance
    out.push({
      period: i,
      payment: pmt,
      interest,
      principal: principalPaid,
      balance,
    });
  }
  return out;
}
