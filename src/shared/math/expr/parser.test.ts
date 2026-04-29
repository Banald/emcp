import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AstNode,
  collectIdentifiers,
  MAX_EXPRESSION_LENGTH,
  MAX_PARSE_DEPTH,
  ParseError,
  parse,
  tokenize,
} from './parser.ts';

describe('tokenize', () => {
  it('handles whitespace and basic operators', () => {
    const tokens = tokenize('  1 + 2 * 3 ');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ['number', 'plus', 'number', 'star', 'number'],
    );
  });

  it('parses scientific notation', () => {
    const tokens = tokenize('1.5e10 + 2E-3 + .5');
    assert.deepEqual(
      tokens.map((t) => t.value),
      ['1.5e10', '+', '2E-3', '+', '.5'],
    );
  });

  it('aliases ** to caret', () => {
    const tokens = tokenize('2 ** 3');
    assert.equal(tokens[1]?.kind, 'caret');
    assert.equal(tokens[1]?.value, '**');
  });

  it('rejects malformed exponents', () => {
    assert.throws(() => tokenize('1e'), ParseError);
    assert.throws(() => tokenize('1e+'), ParseError);
  });

  it('rejects unexpected characters', () => {
    assert.throws(() => tokenize('@'), ParseError);
    assert.throws(() => tokenize('1 # 2'), ParseError);
  });

  it('rejects sources longer than the cap', () => {
    const long = `${'1+'.repeat(MAX_EXPRESSION_LENGTH)}1`;
    assert.throws(() => tokenize(long), /too long/);
  });

  it('rejects token streams that exceed the cap', () => {
    // Each `1+` is 2 tokens; ~600 chars of `1+1+...` blows past 1000 tokens.
    const src = `1${'+1'.repeat(700)}`;
    assert.throws(() => tokenize(src), /too many tokens/);
  });

  it('handles factorial as a single token', () => {
    const tokens = tokenize('5!');
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ['number', 'bang'],
    );
  });

  it('handles tabs / newlines as whitespace', () => {
    const tokens = tokenize('1\t+\n2\r+ 3');
    assert.equal(tokens.length, 5);
  });

  it('records start/end positions per token', () => {
    const tokens = tokenize('  abc');
    assert.equal(tokens[0]?.start, 2);
    assert.equal(tokens[0]?.end, 5);
  });
});

describe('parse — happy paths', () => {
  it('parses a number literal', () => {
    assert.deepEqual(parse('42'), { kind: 'number', value: 42 });
  });

  it('respects + - precedence', () => {
    const ast = parse('1 + 2 - 3');
    // Left-assoc: (1+2)-3
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.op, '-');
    assert.equal(ast.right.kind, 'number');
    if (ast.left.kind !== 'binary') {
      throw new Error('expected nested binary');
    }
    assert.equal(ast.left.op, '+');
  });

  it('respects * over +', () => {
    const ast = parse('1 + 2 * 3');
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.op, '+');
    assert.equal(ast.right.kind, 'binary');
  });

  it('parses unary minus', () => {
    const ast = parse('-5');
    assert.equal(ast.kind, 'unary');
    if (ast.kind !== 'unary') return;
    assert.equal(ast.op, '-');
    assert.equal(ast.operand.kind, 'number');
  });

  it('parses unary plus (no-op preserved)', () => {
    const ast = parse('+5');
    assert.equal(ast.kind, 'unary');
    if (ast.kind !== 'unary') return;
    assert.equal(ast.op, '+');
  });

  it('parses postfix factorial', () => {
    const ast = parse('5!');
    assert.equal(ast.kind, 'postfix');
  });

  it('parses right-associative power', () => {
    const ast = parse('2 ^ 3 ^ 2');
    // Right-assoc: 2^(3^2)
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.op, '^');
    assert.equal(ast.right.kind, 'binary');
  });

  it('treats ** as caret/power', () => {
    const ast = parse('2 ** 3');
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.op, '^');
  });

  it('parses parenthesized sub-expressions', () => {
    const ast = parse('(1 + 2) * 3');
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.op, '*');
    assert.equal(ast.left.kind, 'binary');
  });

  it('parses a function call with multiple args', () => {
    const ast = parse('atan2(1, 2)');
    assert.equal(ast.kind, 'call');
    if (ast.kind !== 'call') return;
    assert.equal(ast.name, 'atan2');
    assert.equal(ast.args.length, 2);
  });

  it('parses a function call with no args', () => {
    const ast = parse('rand()');
    assert.equal(ast.kind, 'call');
    if (ast.kind !== 'call') return;
    assert.equal(ast.args.length, 0);
  });

  it('parses identifiers as variables', () => {
    const ast = parse('x + y');
    assert.equal(ast.kind, 'binary');
    if (ast.kind !== 'binary') return;
    assert.equal(ast.left.kind, 'identifier');
    assert.equal(ast.right.kind, 'identifier');
  });
});

describe('parse — error paths', () => {
  it('rejects empty input', () => {
    assert.throws(() => parse(''), /empty/);
  });

  it('rejects unbalanced parens', () => {
    assert.throws(() => parse('(1 + 2'), ParseError);
    assert.throws(() => parse('1 + 2)'), ParseError);
  });

  it('rejects trailing operators', () => {
    assert.throws(() => parse('1 +'), ParseError);
  });

  it('rejects leading binary operators', () => {
    assert.throws(() => parse('* 1'), ParseError);
  });

  it('rejects depth bombs', () => {
    const expr = `${'('.repeat(MAX_PARSE_DEPTH + 5)}1${')'.repeat(MAX_PARSE_DEPTH + 5)}`;
    assert.throws(() => parse(expr), /nests too deeply/);
  });

  it('rejects malformed numbers (e.g. 1.2.3)', () => {
    // 1.2.3 tokenizes to "1.2", ".", "3"; the dot is unexpected.
    assert.throws(() => parse('1.2.3'), ParseError);
  });
});

describe('collectIdentifiers', () => {
  function walk(src: string): readonly string[] {
    return [...collectIdentifiers(parse(src) as AstNode)];
  }

  it('returns all referenced names', () => {
    const ids = walk('x + sin(y) + atan2(a, b)');
    // Function names (sin, atan2) ARE identifiers in argument positions, but
    // collectIdentifiers does include them via `call` traversal? No — by design,
    // call.name is NOT recorded as a free identifier; only the args are. Verify.
    assert.deepEqual([...ids].sort(), ['a', 'b', 'x', 'y']);
  });

  it('ignores function-call names (only args contribute)', () => {
    const ids = walk('cos(x)');
    assert.deepEqual([...ids], ['x']);
  });

  it('handles nested unary/postfix', () => {
    const ids = walk('-(x!) + +y');
    assert.deepEqual([...ids].sort(), ['x', 'y']);
  });

  it('returns empty for pure-numeric expressions', () => {
    assert.deepEqual(walk('1 + 2 * 3 - 4'), []);
  });

  it('reuses an existing set if provided', () => {
    const into = new Set<string>(['preset']);
    collectIdentifiers(parse('a + b'), into);
    assert.deepEqual([...into].sort(), ['a', 'b', 'preset']);
  });
});
