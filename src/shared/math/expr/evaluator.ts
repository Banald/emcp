// AST evaluator. Pure-function: takes an AST + an environment and returns a number,
// or throws RuntimeError for runtime / domain failures (the calculator tool catches
// these and turns them into isError responses).

import {
  type AngleUnit,
  BUILTINS,
  type BuiltinDefinition,
  CONSTANTS,
  factorial,
  isDomainError,
} from './builtins.ts';
import type { AstNode } from './parser.ts';

export interface EvalEnv {
  readonly variables: Readonly<Record<string, number>>;
  readonly angleUnit: AngleUnit;
  readonly builtins?: Readonly<Record<string, BuiltinDefinition>>;
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

const DEFAULT_BUILTINS = BUILTINS;

export function evaluate(node: AstNode, env: EvalEnv): number {
  const builtins = env.builtins ?? DEFAULT_BUILTINS;

  switch (node.kind) {
    case 'number':
      return node.value;

    case 'identifier': {
      // User variables take priority. This intentionally allows shadowing of
      // constants when the caller passes one — the tool layer rejects names
      // that collide with builtins/constants up front so this branch is rare.
      if (Object.hasOwn(env.variables, node.name)) {
        const v = env.variables[node.name];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new RuntimeError(`Variable "${node.name}" is not a finite number.`);
        }
        return v;
      }
      if (Object.hasOwn(CONSTANTS, node.name)) {
        return CONSTANTS[node.name] as number;
      }
      throw new RuntimeError(`Unknown identifier "${node.name}".`);
    }

    case 'binary': {
      const l = evaluate(node.left, env);
      const r = evaluate(node.right, env);
      return applyBinary(node.op, l, r);
    }

    case 'unary': {
      const v = evaluate(node.operand, env);
      return node.op === '-' ? -v : v;
    }

    case 'postfix': {
      const v = evaluate(node.operand, env);
      const r = factorial(v);
      if (isDomainError(r)) throw new RuntimeError(r.message);
      return r;
    }

    case 'call': {
      const def = builtins[node.name];
      if (!def) {
        throw new RuntimeError(`Unknown function "${node.name}".`);
      }
      const args = node.args.map((a) => evaluate(a, env));
      checkArity(node.name, def.arity, args.length);
      const result = def.impl(args, { angleUnit: env.angleUnit });
      if (isDomainError(result)) {
        throw new RuntimeError(result.message);
      }
      if (typeof result !== 'number') {
        throw new RuntimeError(`Builtin "${node.name}" did not return a number.`);
      }
      return result;
    }
  }
}

function applyBinary(op: '+' | '-' | '*' | '/' | '%' | '^', l: number, r: number): number {
  switch (op) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      if (r === 0) throw new RuntimeError(`Division by zero (${l} / 0).`);
      return l / r;
    case '%':
      if (r === 0) throw new RuntimeError(`Modulo by zero (${l} % 0).`);
      return l % r;
    case '^': {
      const result = l ** r;
      if (Number.isNaN(result) && Number.isFinite(l) && Number.isFinite(r)) {
        throw new RuntimeError(
          `${l}^${r} is undefined in the reals (e.g. negative base with non-integer exponent).`,
        );
      }
      return result;
    }
  }
}

function checkArity(
  name: string,
  arity: number | { readonly min: number; readonly max: number },
  got: number,
): void {
  if (typeof arity === 'number') {
    if (got !== arity) {
      throw new RuntimeError(
        `Function "${name}" expects ${arity} argument${arity === 1 ? '' : 's'}, got ${got}.`,
      );
    }
    return;
  }
  if (got < arity.min) {
    throw new RuntimeError(
      `Function "${name}" expects at least ${arity.min} argument${arity.min === 1 ? '' : 's'}, got ${got}.`,
    );
  }
  if (got > arity.max) {
    throw new RuntimeError(
      `Function "${name}" expects at most ${arity.max} arguments, got ${got}.`,
    );
  }
}

// Compile an AST into a closure (number → number) bound to a free variable.
// Used by calculus and solver to make repeated evaluations cheap and avoid
// re-walking the AST for every sample point.
export function compileSingleVariable(
  ast: AstNode,
  variable: string,
  baseEnv: Omit<EvalEnv, 'variables'> & { readonly variables?: Readonly<Record<string, number>> },
): (x: number) => number {
  const baseVars = baseEnv.variables ?? {};
  return (x: number) => {
    const env: EvalEnv = {
      variables: { ...baseVars, [variable]: x },
      angleUnit: baseEnv.angleUnit,
      builtins: baseEnv.builtins,
    };
    return evaluate(ast, env);
  };
}
