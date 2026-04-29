// Complex-number value type and operations. Pure: every function takes its
// inputs and returns a fresh Complex (or scalar). No mutation.
//
// All ops are total — they never throw. Operations whose result is not real
// (e.g. division by zero, log of zero) yield NaN/±Infinity components and the
// caller decides whether to surface the result or treat it as an error.

export interface Complex {
  readonly re: number;
  readonly im: number;
}

export function complex(re: number, im = 0): Complex {
  return { re, im };
}

export function fromPolar(magnitude: number, phase: number): Complex {
  return { re: magnitude * Math.cos(phase), im: magnitude * Math.sin(phase) };
}

export function abs(z: Complex): number {
  return Math.hypot(z.re, z.im);
}

export function arg(z: Complex): number {
  return Math.atan2(z.im, z.re);
}

export function conj(z: Complex): Complex {
  return { re: z.re, im: -z.im };
}

export function add(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function sub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function mul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function div(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  if (denom === 0) {
    return {
      re:
        a.re === 0 && a.im === 0
          ? Number.NaN
          : (a.re !== 0 ? Math.sign(a.re) : Math.sign(a.im)) * Number.POSITIVE_INFINITY,
      im:
        a.im === 0 && a.re === 0
          ? Number.NaN
          : (a.im !== 0 ? Math.sign(a.im) : 0) * Number.POSITIVE_INFINITY,
    };
  }
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
}

export function exp(z: Complex): Complex {
  const m = Math.exp(z.re);
  return { re: m * Math.cos(z.im), im: m * Math.sin(z.im) };
}

export function log(z: Complex): Complex {
  // Principal branch: log(z) = ln|z| + i*arg(z), arg ∈ (-π, π].
  return { re: Math.log(abs(z)), im: arg(z) };
}

export function pow(a: Complex, b: Complex): Complex {
  if (a.re === 0 && a.im === 0) {
    if (b.re === 0 && b.im === 0) return { re: 1, im: 0 }; // 0^0 := 1 by convention
    if (b.re > 0 && b.im === 0) return { re: 0, im: 0 };
    return { re: Number.NaN, im: Number.NaN };
  }
  return exp(mul(b, log(a)));
}

export function powScalar(a: Complex, n: number): Complex {
  if (Number.isInteger(n) && n >= 0 && n <= 64) {
    // Exact integer power via repeated squaring — avoids the log/exp round-trip
    // for the common case of small-integer exponents.
    let result: Complex = { re: 1, im: 0 };
    let base: Complex = a;
    let k = n;
    while (k > 0) {
      if ((k & 1) === 1) result = mul(result, base);
      k >>>= 1;
      if (k > 0) base = mul(base, base);
    }
    return result;
  }
  return pow(a, { re: n, im: 0 });
}

export function sqrt(z: Complex): Complex {
  // Branch-stable formula avoiding catastrophic cancellation.
  if (z.re === 0 && z.im === 0) return { re: 0, im: 0 };
  const m = abs(z);
  const sgnIm = z.im >= 0 ? 1 : -1;
  const re = Math.sqrt((m + z.re) / 2);
  const im = sgnIm * Math.sqrt((m - z.re) / 2);
  return { re, im };
}

export function negate(z: Complex): Complex {
  return { re: -z.re, im: -z.im };
}

export function equals(a: Complex, b: Complex, tol = 1e-12): boolean {
  return Math.abs(a.re - b.re) <= tol && Math.abs(a.im - b.im) <= tol;
}

// Render a Complex as a human-readable string. e.g. "1 + 2i", "-3i", "5".
export function format(z: Complex, precision = 10): string {
  const re = roundFinite(z.re, precision);
  const im = roundFinite(z.im, precision);
  if (im === 0) return `${re}`;
  if (re === 0) return im === 1 ? 'i' : im === -1 ? '-i' : `${im}i`;
  const sign = im < 0 ? '-' : '+';
  const absIm = Math.abs(im);
  const imPart = absIm === 1 ? 'i' : `${absIm}i`;
  return `${re} ${sign} ${imPart}`;
}

function roundFinite(x: number, precision: number): number {
  if (!Number.isFinite(x)) return x;
  const factor = 10 ** precision;
  return Math.round(x * factor) / factor;
}
