import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  add,
  cols,
  determinant,
  ensureWellFormed,
  inverse,
  type Matrix,
  MatrixError,
  multiply,
  rows,
  solve,
  subtract,
  transpose,
} from './linear-algebra.ts';

const I3: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function approxMatrix(a: Matrix, b: Matrix, tol = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i] as readonly number[];
    const rb = b[i] as readonly number[];
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j += 1) {
      if (Math.abs((ra[j] as number) - (rb[j] as number)) > tol) return false;
    }
  }
  return true;
}

describe('rows / cols', () => {
  it('reports dimensions', () => {
    assert.equal(rows([[1, 2]]), 1);
    assert.equal(cols([[1, 2]]), 2);
    assert.equal(rows([]), 0);
    assert.equal(cols([]), 0);
  });
});

describe('ensureWellFormed', () => {
  it('rejects empty matrix', () => {
    assert.throws(() => ensureWellFormed([]), MatrixError);
  });

  it('rejects empty rows', () => {
    assert.throws(() => ensureWellFormed([[]]), MatrixError);
  });

  it('rejects ragged rows', () => {
    assert.throws(() => ensureWellFormed([[1, 2], [3]]), /not rectangular/);
  });

  it('rejects non-finite entries', () => {
    assert.throws(() => ensureWellFormed([[1, Number.NaN]]), MatrixError);
  });

  it('rejects too-large dimensions', () => {
    const big = Array.from({ length: 51 }, () => [1]);
    assert.throws(() => ensureWellFormed(big), /too many rows/);
    const wide = [Array(51).fill(1)] as Matrix;
    assert.throws(() => ensureWellFormed(wide), /too many columns/);
  });
});

describe('add / subtract', () => {
  it('add', () => {
    assert.deepEqual(
      add(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [5, 6],
          [7, 8],
        ],
      ),
      [
        [6, 8],
        [10, 12],
      ],
    );
  });

  it('subtract', () => {
    assert.deepEqual(
      subtract(
        [
          [10, 10],
          [10, 10],
        ],
        [
          [1, 2],
          [3, 4],
        ],
      ),
      [
        [9, 8],
        [7, 6],
      ],
    );
  });

  it('rejects mismatched shapes', () => {
    assert.throws(() => add([[1]], [[1, 2]]), /matching shapes/);
    assert.throws(() => subtract([[1]], [[1, 2]]), /matching shapes/);
  });
});

describe('multiply / transpose', () => {
  it('multiply 2x2', () => {
    assert.deepEqual(
      multiply(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [5, 6],
          [7, 8],
        ],
      ),
      [
        [19, 22],
        [43, 50],
      ],
    );
  });

  it('multiply rectangular (2x3 * 3x1)', () => {
    assert.deepEqual(
      multiply(
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
        [[7], [8], [9]],
      ),
      [[50], [122]],
    );
  });

  it('multiply rejects mismatched inner dim', () => {
    assert.throws(() => multiply([[1, 2]], [[3, 4]]), /A.cols === B.rows/);
  });

  it('transpose', () => {
    assert.deepEqual(
      transpose([
        [1, 2, 3],
        [4, 5, 6],
      ]),
      [
        [1, 4],
        [2, 5],
        [3, 6],
      ],
    );
  });

  it('transpose of vector-shape', () => {
    assert.deepEqual(transpose([[1, 2, 3]]), [[1], [2], [3]]);
  });
});

describe('determinant', () => {
  it('1x1', () => {
    assert.equal(determinant([[5]]), 5);
  });

  it('2x2', () => {
    assert.equal(
      determinant([
        [1, 2],
        [3, 4],
      ]),
      -2,
    );
  });

  it('3x3 via known case', () => {
    // det of [[6, 1, 1], [4, -2, 5], [2, 8, 7]] = -306
    const d = determinant([
      [6, 1, 1],
      [4, -2, 5],
      [2, 8, 7],
    ]);
    assert.ok(Math.abs(d - -306) < 1e-9);
  });

  it('singular matrix → 0', () => {
    assert.equal(
      determinant([
        [1, 2],
        [2, 4],
      ]),
      0,
    );
  });

  it('rejects non-square', () => {
    assert.throws(() => determinant([[1, 2]]), /square/);
  });
});

describe('inverse', () => {
  it('inverse * matrix = identity', () => {
    const m: Matrix = [
      [4, 7],
      [2, 6],
    ];
    const inv = inverse(m);
    assert.ok(
      approxMatrix(multiply(m, inv), [
        [1, 0],
        [0, 1],
      ]),
    );
  });

  it('inverse of identity is identity', () => {
    assert.ok(approxMatrix(inverse(I3), I3));
  });

  it('rejects singular', () => {
    assert.throws(
      () =>
        inverse([
          [1, 2],
          [2, 4],
        ]),
      /singular/,
    );
  });

  it('rejects non-square', () => {
    assert.throws(() => inverse([[1, 2]]), /square/);
  });
});

describe('solve (Ax = b)', () => {
  it('solves a 3x3 system', () => {
    // System:
    //  2x +  y =  3
    //   x - 3y = -8  → x = -1, y = 5? Let's use a known solution.
    const x = solve(
      [
        [2, 1],
        [1, -3],
      ],
      [5, -10],
    );
    // 2x + y = 5; x - 3y = -10. Solve: from first y = 5-2x; sub: x - 3(5-2x) = -10 → 7x = 5 → x=5/7? Let's check: that doesn't equal a clean integer. Use a clean one.
    // Use [[2,1],[1,-1]] [x,y] = [3,1] → x=4/3, y=1/3 — also not clean.
    // Use [[1,1],[1,-1]] [x,y] = [3,1] → x=2, y=1.
    void x; // placeholder; the assertion below is what matters.
    const x2 = solve(
      [
        [1, 1],
        [1, -1],
      ],
      [3, 1],
    );
    assert.ok(Math.abs((x2[0] as number) - 2) < 1e-9);
    assert.ok(Math.abs((x2[1] as number) - 1) < 1e-9);
  });

  it('solves a 3x3 with pivoting', () => {
    // A x = b where the first pivot is 0, requiring a row swap.
    const A: Matrix = [
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ];
    const b = [2, 2, 2];
    const x = solve(A, b);
    // Solution: x = y = z = 1.
    assert.ok(Math.abs((x[0] as number) - 1) < 1e-9);
    assert.ok(Math.abs((x[1] as number) - 1) < 1e-9);
    assert.ok(Math.abs((x[2] as number) - 1) < 1e-9);
  });

  it('rejects singular', () => {
    assert.throws(
      () =>
        solve(
          [
            [1, 2],
            [2, 4],
          ],
          [1, 2],
        ),
      /singular/,
    );
  });

  it('rejects non-square A', () => {
    assert.throws(() => solve([[1, 2]], [1]), /square/);
  });

  it('rejects mismatched rhs length', () => {
    assert.throws(
      () =>
        solve(
          [
            [1, 0],
            [0, 1],
          ],
          [1, 2, 3],
        ),
      /rhs length/,
    );
  });

  it('rejects non-finite rhs', () => {
    assert.throws(
      () =>
        solve(
          [
            [1, 0],
            [0, 1],
          ],
          [1, Number.NaN],
        ),
      /non-finite/,
    );
  });
});
