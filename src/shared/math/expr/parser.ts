// Recursive-descent parser for arithmetic expressions.
// Produces an AST with explicit operator nodes, function calls, identifier
// references, and numeric literals. Bounded against pathological input:
// - max source length 2000 chars
// - max token count 1000
// - max parse depth 100 (catches deeply-nested parens / unary chains)
//
// Grammar (precedence low → high, right-associative where noted):
//   expression  := additive
//   additive    := multiplicative (( '+' | '-' ) multiplicative)*
//   multiplicative := unary (( '*' | '/' | '%' ) unary)*
//   unary       := ('-' | '+') unary | postfix
//   postfix     := power '!'?           // factorial postfix
//   power       := atom ('^' unary)?     // right-associative
//   atom        := NUMBER
//                | IDENT ('(' arglist? ')')?
//                | '(' expression ')'
//   arglist     := expression (',' expression)*

export const MAX_EXPRESSION_LENGTH = 2000;
export const MAX_TOKEN_COUNT = 1000;
export const MAX_PARSE_DEPTH = 100;

export type TokenKind =
  | 'number'
  | 'ident'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'percent'
  | 'caret'
  | 'bang'
  | 'lparen'
  | 'rparen'
  | 'comma';

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export type AstNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'identifier'; readonly name: string }
  | {
      readonly kind: 'binary';
      readonly op: '+' | '-' | '*' | '/' | '%' | '^';
      readonly left: AstNode;
      readonly right: AstNode;
    }
  | { readonly kind: 'unary'; readonly op: '+' | '-'; readonly operand: AstNode }
  | { readonly kind: 'postfix'; readonly op: '!'; readonly operand: AstNode }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly AstNode[] };

export class ParseError extends Error {
  readonly position: number;
  readonly source: string;

  constructor(message: string, source: string, position: number) {
    super(message);
    this.name = 'ParseError';
    this.position = position;
    this.source = source;
  }
}

export function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ParseError(
      `Expression too long (${source.length} chars; max ${MAX_EXPRESSION_LENGTH}).`,
      source,
      MAX_EXPRESSION_LENGTH,
    );
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source.charCodeAt(i);

    // Whitespace.
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      i += 1;
      continue;
    }

    const start = i;

    // Number: integer, decimal, scientific. Leading dot allowed (.5).
    if (
      isDigit(ch) ||
      (ch === 0x2e && i + 1 < source.length && isDigit(source.charCodeAt(i + 1)))
    ) {
      i = scanNumber(source, i);
      tokens.push({ kind: 'number', value: source.slice(start, i), start, end: i });
      pushBound(tokens, source, start);
      continue;
    }

    // Identifier: letter or underscore, then letters/digits/underscores.
    if (isIdentStart(ch)) {
      i += 1;
      while (i < source.length && isIdentCont(source.charCodeAt(i))) {
        i += 1;
      }
      tokens.push({ kind: 'ident', value: source.slice(start, i), start, end: i });
      pushBound(tokens, source, start);
      continue;
    }

    // `**` aliased to `^` for ergonomics — many LLMs/users write Python-style.
    // Must run BEFORE the single-char `*` branch.
    if (ch === 0x2a && source.charCodeAt(i + 1) === 0x2a) {
      tokens.push({ kind: 'caret', value: '**', start, end: i + 2 });
      i += 2;
      pushBound(tokens, source, start);
      continue;
    }

    // Single-char operators / punctuation.
    const single = singleCharToken(ch);
    if (single !== null) {
      tokens.push({ kind: single, value: source[start] ?? '', start, end: i + 1 });
      i += 1;
      pushBound(tokens, source, start);
      continue;
    }

    throw new ParseError(
      `Unexpected character "${source[start]}" at position ${start}.`,
      source,
      start,
    );
  }

  return tokens;
}

function pushBound(tokens: readonly Token[], source: string, position: number): void {
  if (tokens.length > MAX_TOKEN_COUNT) {
    throw new ParseError(
      `Expression has too many tokens (max ${MAX_TOKEN_COUNT}).`,
      source,
      position,
    );
  }
}

function isDigit(ch: number): boolean {
  return ch >= 0x30 && ch <= 0x39;
}

function isIdentStart(ch: number): boolean {
  return (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || ch === 0x5f;
}

function isIdentCont(ch: number): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function singleCharToken(ch: number): TokenKind | null {
  switch (ch) {
    case 0x2b:
      return 'plus';
    case 0x2d:
      return 'minus';
    case 0x2a:
      return 'star';
    case 0x2f:
      return 'slash';
    case 0x25:
      return 'percent';
    case 0x5e:
      return 'caret';
    case 0x21:
      return 'bang';
    case 0x28:
      return 'lparen';
    case 0x29:
      return 'rparen';
    case 0x2c:
      return 'comma';
    default:
      return null;
  }
}

function scanNumber(source: string, start: number): number {
  let i = start;
  // Integer / leading-decimal part.
  while (i < source.length && isDigit(source.charCodeAt(i))) i += 1;

  // Fractional part.
  if (i < source.length && source.charCodeAt(i) === 0x2e) {
    i += 1;
    while (i < source.length && isDigit(source.charCodeAt(i))) i += 1;
  }

  // Exponent: e | E [+|-] DIGIT+
  if (i < source.length) {
    const e = source.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      const expStart = i;
      i += 1;
      if (i < source.length) {
        const sign = source.charCodeAt(i);
        if (sign === 0x2b || sign === 0x2d) i += 1;
      }
      const digitsStart = i;
      while (i < source.length && isDigit(source.charCodeAt(i))) i += 1;
      if (i === digitsStart) {
        throw new ParseError(
          `Malformed number near position ${expStart}: exponent has no digits.`,
          source,
          expStart,
        );
      }
    }
  }

  return i;
}

class Parser {
  private readonly tokens: readonly Token[];
  private readonly source: string;
  private pos: number;
  private depth: number;

  constructor(tokens: readonly Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
    this.pos = 0;
    this.depth = 0;
  }

  parseProgram(): AstNode {
    const node = this.parseExpression();
    if (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos];
      throw new ParseError(
        `Unexpected token "${tok?.value ?? ''}" at position ${tok?.start ?? this.source.length}.`,
        this.source,
        tok?.start ?? this.source.length,
      );
    }
    return node;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) {
      throw new ParseError(
        `Expression nests too deeply (max ${MAX_PARSE_DEPTH}).`,
        this.source,
        this.peek()?.start ?? this.source.length,
      );
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(kind: TokenKind): Token | null {
    const t = this.tokens[this.pos];
    if (t && t.kind === kind) {
      this.pos += 1;
      return t;
    }
    return null;
  }

  private expect(kind: TokenKind, label: string): Token {
    const t = this.tokens[this.pos];
    if (!t || t.kind !== kind) {
      const at = t ? t.start : this.source.length;
      throw new ParseError(`Expected ${label} at position ${at}.`, this.source, at);
    }
    this.pos += 1;
    return t;
  }

  private parseExpression(): AstNode {
    this.enter();
    try {
      return this.parseAdditive();
    } finally {
      this.leave();
    }
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative();
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.kind !== 'plus' && t.kind !== 'minus') break;
      this.pos += 1;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op: t.kind === 'plus' ? '+' : '-', left, right };
    }
    return left;
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.kind !== 'star' && t.kind !== 'slash' && t.kind !== 'percent') break;
      this.pos += 1;
      const right = this.parseUnary();
      const op = t.kind === 'star' ? '*' : t.kind === 'slash' ? '/' : '%';
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    const t = this.peek();
    if (t && (t.kind === 'plus' || t.kind === 'minus')) {
      this.pos += 1;
      this.enter();
      try {
        const operand = this.parseUnary();
        return { kind: 'unary', op: t.kind === 'plus' ? '+' : '-', operand };
      } finally {
        this.leave();
      }
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePower();
    while (this.eat('bang')) {
      node = { kind: 'postfix', op: '!', operand: node };
    }
    return node;
  }

  private parsePower(): AstNode {
    const base = this.parseAtom();
    if (this.eat('caret')) {
      this.enter();
      try {
        const exponent = this.parseUnary();
        return { kind: 'binary', op: '^', left: base, right: exponent };
      } finally {
        this.leave();
      }
    }
    return base;
  }

  private parseAtom(): AstNode {
    const t = this.peek();
    if (!t) {
      throw new ParseError(
        `Unexpected end of expression at position ${this.source.length}.`,
        this.source,
        this.source.length,
      );
    }

    if (t.kind === 'number') {
      this.pos += 1;
      const value = Number(t.value);
      if (!Number.isFinite(value)) {
        throw new ParseError(`Number "${t.value}" is not finite.`, this.source, t.start);
      }
      return { kind: 'number', value };
    }

    if (t.kind === 'lparen') {
      this.pos += 1;
      this.enter();
      try {
        const inner = this.parseExpression();
        this.expect('rparen', '")"');
        return inner;
      } finally {
        this.leave();
      }
    }

    if (t.kind === 'ident') {
      this.pos += 1;
      if (this.eat('lparen')) {
        const args: AstNode[] = [];
        if (!this.eat('rparen')) {
          this.enter();
          try {
            args.push(this.parseExpression());
            while (this.eat('comma')) {
              args.push(this.parseExpression());
            }
            this.expect('rparen', '")"');
          } finally {
            this.leave();
          }
        }
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'identifier', name: t.value };
    }

    throw new ParseError(
      `Unexpected token "${t.value}" at position ${t.start}.`,
      this.source,
      t.start,
    );
  }
}

export function parse(source: string): AstNode {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new ParseError('Expression is empty.', source, 0);
  }
  const parser = new Parser(tokens, source);
  return parser.parseProgram();
}

// Walks an AST and returns the set of identifiers it references.
// Used by the calculator to (a) detect missing variables before evaluation
// and (b) extract polynomial coefficients in the solver.
export function collectIdentifiers(node: AstNode, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'number':
      return into;
    case 'identifier':
      into.add(node.name);
      return into;
    case 'binary':
      collectIdentifiers(node.left, into);
      collectIdentifiers(node.right, into);
      return into;
    case 'unary':
    case 'postfix':
      collectIdentifiers(node.operand, into);
      return into;
    case 'call':
      for (const a of node.args) collectIdentifiers(a, into);
      return into;
  }
}
