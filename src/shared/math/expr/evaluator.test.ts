import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileSingleVariable, evaluate, RuntimeError } from './evaluator.ts';
import { parse } from './parser.ts';

function ev(
  src: string,
  vars: Record<string, number> = {},
  angle: 'radian' | 'degree' = 'radian',
): number {
  return evaluate(parse(src), { variables: vars, angleUnit: angle });
}

describe('evaluate — arithmetic', () => {
  it('+ - * / %', () => {
    assert.equal(ev('1 + 2'), 3);
    assert.equal(ev('5 - 8'), -3);
    assert.equal(ev('3 * 4'), 12);
    assert.equal(ev('20 / 4'), 5);
    assert.equal(ev('10 % 3'), 1);
  });

  it('rejects division by zero', () => {
    assert.throws(() => ev('1 / 0'), /Division by zero/);
    assert.throws(() => ev('1 % 0'), /Modulo by zero/);
  });

  it('honors operator precedence', () => {
    assert.equal(ev('1 + 2 * 3'), 7);
    assert.equal(ev('(1 + 2) * 3'), 9);
    assert.equal(ev('2 ^ 3 ^ 2'), 512); // right-associative
  });

  it('handles unary minus / plus', () => {
    assert.equal(ev('-5 + 3'), -2);
    assert.equal(ev('+5 + 3'), 8);
    assert.equal(ev('-(2 ^ 2)'), -4);
  });

  it('postfix factorial', () => {
    assert.equal(ev('5!'), 120);
    assert.throws(() => ev('(-1)!'), RuntimeError);
  });
});

describe('evaluate — power edge case', () => {
  it('rejects negative base with non-integer exponent', () => {
    assert.throws(() => ev('(-1) ^ 0.5'), /undefined in the reals/);
  });

  it('integer exponent on negative base is fine', () => {
    assert.equal(ev('(-2) ^ 3'), -8);
  });
});

describe('evaluate — variables and constants', () => {
  it('looks up variables', () => {
    assert.equal(ev('x + 1', { x: 4 }), 5);
  });

  it('looks up constants', () => {
    assert.ok(Math.abs(ev('pi') - Math.PI) < 1e-12);
  });

  it('user variable shadows constant when both names match', () => {
    // The tool layer would reject this, but the evaluator allows it as an
    // explicit override.
    assert.equal(ev('pi + 1', { pi: 0 }), 1);
  });

  it('rejects non-finite variables', () => {
    assert.throws(() => ev('x', { x: Number.NaN }), /not a finite/);
    assert.throws(() => ev('x', { x: Number.POSITIVE_INFINITY }), /not a finite/);
  });

  it('rejects unknown identifier', () => {
    assert.throws(() => ev('zzz'), /Unknown identifier/);
  });
});

describe('evaluate — function calls', () => {
  it('calls builtins', () => {
    assert.ok(Math.abs(ev('sin(0)') - 0) < 1e-12);
    assert.ok(Math.abs(ev('sqrt(16)') - 4) < 1e-12);
  });

  it('respects angle_unit for trig', () => {
    assert.ok(Math.abs(ev('sin(90)', {}, 'degree') - 1) < 1e-12);
  });

  it('rejects unknown function', () => {
    assert.throws(() => ev('foobar(1)'), /Unknown function/);
  });

  it('arity-checks fixed-arity functions', () => {
    assert.throws(() => ev('sin(1, 2)'), /expects 1 argument/);
    assert.throws(() => ev('sin()'), /expects 1 argument/);
  });

  it('arity-checks variadic min/max', () => {
    assert.throws(() => ev('min()'), /at least 1 argument/);
    // pow has fixed arity 2.
    assert.throws(() => ev('pow(1)'), /expects 2 arguments/);
  });

  it('rejects non-number return (defensive — should not happen in practice)', () => {
    assert.throws(
      () =>
        evaluate(
          { kind: 'call', name: 'fake', args: [] },
          {
            variables: {},
            angleUnit: 'radian',
            builtins: {
              fake: { arity: 0, impl: () => 'oops' as unknown as number },
            },
          },
        ),
      /did not return a number/,
    );
  });

  it('propagates domain error from builtin', () => {
    assert.throws(() => ev('sqrt(-1)'), /not real/);
  });
});

describe('evaluate — full-stack expressions', () => {
  it('matches the user example', () => {
    const value = ev('2 * sin(pi / 4) + sqrt(16)');
    const expected = 2 * Math.sin(Math.PI / 4) + 4;
    assert.ok(Math.abs(value - expected) < 1e-12);
  });

  it('handles mixed variable + constant + function', () => {
    const value = ev('2 * x + cos(y)', { x: 3, y: 0 });
    assert.equal(value, 7);
  });
});

describe('compileSingleVariable', () => {
  it('returns a closure that varies with x', () => {
    const f = compileSingleVariable(parse('x ^ 2 + 1'), 'x', { angleUnit: 'radian' });
    assert.equal(f(0), 1);
    assert.equal(f(2), 5);
    assert.equal(f(-3), 10);
  });

  it('preserves base variables', () => {
    const f = compileSingleVariable(parse('a + x'), 'x', {
      angleUnit: 'radian',
      variables: { a: 100 },
    });
    assert.equal(f(0), 100);
    assert.equal(f(5), 105);
  });

  it('honors angleUnit', () => {
    const f = compileSingleVariable(parse('sin(x)'), 'x', { angleUnit: 'degree' });
    assert.ok(Math.abs(f(90) - 1) < 1e-12);
  });

  it('default empty variables', () => {
    const f = compileSingleVariable(parse('x + 1'), 'x', { angleUnit: 'radian' });
    assert.equal(f(7), 8);
  });
});
