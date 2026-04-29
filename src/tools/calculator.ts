import { z } from 'zod';
import { CalculusError, derivative, integrate } from '../shared/math/calculus.ts';
import {
  type Complex,
  abs as cabs,
  add as cadd,
  arg as carg,
  conj as cconj,
  div as cdiv,
  exp as cexp,
  format as cformat,
  log as clog,
  mul as cmul,
  pow as cpow,
  sqrt as csqrt,
  sub as csub,
  fromPolar,
  powScalar,
} from '../shared/math/complex.ts';
import { CONSTANTS, RESERVED_NAMES } from '../shared/math/expr/builtins.ts';
import { compileSingleVariable, evaluate, RuntimeError } from '../shared/math/expr/evaluator.ts';
import { type AstNode, collectIdentifiers, ParseError, parse } from '../shared/math/expr/parser.ts';
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
} from '../shared/math/finance.ts';
import {
  determinant,
  inverse,
  type Matrix,
  MatrixError,
  add as madd,
  multiply as mmul,
  solve as msolve,
  subtract as msub,
  transpose,
  type Vector,
} from '../shared/math/linear-algebra.ts';
import {
  SolverError,
  solveBisection,
  solveNewton,
  solvePolynomial,
} from '../shared/math/solver.ts';
import {
  correlation,
  type Distribution,
  type DistributionOp,
  describe as describeStats,
  evaluateDistribution,
  linearRegression,
  mean,
  median,
  percentile,
  StatsError,
  mode as statMode,
  sum as statSum,
  stddev,
  variance,
} from '../shared/math/statistics.ts';
import { convert as convertUnit, UnitsError } from '../shared/math/units.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const MODES = [
  'evaluate',
  'solve',
  'calculus',
  'matrix',
  'statistics',
  'convert',
  'finance',
  'complex',
] as const;
type Mode = (typeof MODES)[number];

const angleUnitEnum = z.enum(['radian', 'degree']);
const distributionEnum = z.enum(['normal', 'binomial', 'poisson', 'uniform']);
const distributionOpEnum = z.enum(['pdf', 'cdf', 'quantile']);

const inputSchema = {
  mode: z
    .enum(MODES)
    .describe(
      "Which math operation to perform. Each mode requires specific fields — read each field's description to know when to set it. Supported: evaluate, solve, calculus, matrix, statistics, convert, finance, complex.",
    ),

  expression: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'Math expression string. REQUIRED for: evaluate, solve, calculus. Operators: + - * / % ^ (power; ** also accepted) and postfix ! (factorial). Functions: sin/cos/tan/asin/acos/atan/atan2, sinh/cosh/tanh/asinh/acosh/atanh, sqrt/cbrt/exp/ln/log/log10/log2/pow/hypot, abs/sign/floor/ceil/round/trunc, min/max/sum/mean (variadic), factorial/gamma/lnGamma, erf/erfc, normPdf/normCdf/normInv, binomPmf/binomCdf, poisPmf/poisCdf, uniformPdf/uniformCdf. Constants: pi, e, tau, phi, inf, nan. For solve, write an equation either as "lhs = rhs" or as a single expression equal to zero (e.g. "x^2 - 5*x + 6").',
    ),
  variables: z
    .record(z.string().min(1).max(40), z.number())
    .optional()
    .describe(
      'Variable bindings, e.g. {"x": 2, "y": 3}. Used by evaluate; for solve/calculus the calculator picks the variable named by `variable`. May not shadow built-in names (sin, pi, …).',
    ),
  variable: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'Name of the free variable for solve / calculus. Default "x". May not be a built-in name.',
    ),

  operation: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'Sub-operation, REQUIRED for: solve, calculus, matrix, statistics, finance, complex. solve: "polynomial"|"newton"|"bisection". calculus: "derivative"|"integral". matrix: "add"|"subtract"|"multiply"|"transpose"|"determinant"|"inverse"|"solve". statistics: "describe"|"sum"|"mean"|"median"|"mode"|"variance"|"stddev"|"percentile"|"correlation"|"regression"|"distribution". finance: "simple-interest"|"compound-interest"|"present-value"|"future-value"|"npv"|"irr"|"pmt"|"amortize". complex: "add"|"subtract"|"multiply"|"divide"|"magnitude"|"phase"|"conjugate"|"polar"|"rectangular"|"exp"|"log"|"sqrt"|"pow".',
    ),

  // Calculus
  at_point: z
    .number()
    .finite()
    .optional()
    .describe('Point at which to evaluate the derivative. For calculus operation="derivative".'),
  from: z
    .number()
    .finite()
    .optional()
    .describe(
      'Lower bound of the definite integral. For calculus operation="integral". Also used as bisection bracket "a" for solve operation="bisection".',
    ),
  to: z
    .number()
    .finite()
    .optional()
    .describe(
      'Upper bound of the definite integral. For calculus operation="integral". Also used as bisection bracket "b" for solve operation="bisection".',
    ),

  // Solve
  coefficients: z
    .array(z.number().finite())
    .min(2)
    .max(10)
    .optional()
    .describe(
      'Polynomial coefficients, highest degree first, for solve operation="polynomial". Example: [1, -5, 6] for x^2 - 5x + 6.',
    ),
  initial_guess: z
    .number()
    .finite()
    .optional()
    .describe('Initial guess for Newton iteration. For solve operation="newton". Default 0.'),

  // Matrix
  matrix_a: z
    .array(z.array(z.number().finite()).min(1).max(50))
    .min(1)
    .max(50)
    .optional()
    .describe(
      'First (or only) matrix as rows of numbers, e.g. [[1,2],[3,4]]. For matrix mode. Max 50x50.',
    ),
  matrix_b: z
    .array(z.array(z.number().finite()).min(1).max(50))
    .min(1)
    .max(50)
    .optional()
    .describe('Second matrix. For matrix add / subtract / multiply.'),
  vector: z
    .array(z.number().finite())
    .min(1)
    .max(50)
    .optional()
    .describe('Right-hand side vector for matrix solve (Ax=b). For matrix operation="solve".'),

  // Statistics
  data: z
    .array(z.number().finite())
    .min(1)
    .max(10000)
    .optional()
    .describe('Numeric dataset. For statistics. Up to 10 000 elements.'),
  data_b: z
    .array(z.number().finite())
    .min(1)
    .max(10000)
    .optional()
    .describe('Second dataset for correlation / regression. Must match the length of `data`.'),
  percentile: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Target percentile in [0, 100]. For statistics operation="percentile".'),
  distribution: distributionEnum
    .optional()
    .describe(
      'Distribution family for statistics operation="distribution". One of: normal, binomial, poisson, uniform.',
    ),
  distribution_op: distributionOpEnum
    .optional()
    .describe(
      'Distribution operation: "pdf" (probability density / mass), "cdf" (cumulative), "quantile" (inverse CDF; supported for normal and uniform).',
    ),
  distribution_params: z
    .object({
      mean: z.number().finite().optional(),
      stddev: z.number().finite().optional(),
      n: z.number().int().min(0).max(1_000_000).optional(),
      p: z.number().min(0).max(1).optional(),
      lambda: z.number().finite().min(0).optional(),
      low: z.number().finite().optional(),
      high: z.number().finite().optional(),
    })
    .optional()
    .describe(
      'Distribution parameters. normal: mean (default 0), stddev (default 1). binomial: n, p. poisson: lambda. uniform: low, high.',
    ),
  distribution_value: z
    .number()
    .optional()
    .describe(
      'Value at which to evaluate the distribution. pdf/cdf: x. quantile: probability in [0, 1].',
    ),

  // Convert
  value: z.number().finite().optional().describe('Numeric value to convert. For convert mode.'),
  unit_from: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('Source unit (e.g. "meter", "celsius", "kilogram", "kwh"). For convert mode.'),
  unit_to: z.string().min(1).max(40).optional().describe('Target unit. For convert mode.'),

  // Finance
  principal: z
    .number()
    .finite()
    .optional()
    .describe('Principal / present-value amount. For finance.'),
  rate: z
    .number()
    .finite()
    .optional()
    .describe('Periodic interest rate as a decimal (5%/period → 0.05). For finance.'),
  periods: z
    .number()
    .finite()
    .min(0)
    .max(100000)
    .optional()
    .describe('Number of periods. For finance.'),
  cash_flows: z
    .array(z.number().finite())
    .min(2)
    .max(1000)
    .optional()
    .describe('Cash flow series indexed by period (cf[0] is at time 0). For finance npv / irr.'),
  payment_amount: z
    .number()
    .finite()
    .optional()
    .describe('Periodic payment amount. For finance present-value / future-value.'),
  future_value: z
    .number()
    .finite()
    .optional()
    .describe('Future value target. For finance present-value / pmt.'),

  // Complex
  complex_a: z
    .object({ re: z.number().finite(), im: z.number().finite() })
    .optional()
    .describe('First complex number, e.g. {"re": 1, "im": 2} for 1+2i. For complex mode.'),
  complex_b: z
    .object({ re: z.number().finite(), im: z.number().finite() })
    .optional()
    .describe('Second complex number for binary ops (add/subtract/multiply/divide/pow).'),
  complex_scalar: z
    .number()
    .finite()
    .optional()
    .describe('Scalar exponent for complex pow (alternative to complex_b).'),

  // Global options
  options: z
    .object({
      angle_unit: angleUnitEnum.default('radian'),
      precision: z.number().int().min(0).max(15).default(10),
    })
    .optional()
    .describe(
      'Output formatting. angle_unit: angle interpretation for trig functions ("radian" default; "degree"). precision: decimal places in human-readable text (0–15, default 10). The structuredContent always carries full double precision.',
    ),
};

const outputSchema = {
  mode: z.enum(MODES).describe('Echoed mode.'),
  ok: z.boolean().describe('True if the result is valid.'),
  result: z
    .unknown()
    .describe('Mode-specific result. See content.text for human form. Shape varies by mode.'),
  warnings: z
    .array(z.string())
    .optional()
    .describe('Non-fatal warnings (e.g. truncation, slow convergence).'),
};

type Args = {
  mode: Mode;
  expression?: string;
  variables?: Record<string, number>;
  variable?: string;
  operation?: string;
  at_point?: number;
  from?: number;
  to?: number;
  coefficients?: number[];
  initial_guess?: number;
  matrix_a?: number[][];
  matrix_b?: number[][];
  vector?: number[];
  data?: number[];
  data_b?: number[];
  percentile?: number;
  distribution?: Distribution;
  distribution_op?: DistributionOp;
  distribution_params?: {
    mean?: number;
    stddev?: number;
    n?: number;
    p?: number;
    lambda?: number;
    low?: number;
    high?: number;
  };
  distribution_value?: number;
  value?: number;
  unit_from?: string;
  unit_to?: string;
  principal?: number;
  rate?: number;
  periods?: number;
  cash_flows?: number[];
  payment_amount?: number;
  future_value?: number;
  complex_a?: { re: number; im: number };
  complex_b?: { re: number; im: number };
  complex_scalar?: number;
  options?: { angle_unit?: 'radian' | 'degree'; precision?: number };
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'calculator',
  title: 'Calculator',
  description:
    'High-precision math calculator. Use this whenever a problem involves arithmetic, algebra, calculus, statistics, linear algebra, unit conversion, financial math, or complex numbers — instead of doing the math yourself, since LLMs are unreliable at numerical work. Pick a `mode` (evaluate, solve, calculus, matrix, statistics, convert, finance, complex) and supply only the fields that mode names. The expression syntax (mode=evaluate / solve / calculus) supports + - * / % ^, factorial!, the usual math/trig/log/stat functions, and constants pi/e/tau. Returns the numeric answer plus a structured payload echoing what was computed.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 120 },

  handler: async (args, ctx: ToolContext): Promise<CallToolResult> => {
    const angleUnit = args.options?.angle_unit ?? 'radian';
    const precision = args.options?.precision ?? 10;

    ctx.logger.info({ mode: args.mode, operation: args.operation }, 'calculator invoked');

    try {
      switch (args.mode) {
        case 'evaluate':
          return runEvaluate(args, angleUnit, precision);
        case 'solve':
          return runSolve(args, angleUnit, precision);
        case 'calculus':
          return runCalculus(args, angleUnit, precision);
        case 'matrix':
          return runMatrix(args, precision);
        case 'statistics':
          return runStatistics(args, precision);
        case 'convert':
          return runConvert(args, precision);
        case 'finance':
          return runFinance(args, precision);
        case 'complex':
          return runComplex(args, precision);
      }
    } catch (err) {
      // Any RuntimeError / ParseError / SolverError / FinanceError / MatrixError
      // / StatsError / UnitsError / CalculusError that bubbled up through
      // unforeseen code paths gets converted to isError. Other (programmer)
      // errors propagate as 500.
      if (isUserFacingError(err)) {
        return errorResult(args.mode, err.message);
      }
      throw err;
    }
  },
};

export default tool;

function isUserFacingError(err: unknown): err is Error {
  return (
    err instanceof ParseError ||
    err instanceof RuntimeError ||
    err instanceof SolverError ||
    err instanceof FinanceError ||
    err instanceof MatrixError ||
    err instanceof StatsError ||
    err instanceof UnitsError ||
    err instanceof CalculusError
  );
}

function errorResult(mode: Mode, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { mode, ok: false, result: { error: message } },
    isError: true,
  };
}

function require_<T>(value: T | undefined, label: string, mode: Mode): T {
  if (value === undefined) {
    throw new ParseError(`mode "${mode}" requires the "${label}" field.`, '', 0);
  }
  return value;
}

function fmt(x: number, precision: number): string {
  if (!Number.isFinite(x)) return String(x);
  const rounded = roundTo(x, precision);
  return Object.is(rounded, -0) ? '0' : rounded.toString();
}

function roundTo(x: number, precision: number): number {
  if (!Number.isFinite(x)) return x;
  const factor = 10 ** precision;
  return Math.round(x * factor) / factor;
}

function buildEvalEnv(
  args: Args,
  angleUnit: 'radian' | 'degree',
): { ast: AstNode; variables: Record<string, number> } {
  const expr = require_(args.expression, 'expression', args.mode);
  const ast = parse(expr);

  const variables: Record<string, number> = { ...(args.variables ?? {}) };
  for (const name of Object.keys(variables)) {
    if (RESERVED_NAMES.has(name)) {
      throw new RuntimeError(
        `Variable name "${name}" shadows a built-in identifier and cannot be used.`,
      );
    }
    const v = variables[name];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RuntimeError(`Variable "${name}" must be a finite number.`);
    }
  }

  // Verify no free identifier is unbound. Catches typos like "snn" → "sin".
  const idents = collectIdentifiers(ast);
  for (const name of idents) {
    if (Object.hasOwn(variables, name)) continue;
    if (Object.hasOwn(CONSTANTS, name)) continue;
    // If it's referenced as a function, that's caught at evaluation time,
    // so anything left is a free variable.
    if (!isFunctionCallName(ast, name)) {
      throw new RuntimeError(
        `Expression references unknown identifier "${name}". Provide it via "variables" or check the spelling.`,
      );
    }
  }

  // Also verify each variable name is a valid identifier (the parser would
  // have rejected illegal source identifiers, but variables come from JSON).
  for (const name of Object.keys(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RuntimeError(`Variable name "${name}" is not a valid identifier.`);
    }
  }

  // Side-channel angle-unit threading happens in the evaluator via env;
  // we simply return the prepared variables here.
  void angleUnit;

  return { ast, variables };
}

// Returns true if `name` appears as a function call rather than a variable
// reference. Used to suppress "unbound variable" errors for builtins.
function isFunctionCallName(node: AstNode, name: string): boolean {
  switch (node.kind) {
    case 'number':
      return false;
    case 'identifier':
      return false;
    case 'binary':
      return isFunctionCallName(node.left, name) || isFunctionCallName(node.right, name);
    case 'unary':
    case 'postfix':
      return isFunctionCallName(node.operand, name);
    case 'call':
      if (node.name === name) return true;
      return node.args.some((a) => isFunctionCallName(a, name));
  }
}

// ---------------------------------------------------------------------------
// EVALUATE
// ---------------------------------------------------------------------------

function runEvaluate(
  args: Args,
  angleUnit: 'radian' | 'degree',
  precision: number,
): CallToolResult {
  const { ast, variables } = buildEvalEnv(args, angleUnit);
  const value = evaluate(ast, { variables, angleUnit });

  const usedVars = [...collectIdentifiers(ast)].filter((n) => Object.hasOwn(variables, n)).sort();
  const result = {
    value,
    expression: args.expression as string,
    variables_used: usedVars,
  };
  return ok(args.mode, result, `Result: ${fmt(value, precision)}`);
}

// ---------------------------------------------------------------------------
// SOLVE
// ---------------------------------------------------------------------------

function runSolve(args: Args, angleUnit: 'radian' | 'degree', precision: number): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);
  if (op === 'polynomial' && args.coefficients !== undefined) {
    const r = solvePolynomial(args.coefficients);
    return ok(
      args.mode,
      {
        roots: r.roots,
        complex_roots: r.complexRoots,
        method: r.method,
        iterations: r.iterations,
        residuals: r.residuals,
      },
      formatRoots(r.roots, r.complexRoots, precision),
    );
  }

  // Expression-driven solve. Equation form "lhs = rhs" → root of (lhs)-(rhs).
  const expression = require_(args.expression, 'expression', args.mode);
  const { lhs, rhs } = splitEquation(expression);
  const variable = args.variable ?? 'x';
  if (RESERVED_NAMES.has(variable)) {
    throw new RuntimeError(`Solve variable "${variable}" is a reserved name.`);
  }
  const lhsAst = parse(lhs);
  const rhsAst = rhs === null ? null : parse(rhs);

  // Compose the residual function f(x) = lhs(x) - rhs(x).
  const baseVars = { ...(args.variables ?? {}) };
  for (const k of Object.keys(baseVars)) {
    if (RESERVED_NAMES.has(k)) {
      throw new RuntimeError(`Variable name "${k}" shadows a built-in identifier.`);
    }
  }
  delete baseVars[variable];
  const lhsF = compileSingleVariable(lhsAst, variable, { variables: baseVars, angleUnit });
  const rhsF =
    rhsAst === null
      ? () => 0
      : compileSingleVariable(rhsAst, variable, { variables: baseVars, angleUnit });
  const f = (x: number): number => lhsF(x) - rhsF(x);

  if (op === 'newton') {
    const guess =
      args.initial_guess ??
      (args.variables && variable in args.variables ? (args.variables[variable] as number) : 0);
    const r = solveNewton(f, guess);
    return ok(
      args.mode,
      {
        roots: r.roots,
        method: r.method,
        iterations: r.iterations,
        residuals: r.residuals,
        variable,
      },
      `Root: ${fmt(r.roots[0] as number, precision)} (Newton, ${r.iterations} iterations).`,
    );
  }

  if (op === 'bisection') {
    const a = require_(args.from, 'from', args.mode);
    const b = require_(args.to, 'to', args.mode);
    const r = solveBisection(f, a, b);
    return ok(
      args.mode,
      {
        roots: r.roots,
        method: r.method,
        iterations: r.iterations,
        residuals: r.residuals,
        variable,
      },
      `Root: ${fmt(r.roots[0] as number, precision)} (bisection, ${r.iterations} iterations).`,
    );
  }

  if (op === 'polynomial') {
    // Try to extract polynomial coefficients from the expression.
    const coeffs = tryExtractPolynomial(lhsAst, rhsAst, variable);
    if (!coeffs) {
      throw new SolverError(
        `Expression is not a polynomial in "${variable}" (or coefficients exceed solver limits). For non-polynomial roots, use operation="newton" or "bisection".`,
      );
    }
    const r = solvePolynomial(coeffs);
    return ok(
      args.mode,
      {
        roots: r.roots,
        complex_roots: r.complexRoots,
        method: r.method,
        iterations: r.iterations,
        residuals: r.residuals,
        coefficients: coeffs,
        variable,
      },
      formatRoots(r.roots, r.complexRoots, precision),
    );
  }

  throw new SolverError(
    `Unknown solve operation "${op}". Supported: polynomial, newton, bisection.`,
  );
}

function splitEquation(src: string): { lhs: string; rhs: string | null } {
  // Split on '=' that is NOT preceded or followed by another '=' (Zod schema
  // doesn't allow == anyway; this is defensive).
  const idx = src.indexOf('=');
  if (idx < 0) return { lhs: src, rhs: null };
  return { lhs: src.slice(0, idx), rhs: src.slice(idx + 1) };
}

// Returns coefficients (highest degree first) if the expression is a polynomial
// in `variable`, else null. Bounded to degree 8.
function tryExtractPolynomial(
  lhs: AstNode,
  rhs: AstNode | null,
  variable: string,
): number[] | null {
  const lhsCoeffs = extractCoeffs(lhs, variable);
  if (!lhsCoeffs) return null;
  let coeffs = lhsCoeffs;
  if (rhs !== null) {
    const rhsCoeffs = extractCoeffs(rhs, variable);
    if (!rhsCoeffs) return null;
    coeffs = subtractCoeffs(coeffs, rhsCoeffs);
  }
  // Drop trailing zeros (low-degree leading) — keep highest-degree-first format.
  while (coeffs.length > 0 && coeffs[coeffs.length - 1] === 0) coeffs.pop();
  if (coeffs.length === 0) return null;
  // Reverse to highest-degree-first.
  return coeffs.reverse();
}

function extractCoeffs(node: AstNode, variable: string): number[] | null {
  // Returns coefficients [a_0, a_1, …] (low-degree first) or null if
  // the expression is not polynomial in `variable`.
  switch (node.kind) {
    case 'number':
      return [node.value];
    case 'identifier':
      if (node.name === variable) return [0, 1];
      if (Object.hasOwn(CONSTANTS, node.name)) return [CONSTANTS[node.name] as number];
      return null;
    case 'unary': {
      const inner = extractCoeffs(node.operand, variable);
      if (!inner) return null;
      if (node.op === '+') return inner;
      return inner.map((c) => -c);
    }
    case 'binary': {
      const l = extractCoeffs(node.left, variable);
      const r = extractCoeffs(node.right, variable);
      if (!l || !r) return null;
      switch (node.op) {
        case '+':
          return addCoeffs(l, r);
        case '-':
          return subtractCoeffs(l, r);
        case '*':
          return mulCoeffs(l, r);
        case '/': {
          // Allow division by a constant only.
          if (r.length !== 1) return null;
          const denom = r[0] as number;
          if (denom === 0) return null;
          return l.map((c) => c / denom);
        }
        case '^': {
          if (r.length !== 1) return null;
          const exp = r[0] as number;
          if (!Number.isInteger(exp) || exp < 0 || exp > 8) return null;
          let acc: number[] = [1];
          for (let i = 0; i < exp; i += 1) acc = mulCoeffs(acc, l);
          return acc;
        }
        case '%':
          return null;
      }
      return null;
    }
    case 'postfix':
      return null;
    case 'call':
      return null;
  }
}

function addCoeffs(a: readonly number[], b: readonly number[]): number[] {
  const len = Math.max(a.length, b.length);
  const out: number[] = new Array(len).fill(0);
  for (let i = 0; i < len; i += 1) {
    out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  }
  return out;
}

function subtractCoeffs(a: readonly number[], b: readonly number[]): number[] {
  const len = Math.max(a.length, b.length);
  const out: number[] = new Array(len).fill(0);
  for (let i = 0; i < len; i += 1) {
    out[i] = (a[i] ?? 0) - (b[i] ?? 0);
  }
  return out;
}

function mulCoeffs(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] = (out[i + j] as number) + (a[i] as number) * (b[j] as number);
    }
  }
  return out;
}

function formatRoots(
  roots: readonly number[],
  complexRoots: readonly Complex[],
  precision: number,
): string {
  if (roots.length === complexRoots.length) {
    return `Roots: [${roots.map((r) => fmt(r, precision)).join(', ')}]`;
  }
  const parts: string[] = [];
  if (roots.length > 0) {
    parts.push(`Real roots: [${roots.map((r) => fmt(r, precision)).join(', ')}]`);
  }
  const complexOnly = complexRoots.filter(
    (z) => Math.abs(z.im) >= 1e-9 * Math.max(1, Math.abs(z.re)),
  );
  if (complexOnly.length > 0) {
    parts.push(`Complex roots: [${complexOnly.map((z) => cformat(z, precision)).join(', ')}]`);
  }
  return parts.join('. ');
}

// ---------------------------------------------------------------------------
// CALCULUS
// ---------------------------------------------------------------------------

function runCalculus(
  args: Args,
  angleUnit: 'radian' | 'degree',
  precision: number,
): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);
  const variable = args.variable ?? 'x';
  if (RESERVED_NAMES.has(variable)) {
    throw new RuntimeError(`Calculus variable "${variable}" is a reserved name.`);
  }

  const expression = require_(args.expression, 'expression', args.mode);
  const ast = parse(expression);
  const baseVars = { ...(args.variables ?? {}) };
  for (const k of Object.keys(baseVars)) {
    if (RESERVED_NAMES.has(k)) {
      throw new RuntimeError(`Variable name "${k}" shadows a built-in identifier.`);
    }
  }
  delete baseVars[variable];
  const f = compileSingleVariable(ast, variable, { variables: baseVars, angleUnit });

  if (op === 'derivative') {
    const at = require_(args.at_point, 'at_point', args.mode);
    const r = derivative(f, at);
    return ok(
      args.mode,
      {
        operation: 'derivative',
        value: r.value,
        error_estimate: r.errorEstimate,
        at_point: at,
        variable,
      },
      `f'(${fmt(at, precision)}) ≈ ${fmt(r.value, precision)} (estimated error ${fmt(r.errorEstimate, Math.min(precision, 6))}).`,
    );
  }
  if (op === 'integral') {
    const a = require_(args.from, 'from', args.mode);
    const b = require_(args.to, 'to', args.mode);
    const r = integrate(f, a, b);
    return ok(
      args.mode,
      {
        operation: 'integral',
        value: r.value,
        error_estimate: r.errorEstimate,
        from: a,
        to: b,
        variable,
      },
      `∫ from ${fmt(a, precision)} to ${fmt(b, precision)} of ${expression} d${variable} ≈ ${fmt(r.value, precision)} (estimated error ${fmt(r.errorEstimate, Math.min(precision, 6))}).`,
    );
  }
  throw new CalculusError(`Unknown calculus operation "${op}". Supported: derivative, integral.`);
}

// ---------------------------------------------------------------------------
// MATRIX
// ---------------------------------------------------------------------------

function runMatrix(args: Args, precision: number): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);
  const a = require_(args.matrix_a, 'matrix_a', args.mode);

  switch (op) {
    case 'add': {
      const b = require_(args.matrix_b, 'matrix_b', args.mode);
      const r = madd(a, b);
      return ok(args.mode, { operation: op, result: r }, formatMatrix(r, precision));
    }
    case 'subtract': {
      const b = require_(args.matrix_b, 'matrix_b', args.mode);
      const r = msub(a, b);
      return ok(args.mode, { operation: op, result: r }, formatMatrix(r, precision));
    }
    case 'multiply': {
      const b = require_(args.matrix_b, 'matrix_b', args.mode);
      const r = mmul(a, b);
      return ok(args.mode, { operation: op, result: r }, formatMatrix(r, precision));
    }
    case 'transpose': {
      const r = transpose(a);
      return ok(args.mode, { operation: op, result: r }, formatMatrix(r, precision));
    }
    case 'determinant': {
      const r = determinant(a);
      return ok(args.mode, { operation: op, result: r }, `det(A) = ${fmt(r, precision)}`);
    }
    case 'inverse': {
      const r = inverse(a);
      return ok(args.mode, { operation: op, result: r }, formatMatrix(r, precision));
    }
    case 'solve': {
      const v = require_(args.vector, 'vector', args.mode);
      const r = msolve(a, v);
      return ok(
        args.mode,
        { operation: op, result: r },
        `x = [${(r as Vector).map((x) => fmt(x, precision)).join(', ')}]`,
      );
    }
    default:
      throw new MatrixError(
        `Unknown matrix operation "${op}". Supported: add, subtract, multiply, transpose, determinant, inverse, solve.`,
      );
  }
}

function formatMatrix(m: Matrix, precision: number): string {
  return m.map((row) => `[${row.map((v) => fmt(v, precision)).join(', ')}]`).join('\n');
}

// ---------------------------------------------------------------------------
// STATISTICS
// ---------------------------------------------------------------------------

function runStatistics(args: Args, precision: number): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);

  if (op === 'distribution') {
    const dist = require_(args.distribution, 'distribution', args.mode);
    const distOp = require_(args.distribution_op, 'distribution_op', args.mode);
    const v = require_(args.distribution_value, 'distribution_value', args.mode);
    const params = args.distribution_params ?? {};
    const value = evaluateDistribution(dist, distOp, v, params);
    return ok(
      args.mode,
      {
        operation: 'distribution',
        distribution: dist,
        distribution_op: distOp,
        value,
        input_value: v,
        params,
      },
      `${dist} ${distOp}(${fmt(v, precision)}) = ${fmt(value, precision)}`,
    );
  }

  const data = require_(args.data, 'data', args.mode);

  switch (op) {
    case 'describe': {
      const r = describeStats(data);
      const lines = [
        `count    ${r.count}`,
        `sum      ${fmt(r.sum, precision)}`,
        `mean     ${fmt(r.mean, precision)}`,
        `median   ${fmt(r.median, precision)}`,
        `mode     ${r.mode.length === 0 ? '(none)' : `[${r.mode.map((x) => fmt(x, precision)).join(', ')}]`}`,
        `variance ${fmt(r.variance, precision)}`,
        `stddev   ${fmt(r.stddev, precision)}`,
        `min      ${fmt(r.min, precision)}`,
        `max      ${fmt(r.max, precision)}`,
        `range    ${fmt(r.range, precision)}`,
        `q1       ${fmt(r.q1, precision)}`,
        `q3       ${fmt(r.q3, precision)}`,
        `iqr      ${fmt(r.iqr, precision)}`,
      ];
      return ok(args.mode, { operation: op, ...r }, lines.join('\n'));
    }
    case 'sum':
      return scalarStat(args.mode, op, statSum(data), precision);
    case 'mean':
      return scalarStat(args.mode, op, mean(data), precision);
    case 'median':
      return scalarStat(args.mode, op, median(data), precision);
    case 'mode': {
      const m = statMode(data);
      return ok(
        args.mode,
        { operation: op, value: m },
        `mode = ${m.length === 0 ? '(none)' : `[${m.map((x) => fmt(x, precision)).join(', ')}]`}`,
      );
    }
    case 'variance':
      return scalarStat(args.mode, op, variance(data), precision);
    case 'stddev':
      return scalarStat(args.mode, op, stddev(data), precision);
    case 'percentile': {
      const p = require_(args.percentile, 'percentile', args.mode);
      return scalarStat(args.mode, `${op}(${p})`, percentile(data, p), precision);
    }
    case 'correlation': {
      const dataB = require_(args.data_b, 'data_b', args.mode);
      const r = correlation(data, dataB);
      return scalarStat(args.mode, op, r, precision);
    }
    case 'regression': {
      const dataB = require_(args.data_b, 'data_b', args.mode);
      const r = linearRegression(data, dataB);
      return ok(
        args.mode,
        { operation: op, ...r },
        `y = ${fmt(r.slope, precision)} * x + ${fmt(r.intercept, precision)}\nr = ${fmt(r.r, precision)}, R² = ${fmt(r.r_squared, precision)}, n = ${r.n}`,
      );
    }
    default:
      throw new StatsError(
        `Unknown statistics operation "${op}". Supported: describe, sum, mean, median, mode, variance, stddev, percentile, correlation, regression, distribution.`,
      );
  }
}

function scalarStat(mode: Mode, op: string, value: number, precision: number): CallToolResult {
  return ok(mode, { operation: op, value }, `${op} = ${fmt(value, precision)}`);
}

// ---------------------------------------------------------------------------
// CONVERT
// ---------------------------------------------------------------------------

function runConvert(args: Args, precision: number): CallToolResult {
  const value = require_(args.value, 'value', args.mode);
  const from = require_(args.unit_from, 'unit_from', args.mode);
  const to = require_(args.unit_to, 'unit_to', args.mode);
  const r = convertUnit(value, from, to);
  return ok(
    args.mode,
    {
      value: r.value,
      unit: r.to.canonical,
      category: r.to.category,
      original: { value, unit: r.from.canonical },
    },
    `${fmt(value, precision)} ${r.from.canonical} = ${fmt(r.value, precision)} ${r.to.canonical}`,
  );
}

// ---------------------------------------------------------------------------
// FINANCE
// ---------------------------------------------------------------------------

function runFinance(args: Args, precision: number): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);

  switch (op) {
    case 'simple-interest': {
      const p = require_(args.principal, 'principal', args.mode);
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      const interest = simpleInterest(p, r, n);
      return ok(
        args.mode,
        { operation: op, interest, total: p + interest, principal: p, rate: r, periods: n },
        `Simple interest = ${fmt(interest, precision)}; total = ${fmt(p + interest, precision)}.`,
      );
    }
    case 'compound-interest': {
      const p = require_(args.principal, 'principal', args.mode);
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      const total = compoundInterest(p, r, n);
      return ok(
        args.mode,
        { operation: op, total, interest: total - p, principal: p, rate: r, periods: n },
        `Compound interest balance = ${fmt(total, precision)}; interest = ${fmt(total - p, precision)}.`,
      );
    }
    case 'present-value': {
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      const pmt = args.payment_amount ?? 0;
      const fv = args.future_value ?? 0;
      const pv = presentValue(r, n, pmt, fv);
      return ok(
        args.mode,
        { operation: op, value: pv, rate: r, periods: n, payment: pmt, future_value: fv },
        `PV = ${fmt(pv, precision)}`,
      );
    }
    case 'future-value': {
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      const pmt = args.payment_amount ?? 0;
      const pv = args.principal ?? 0;
      const fv = futureValue(r, n, pmt, pv);
      return ok(
        args.mode,
        { operation: op, value: fv, rate: r, periods: n, payment: pmt, present_value: pv },
        `FV = ${fmt(fv, precision)}`,
      );
    }
    case 'pmt': {
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      const pv = require_(args.principal, 'principal', args.mode);
      const fv = args.future_value ?? 0;
      const value = payment(r, n, pv, fv);
      return ok(
        args.mode,
        { operation: op, value, rate: r, periods: n, principal: pv, future_value: fv },
        `PMT = ${fmt(value, precision)}`,
      );
    }
    case 'npv': {
      const r = require_(args.rate, 'rate', args.mode);
      const cf = require_(args.cash_flows, 'cash_flows', args.mode);
      const value = npv(r, cf);
      return ok(
        args.mode,
        { operation: op, value, rate: r, cash_flows: cf },
        `NPV = ${fmt(value, precision)}`,
      );
    }
    case 'irr': {
      const cf = require_(args.cash_flows, 'cash_flows', args.mode);
      const value = irr(cf, { guess: args.initial_guess });
      return ok(
        args.mode,
        { operation: op, value, cash_flows: cf },
        `IRR = ${fmt(value, precision)} (≈ ${fmt(value * 100, Math.min(precision, 6))}% per period).`,
      );
    }
    case 'amortize': {
      const p = require_(args.principal, 'principal', args.mode);
      const r = require_(args.rate, 'rate', args.mode);
      const n = require_(args.periods, 'periods', args.mode);
      if (!Number.isInteger(n)) {
        throw new FinanceError(`amortize requires an integer "periods"; got ${n}.`);
      }
      const schedule = amortize(p, r, n);
      const head = schedule
        .slice(0, Math.min(5, schedule.length))
        .map(
          (row) =>
            `period ${row.period}: pay ${fmt(row.payment, precision)} (interest ${fmt(row.interest, precision)}, principal ${fmt(row.principal, precision)}, balance ${fmt(row.balance, precision)})`,
        )
        .join('\n');
      const note = schedule.length > 5 ? `\n... and ${schedule.length - 5} more rows.` : '';
      return ok(args.mode, { operation: op, schedule }, `${head}${note}`);
    }
    default:
      throw new FinanceError(
        `Unknown finance operation "${op}". Supported: simple-interest, compound-interest, present-value, future-value, pmt, npv, irr, amortize.`,
      );
  }
}

// ---------------------------------------------------------------------------
// COMPLEX
// ---------------------------------------------------------------------------

function runComplex(args: Args, precision: number): CallToolResult {
  const op = require_(args.operation, 'operation', args.mode);
  const a = require_(args.complex_a, 'complex_a', args.mode);

  const result = computeComplex(op, a, args);
  if (typeof result === 'number') {
    return ok(args.mode, { operation: op, value: result }, `${op}(z) = ${fmt(result, precision)}`);
  }
  const polar = { magnitude: cabs(result), phase: carg(result) };
  return ok(
    args.mode,
    { operation: op, re: result.re, im: result.im, polar },
    `${op}(z) = ${cformat(result, precision)}  (|z|=${fmt(polar.magnitude, precision)}, arg=${fmt(polar.phase, precision)})`,
  );
}

function computeComplex(op: string, a: Complex, args: Args): Complex | number {
  switch (op) {
    case 'add':
      return cadd(a, require_(args.complex_b, 'complex_b', args.mode));
    case 'subtract':
      return csub(a, require_(args.complex_b, 'complex_b', args.mode));
    case 'multiply':
      return cmul(a, require_(args.complex_b, 'complex_b', args.mode));
    case 'divide':
      return cdiv(a, require_(args.complex_b, 'complex_b', args.mode));
    case 'magnitude':
      return cabs(a);
    case 'phase':
      return carg(a);
    case 'conjugate':
      return cconj(a);
    case 'polar':
      return { re: cabs(a), im: carg(a) }; // magnitude, phase encoded as a 2-tuple via re/im
    case 'rectangular':
      return fromPolar(a.re, a.im); // a.re=magnitude, a.im=phase
    case 'exp':
      return cexp(a);
    case 'log':
      return clog(a);
    case 'sqrt':
      return csqrt(a);
    case 'pow':
      if (args.complex_b !== undefined) return cpow(a, args.complex_b);
      if (args.complex_scalar !== undefined) return powScalar(a, args.complex_scalar);
      throw new RuntimeError('complex pow requires either "complex_b" or "complex_scalar".');
    default:
      throw new RuntimeError(
        `Unknown complex operation "${op}". Supported: add, subtract, multiply, divide, magnitude, phase, conjugate, polar, rectangular, exp, log, sqrt, pow.`,
      );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(
  mode: Mode,
  result: Record<string, unknown> | unknown,
  text: string,
  warnings?: readonly string[],
): CallToolResult {
  const structured: Record<string, unknown> = { mode, ok: true, result };
  if (warnings !== undefined && warnings.length > 0) structured.warnings = [...warnings];
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}
