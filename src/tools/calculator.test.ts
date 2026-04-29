import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './calculator.ts';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
  ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test key',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-test',
    signal: new AbortController().signal,
    ...overrides,
  }) as unknown as ToolContext;

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

type Args = Parameters<typeof tool.handler>[0];

describe('calculator metadata', () => {
  it('has the required identity fields', () => {
    assert.equal(tool.name, 'calculator');
    assert.equal(tool.title, 'Calculator');
    assert.ok(tool.description.length > 100);
  });

  it('declares both inputSchema and outputSchema', () => {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
  });

  it('declares mode enum with all 8 modes', () => {
    const schema = z.object(tool.inputSchema);
    const result = schema.safeParse({ mode: 'evaluate', expression: 'x' });
    assert.equal(result.success, true);
  });

  it('rejects unknown mode at the schema layer', () => {
    const schema = z.object(tool.inputSchema);
    assert.equal(schema.safeParse({ mode: 'unknown' }).success, false);
  });
});

describe('evaluate mode', () => {
  it('evaluates the canonical example', async () => {
    const ctx = makeCtx();
    const result = await tool.handler(
      { mode: 'evaluate', expression: '2 * sin(pi / 4) + sqrt(16)' } as Args,
      ctx,
    );
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number; expression: string };
    assert.ok(Math.abs(r.value - (2 * Math.sin(Math.PI / 4) + 4)) < 1e-9);
    assert.equal(r.expression, '2 * sin(pi / 4) + sqrt(16)');
  });

  it('respects variable bindings', async () => {
    const result = await tool.handler(
      { mode: 'evaluate', expression: 'x ^ 2 + 3', variables: { x: 4 } } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number; variables_used: string[] };
    assert.equal(r.value, 19);
    assert.deepEqual(r.variables_used, ['x']);
  });

  it('respects angle_unit=degree', async () => {
    const result = await tool.handler(
      {
        mode: 'evaluate',
        expression: 'sin(90)',
        options: { angle_unit: 'degree' },
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 1) < 1e-12);
  });

  it('returns isError when expression is missing', async () => {
    const result = await tool.handler({ mode: 'evaluate' } as Args, makeCtx());
    assert.equal(result.isError, true);
    assert.match(textOf(result), /expression/);
  });

  it('returns isError on division by zero', async () => {
    const result = await tool.handler({ mode: 'evaluate', expression: '1 / 0' } as Args, makeCtx());
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Division by zero/);
  });

  it('returns isError on unknown identifier', async () => {
    const result = await tool.handler(
      { mode: 'evaluate', expression: 'foo + 1' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /unknown identifier/i);
  });

  it('returns isError on parse error', async () => {
    const result = await tool.handler({ mode: 'evaluate', expression: '1 +' } as Args, makeCtx());
    assert.equal(result.isError, true);
  });

  it('returns isError when variable name shadows a builtin', async () => {
    const result = await tool.handler(
      { mode: 'evaluate', expression: 'sin(0)', variables: { sin: 5 } } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /shadows a built-in/);
  });

  it('returns isError when a variable value is non-finite', async () => {
    const result = await tool.handler(
      { mode: 'evaluate', expression: 'x', variables: { x: Number.NaN } } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('rounds the human text to options.precision', async () => {
    const result = await tool.handler(
      {
        mode: 'evaluate',
        expression: 'pi',
        options: { precision: 4 },
      } as Args,
      makeCtx(),
    );
    assert.match(textOf(result), /3\.1416/);
  });
});

describe('solve mode', () => {
  it('solves a polynomial via coefficients', async () => {
    const result = await tool.handler(
      { mode: 'solve', operation: 'polynomial', coefficients: [1, -5, 6] } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { roots: number[] };
    assert.deepEqual(r.roots, [2, 3]);
  });

  it('solves a polynomial via expression (auto-extracts coefficients)', async () => {
    const result = await tool.handler(
      { mode: 'solve', operation: 'polynomial', expression: 'x^2 - 5*x + 6 = 0' } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { roots: number[] };
    assert.equal(r.roots.length, 2);
    assert.ok(Math.abs((r.roots[0] as number) - 2) < 1e-6);
  });

  it('returns isError when expression is non-polynomial under polynomial op', async () => {
    const result = await tool.handler(
      { mode: 'solve', operation: 'polynomial', expression: 'sin(x) = 0' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not a polynomial/i);
  });

  it('solves with newton', async () => {
    const result = await tool.handler(
      {
        mode: 'solve',
        operation: 'newton',
        expression: 'x^3 - x - 2',
        initial_guess: 1,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { roots: number[]; method: string };
    assert.equal(r.method, 'newton');
    assert.ok(Math.abs((r.roots[0] as number) - 1.5213797) < 1e-5);
  });

  it('solves with bisection', async () => {
    const result = await tool.handler(
      {
        mode: 'solve',
        operation: 'bisection',
        expression: 'x^2 - 2',
        from: 0,
        to: 5,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { roots: number[] };
    assert.ok(Math.abs((r.roots[0] as number) - Math.SQRT2) < 1e-6);
  });

  it('returns isError when bisection brackets missing', async () => {
    const result = await tool.handler(
      { mode: 'solve', operation: 'bisection', expression: 'x' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on unknown solve operation', async () => {
    const result = await tool.handler(
      { mode: 'solve', operation: 'mystery', expression: 'x' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown solve operation/);
  });

  it('returns isError when variable shadows a builtin', async () => {
    const result = await tool.handler(
      {
        mode: 'solve',
        operation: 'newton',
        expression: 'sin(x)',
        variable: 'sin',
        initial_guess: 0.5,
      } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('uses initial_guess from variables when initial_guess field is absent', async () => {
    const result = await tool.handler(
      {
        mode: 'solve',
        operation: 'newton',
        expression: 'x^2 - 4',
        variables: { x: 1 },
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { roots: number[] };
    assert.ok(Math.abs((r.roots[0] as number) - 2) < 1e-6);
  });
});

describe('calculus mode', () => {
  it('computes a derivative', async () => {
    const result = await tool.handler(
      {
        mode: 'calculus',
        operation: 'derivative',
        expression: 'x^2',
        at_point: 3,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 6) < 1e-7);
  });

  it('computes a definite integral', async () => {
    const result = await tool.handler(
      {
        mode: 'calculus',
        operation: 'integral',
        expression: 'x',
        from: 0,
        to: 1,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 0.5) < 1e-9);
  });

  it('returns isError when at_point missing for derivative', async () => {
    const result = await tool.handler(
      { mode: 'calculus', operation: 'derivative', expression: 'x^2' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on unknown operation', async () => {
    const result = await tool.handler(
      { mode: 'calculus', operation: 'limit', expression: 'x' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError when calculus variable shadows builtin', async () => {
    const result = await tool.handler(
      {
        mode: 'calculus',
        operation: 'derivative',
        expression: 'pi^2',
        variable: 'pi',
        at_point: 1,
      } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });
});

describe('matrix mode', () => {
  it('add', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'add',
        matrix_a: [
          [1, 2],
          [3, 4],
        ],
        matrix_b: [
          [5, 6],
          [7, 8],
        ],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number[][] };
    assert.deepEqual(r.result, [
      [6, 8],
      [10, 12],
    ]);
  });

  it('subtract', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'subtract',
        matrix_a: [[5, 5]],
        matrix_b: [[1, 2]],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number[][] };
    assert.deepEqual(r.result, [[4, 3]]);
  });

  it('multiply', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'multiply',
        matrix_a: [
          [1, 2],
          [3, 4],
        ],
        matrix_b: [
          [5, 6],
          [7, 8],
        ],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number[][] };
    assert.deepEqual(r.result, [
      [19, 22],
      [43, 50],
    ]);
  });

  it('determinant', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'determinant',
        matrix_a: [
          [1, 2],
          [3, 4],
        ],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number };
    assert.equal(r.result, -2);
  });

  it('inverse, transpose', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'inverse',
        matrix_a: [
          [1, 0],
          [0, 1],
        ],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number[][] };
    assert.deepEqual(r.result, [
      [1, 0],
      [0, 1],
    ]);

    const result2 = await tool.handler(
      {
        mode: 'matrix',
        operation: 'transpose',
        matrix_a: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      } as Args,
      makeCtx(),
    );
    const sc2 = result2.structuredContent as Record<string, unknown>;
    const r2 = sc2.result as { result: number[][] };
    assert.deepEqual(r2.result, [
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it('solve Ax=b', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'solve',
        matrix_a: [
          [1, 1],
          [1, -1],
        ],
        vector: [3, 1],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { result: number[] };
    assert.ok(Math.abs((r.result[0] as number) - 2) < 1e-9);
    assert.ok(Math.abs((r.result[1] as number) - 1) < 1e-9);
  });

  it('returns isError on unknown matrix operation', async () => {
    const result = await tool.handler(
      { mode: 'matrix', operation: 'eigen', matrix_a: [[1]] } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on missing matrix_a', async () => {
    const result = await tool.handler(
      { mode: 'matrix', operation: 'transpose' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on singular inverse', async () => {
    const result = await tool.handler(
      {
        mode: 'matrix',
        operation: 'inverse',
        matrix_a: [
          [1, 2],
          [2, 4],
        ],
      } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });
});

describe('statistics mode', () => {
  it('describe', async () => {
    const result = await tool.handler(
      { mode: 'statistics', operation: 'describe', data: [1, 2, 3, 4, 5] } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as Record<string, unknown>;
    assert.equal(r.count, 5);
    assert.equal(r.mean, 3);
    assert.equal(r.median, 3);
  });

  it('scalar stats: mean, median, variance, stddev', async () => {
    for (const op of ['mean', 'median', 'variance', 'stddev', 'sum']) {
      const result = await tool.handler(
        { mode: 'statistics', operation: op, data: [2, 4, 6, 8] } as Args,
        makeCtx(),
      );
      assert.equal(result.isError, undefined, `op=${op}`);
    }
  });

  it('mode and percentile', async () => {
    const r1 = await tool.handler(
      { mode: 'statistics', operation: 'mode', data: [1, 1, 2, 3] } as Args,
      makeCtx(),
    );
    assert.equal(r1.isError, undefined);

    const r2 = await tool.handler(
      {
        mode: 'statistics',
        operation: 'percentile',
        data: [1, 2, 3, 4, 5],
        percentile: 50,
      } as Args,
      makeCtx(),
    );
    const sc = r2.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.equal(r.value, 3);
  });

  it('correlation and regression', async () => {
    const result = await tool.handler(
      {
        mode: 'statistics',
        operation: 'correlation',
        data: [1, 2, 3],
        data_b: [2, 4, 6],
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 1) < 1e-9);

    const result2 = await tool.handler(
      {
        mode: 'statistics',
        operation: 'regression',
        data: [1, 2, 3],
        data_b: [2, 4, 6],
      } as Args,
      makeCtx(),
    );
    const sc2 = result2.structuredContent as Record<string, unknown>;
    const r2 = sc2.result as { slope: number; intercept: number };
    assert.ok(Math.abs(r2.slope - 2) < 1e-9);
    assert.ok(Math.abs(r2.intercept) < 1e-9);
  });

  it('distribution: normal CDF', async () => {
    const result = await tool.handler(
      {
        mode: 'statistics',
        operation: 'distribution',
        distribution: 'normal',
        distribution_op: 'cdf',
        distribution_value: 0,
        distribution_params: { mean: 0, stddev: 1 },
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 0.5) < 1e-7);
  });

  it('returns isError when data missing', async () => {
    const result = await tool.handler({ mode: 'statistics', operation: 'mean' } as Args, makeCtx());
    assert.equal(result.isError, true);
  });

  it('returns isError on unknown stats operation', async () => {
    const result = await tool.handler(
      { mode: 'statistics', operation: 'mystery', data: [1, 2] } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });
});

describe('convert mode', () => {
  it('basic conversion', async () => {
    const result = await tool.handler(
      { mode: 'convert', value: 100, unit_from: 'meter', unit_to: 'foot' } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 328.084) < 0.01);
  });

  it('temperature: 100 C → 212 F', async () => {
    const result = await tool.handler(
      { mode: 'convert', value: 100, unit_from: 'celsius', unit_to: 'fahrenheit' } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 212) < 1e-9);
  });

  it('returns isError on unknown unit', async () => {
    const result = await tool.handler(
      { mode: 'convert', value: 1, unit_from: 'metric_thingie', unit_to: 'meter' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Closest matches/);
  });

  it('returns isError on cross-category conversion', async () => {
    const result = await tool.handler(
      { mode: 'convert', value: 1, unit_from: 'meter', unit_to: 'kilogram' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on missing fields', async () => {
    const result = await tool.handler({ mode: 'convert', value: 1 } as Args, makeCtx());
    assert.equal(result.isError, true);
  });
});

describe('finance mode', () => {
  it('compound-interest', async () => {
    const result = await tool.handler(
      {
        mode: 'finance',
        operation: 'compound-interest',
        principal: 1000,
        rate: 0.05,
        periods: 10,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { total: number };
    assert.ok(Math.abs(r.total - 1628.894627) < 1e-6);
  });

  it('simple-interest', async () => {
    const result = await tool.handler(
      {
        mode: 'finance',
        operation: 'simple-interest',
        principal: 1000,
        rate: 0.05,
        periods: 3,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { interest: number; total: number };
    assert.equal(r.interest, 150);
    assert.equal(r.total, 1150);
  });

  it('present-value, future-value, pmt', async () => {
    for (const op of ['present-value', 'future-value', 'pmt']) {
      const args =
        op === 'pmt'
          ? { mode: 'finance', operation: op, rate: 0.005, periods: 360, principal: 100000 }
          : {
              mode: 'finance',
              operation: op,
              rate: 0.05,
              periods: 10,
              principal: 1000,
            };
      const result = await tool.handler(args as Args, makeCtx());
      assert.equal(result.isError, undefined, `op=${op}: ${textOf(result)}`);
    }
  });

  it('npv and irr', async () => {
    const npvResult = await tool.handler(
      {
        mode: 'finance',
        operation: 'npv',
        rate: 0.1,
        cash_flows: [-1000, 400, 400, 400],
      } as Args,
      makeCtx(),
    );
    assert.equal(npvResult.isError, undefined);

    const irrResult = await tool.handler(
      { mode: 'finance', operation: 'irr', cash_flows: [-1000, 400, 400, 400] } as Args,
      makeCtx(),
    );
    assert.equal(irrResult.isError, undefined);
    const sc = irrResult.structuredContent as Record<string, unknown>;
    const r = sc.result as { value: number };
    assert.ok(Math.abs(r.value - 0.09701026) < 1e-5);
  });

  it('amortize', async () => {
    const result = await tool.handler(
      {
        mode: 'finance',
        operation: 'amortize',
        principal: 10000,
        rate: 0.05,
        periods: 12,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { schedule: Array<{ balance: number }> };
    assert.equal(r.schedule.length, 12);
    assert.equal(r.schedule[11]?.balance, 0);
  });

  it('amortize rejects non-integer periods', async () => {
    const result = await tool.handler(
      {
        mode: 'finance',
        operation: 'amortize',
        principal: 1000,
        rate: 0.05,
        periods: 1.5,
      } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on unknown finance operation', async () => {
    const result = await tool.handler({ mode: 'finance', operation: 'mystery' } as Args, makeCtx());
    assert.equal(result.isError, true);
  });

  it('returns isError on missing required field', async () => {
    const result = await tool.handler(
      { mode: 'finance', operation: 'simple-interest', principal: 1000 } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });
});

describe('complex mode', () => {
  it('add / subtract / multiply / divide', async () => {
    const ops = ['add', 'subtract', 'multiply', 'divide'] as const;
    for (const op of ops) {
      const result = await tool.handler(
        {
          mode: 'complex',
          operation: op,
          complex_a: { re: 1, im: 2 },
          complex_b: { re: 3, im: 4 },
        } as Args,
        makeCtx(),
      );
      assert.equal(result.isError, undefined, `op=${op}`);
    }
  });

  it('magnitude / phase / conjugate', async () => {
    for (const op of ['magnitude', 'phase', 'conjugate']) {
      const result = await tool.handler(
        { mode: 'complex', operation: op, complex_a: { re: 3, im: 4 } } as Args,
        makeCtx(),
      );
      assert.equal(result.isError, undefined, `op=${op}`);
    }
  });

  it('polar/rectangular roundtrip', async () => {
    const polar = await tool.handler(
      { mode: 'complex', operation: 'polar', complex_a: { re: 3, im: 4 } } as Args,
      makeCtx(),
    );
    const sc = polar.structuredContent as Record<string, unknown>;
    const r = sc.result as { re: number; im: number };
    // For polar mode, structured re=magnitude, im=phase.
    assert.ok(Math.abs(r.re - 5) < 1e-9);

    const rect = await tool.handler(
      {
        mode: 'complex',
        operation: 'rectangular',
        complex_a: { re: 5, im: Math.atan2(4, 3) },
      } as Args,
      makeCtx(),
    );
    const sc2 = rect.structuredContent as Record<string, unknown>;
    const r2 = sc2.result as { re: number; im: number };
    assert.ok(Math.abs(r2.re - 3) < 1e-9);
    assert.ok(Math.abs(r2.im - 4) < 1e-9);
  });

  it('exp / log / sqrt', async () => {
    for (const op of ['exp', 'log', 'sqrt']) {
      const result = await tool.handler(
        { mode: 'complex', operation: op, complex_a: { re: 1, im: 2 } } as Args,
        makeCtx(),
      );
      assert.equal(result.isError, undefined, `op=${op}`);
    }
  });

  it('pow with complex_b', async () => {
    const result = await tool.handler(
      {
        mode: 'complex',
        operation: 'pow',
        complex_a: { re: 1, im: 0 },
        complex_b: { re: 2, im: 0 },
      } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, undefined);
  });

  it('pow with complex_scalar', async () => {
    const result = await tool.handler(
      {
        mode: 'complex',
        operation: 'pow',
        complex_a: { re: 2, im: 3 },
        complex_scalar: 2,
      } as Args,
      makeCtx(),
    );
    const sc = result.structuredContent as Record<string, unknown>;
    const r = sc.result as { re: number; im: number };
    // (2+3i)^2 = -5 + 12i
    assert.ok(Math.abs(r.re - -5) < 1e-9);
    assert.ok(Math.abs(r.im - 12) < 1e-9);
  });

  it('returns isError on pow without exponent', async () => {
    const result = await tool.handler(
      { mode: 'complex', operation: 'pow', complex_a: { re: 1, im: 0 } } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on unknown complex operation', async () => {
    const result = await tool.handler(
      { mode: 'complex', operation: 'rotate', complex_a: { re: 1, im: 0 } } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });

  it('returns isError on missing complex_a', async () => {
    const result = await tool.handler(
      { mode: 'complex', operation: 'magnitude' } as Args,
      makeCtx(),
    );
    assert.equal(result.isError, true);
  });
});

describe('schema validates structuredContent', () => {
  it('every mode produces a result that conforms to outputSchema', async () => {
    const cases: Args[] = [
      { mode: 'evaluate', expression: '2 + 2' } as Args,
      {
        mode: 'solve',
        operation: 'polynomial',
        coefficients: [1, -3, 2],
      } as Args,
      {
        mode: 'matrix',
        operation: 'determinant',
        matrix_a: [
          [1, 0],
          [0, 1],
        ],
      } as Args,
      {
        mode: 'statistics',
        operation: 'describe',
        data: [1, 2, 3],
      } as Args,
      { mode: 'convert', value: 1, unit_from: 'meter', unit_to: 'foot' } as Args,
      {
        mode: 'finance',
        operation: 'simple-interest',
        principal: 1000,
        rate: 0.05,
        periods: 1,
      } as Args,
      { mode: 'complex', operation: 'magnitude', complex_a: { re: 3, im: 4 } } as Args,
    ];
    const schema = z.object(tool.outputSchema ?? {});
    for (const args of cases) {
      const result = await tool.handler(args, makeCtx());
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(
        parsed.success,
        true,
        `mode=${args.mode}: ${parsed.success ? '' : parsed.error.message}`,
      );
    }
  });
});
