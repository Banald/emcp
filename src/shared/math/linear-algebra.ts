// Hand-rolled linear-algebra primitives. Pure: every function returns a
// fresh Matrix/vector. Rectangular and square matrices supported. Max
// dimension is 50 — bounded by the calculator tool's input-schema bounds.

export type Matrix = readonly (readonly number[])[];
export type Vector = readonly number[];

export const MAX_DIMENSION = 50;

export class MatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatrixError';
  }
}

export function rows(m: Matrix): number {
  return m.length;
}

export function cols(m: Matrix): number {
  return m.length === 0 ? 0 : (m[0]?.length ?? 0);
}

export function ensureWellFormed(m: Matrix, label = 'matrix'): void {
  if (m.length === 0) throw new MatrixError(`${label} must have at least one row.`);
  if (m.length > MAX_DIMENSION) {
    throw new MatrixError(`${label} has too many rows (${m.length}; max ${MAX_DIMENSION}).`);
  }
  const c = m[0]?.length ?? 0;
  if (c === 0) throw new MatrixError(`${label} must have at least one column.`);
  if (c > MAX_DIMENSION) {
    throw new MatrixError(`${label} has too many columns (${c}; max ${MAX_DIMENSION}).`);
  }
  for (let i = 0; i < m.length; i += 1) {
    const row = m[i] as readonly number[];
    if (row.length !== c) {
      throw new MatrixError(
        `${label} is not rectangular (row ${i} has ${row.length} columns, expected ${c}).`,
      );
    }
    for (let j = 0; j < row.length; j += 1) {
      const v = row[j] as number;
      if (!Number.isFinite(v)) {
        throw new MatrixError(`${label}[${i}][${j}] is not finite (${v}).`);
      }
    }
  }
}

function ensureSquare(m: Matrix, op: string): void {
  if (rows(m) !== cols(m)) {
    throw new MatrixError(`${op} requires a square matrix; got ${rows(m)}×${cols(m)}.`);
  }
}

export function add(a: Matrix, b: Matrix): Matrix {
  ensureWellFormed(a, 'A');
  ensureWellFormed(b, 'B');
  if (rows(a) !== rows(b) || cols(a) !== cols(b)) {
    throw new MatrixError(
      `add requires matching shapes; got ${rows(a)}×${cols(a)} and ${rows(b)}×${cols(b)}.`,
    );
  }
  return a.map((row, i) => row.map((v, j) => v + ((b[i] as readonly number[])[j] as number)));
}

export function subtract(a: Matrix, b: Matrix): Matrix {
  ensureWellFormed(a, 'A');
  ensureWellFormed(b, 'B');
  if (rows(a) !== rows(b) || cols(a) !== cols(b)) {
    throw new MatrixError(
      `subtract requires matching shapes; got ${rows(a)}×${cols(a)} and ${rows(b)}×${cols(b)}.`,
    );
  }
  return a.map((row, i) => row.map((v, j) => v - ((b[i] as readonly number[])[j] as number)));
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  ensureWellFormed(a, 'A');
  ensureWellFormed(b, 'B');
  if (cols(a) !== rows(b)) {
    throw new MatrixError(`multiply requires A.cols === B.rows; got ${cols(a)} vs ${rows(b)}.`);
  }
  const out: number[][] = [];
  const inner = cols(a);
  for (let i = 0; i < rows(a); i += 1) {
    const row: number[] = [];
    for (let j = 0; j < cols(b); j += 1) {
      let acc = 0;
      for (let k = 0; k < inner; k += 1) {
        acc +=
          ((a[i] as readonly number[])[k] as number) * ((b[k] as readonly number[])[j] as number);
      }
      row.push(acc);
    }
    out.push(row);
  }
  return out;
}

export function transpose(m: Matrix): Matrix {
  ensureWellFormed(m, 'matrix');
  const out: number[][] = [];
  for (let j = 0; j < cols(m); j += 1) {
    const row: number[] = [];
    for (let i = 0; i < rows(m); i += 1) {
      row.push((m[i] as readonly number[])[j] as number);
    }
    out.push(row);
  }
  return out;
}

interface LU {
  readonly lu: number[][];
  readonly perm: readonly number[];
  readonly sign: number;
}

// LU decomposition with partial pivoting. Returns the in-place LU matrix
// (L below diagonal, U on/above), the row permutation used, and the sign
// of the permutation (used by determinant).
function decomposeLU(matrix: Matrix): LU {
  ensureSquare(matrix, 'LU');
  const n = rows(matrix);
  const lu: number[][] = matrix.map((row) => [...row]);
  const perm: number[] = Array.from({ length: n }, (_, i) => i);
  let sign = 1;

  for (let k = 0; k < n; k += 1) {
    // Partial pivot
    let pivot = k;
    let pivotMag = Math.abs((lu[k] as number[])[k] as number);
    for (let i = k + 1; i < n; i += 1) {
      const mag = Math.abs((lu[i] as number[])[k] as number);
      if (mag > pivotMag) {
        pivot = i;
        pivotMag = mag;
      }
    }
    if (pivotMag === 0) {
      // Singular — bubble up to caller; determinant is 0, inverse undefined.
      return { lu, perm, sign: 0 };
    }
    if (pivot !== k) {
      const tmp = lu[k] as number[];
      lu[k] = lu[pivot] as number[];
      lu[pivot] = tmp;
      const ptmp = perm[k] as number;
      perm[k] = perm[pivot] as number;
      perm[pivot] = ptmp;
      sign = -sign;
    }

    const pivotVal = (lu[k] as number[])[k] as number;
    for (let i = k + 1; i < n; i += 1) {
      const luI = lu[i] as number[];
      const factor = (luI[k] as number) / pivotVal;
      luI[k] = factor;
      for (let j = k + 1; j < n; j += 1) {
        luI[j] = (luI[j] as number) - factor * ((lu[k] as number[])[j] as number);
      }
    }
  }

  return { lu, perm, sign };
}

export function determinant(matrix: Matrix): number {
  ensureWellFormed(matrix, 'matrix');
  ensureSquare(matrix, 'determinant');
  const { lu, sign } = decomposeLU(matrix);
  if (sign === 0) return 0;
  let det = sign;
  for (let i = 0; i < lu.length; i += 1) {
    det *= (lu[i] as number[])[i] as number;
  }
  return det;
}

function solveLU(lu: number[][], perm: readonly number[], rhs: Vector): number[] {
  const n = lu.length;
  // Permute rhs.
  const b: number[] = perm.map((p) => rhs[p] as number);
  // Forward substitution: solve L*y = b (L has unit diagonal).
  for (let i = 0; i < n; i += 1) {
    let s = b[i] as number;
    for (let j = 0; j < i; j += 1) s -= ((lu[i] as number[])[j] as number) * (b[j] as number);
    b[i] = s;
  }
  // Backward substitution: solve U*x = y.
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = b[i] as number;
    for (let j = i + 1; j < n; j += 1) s -= ((lu[i] as number[])[j] as number) * (b[j] as number);
    const diag = (lu[i] as number[])[i] as number;
    b[i] = s / diag;
  }
  return b;
}

export function inverse(matrix: Matrix): Matrix {
  ensureWellFormed(matrix, 'matrix');
  ensureSquare(matrix, 'inverse');
  const n = rows(matrix);
  const { lu, perm, sign } = decomposeLU(matrix);
  if (sign === 0) {
    throw new MatrixError('Matrix is singular; inverse does not exist.');
  }
  const out: number[][] = [];
  for (let i = 0; i < n; i += 1) out.push(new Array<number>(n).fill(0));
  for (let col = 0; col < n; col += 1) {
    const e = new Array<number>(n).fill(0);
    e[col] = 1;
    const x = solveLU(lu, perm, e);
    for (let row = 0; row < n; row += 1) (out[row] as number[])[col] = x[row] as number;
  }
  return out;
}

export function solve(matrix: Matrix, rhs: Vector): Vector {
  ensureWellFormed(matrix, 'A');
  ensureSquare(matrix, 'solve');
  if (rhs.length !== rows(matrix)) {
    throw new MatrixError(
      `solve requires rhs length === A.rows; got ${rhs.length} vs ${rows(matrix)}.`,
    );
  }
  for (const v of rhs) {
    if (!Number.isFinite(v)) throw new MatrixError(`rhs contains a non-finite value (${v}).`);
  }
  const { lu, perm, sign } = decomposeLU(matrix);
  if (sign === 0) {
    throw new MatrixError('Matrix is singular; system has no unique solution.');
  }
  return solveLU(lu, perm, rhs);
}

// Round each entry to a fixed number of decimals — used purely for display.
export function roundEach(m: Matrix, precision: number): Matrix {
  const factor = 10 ** precision;
  return m.map((row) => row.map((v) => (Number.isFinite(v) ? Math.round(v * factor) / factor : v)));
}
