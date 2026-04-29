import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convert, listUnits, UnitsError } from './units.ts';

const TOL = 1e-9;

function close(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('convert — length', () => {
  it('m → ft', () => {
    assert.ok(close(convert(1, 'meter', 'foot').value, 3.28084, 1e-5));
  });

  it('km → mile', () => {
    assert.ok(close(convert(10, 'kilometer', 'mile').value, 6.21371192, 1e-7));
  });

  it('inch → cm', () => {
    assert.ok(close(convert(1, 'inch', 'centimeter').value, 2.54));
  });

  it('plural / abbreviation aliases', () => {
    assert.ok(close(convert(1, 'meters', 'feet').value, 3.28084, 1e-5));
    assert.ok(close(convert(100, 'cm', 'm').value, 1));
    assert.ok(close(convert(1, 'mi', 'km').value, 1.609344));
  });

  it('case-insensitive', () => {
    assert.ok(close(convert(1, 'METER', 'FOOT').value, 3.28084, 1e-5));
  });
});

describe('convert — temperature (affine)', () => {
  it('celsius ↔ fahrenheit', () => {
    assert.ok(close(convert(0, 'celsius', 'fahrenheit').value, 32));
    assert.ok(close(convert(100, 'celsius', 'fahrenheit').value, 212));
    assert.ok(close(convert(32, 'fahrenheit', 'celsius').value, 0));
    assert.ok(close(convert(212, 'fahrenheit', 'celsius').value, 100));
  });

  it('celsius ↔ kelvin', () => {
    assert.ok(close(convert(0, 'celsius', 'kelvin').value, 273.15));
    assert.ok(close(convert(273.15, 'kelvin', 'celsius').value, 0));
  });

  it('fahrenheit ↔ rankine', () => {
    // 32 F = 491.67 R
    assert.ok(close(convert(32, 'fahrenheit', 'rankine').value, 491.67, 1e-3));
    assert.ok(close(convert(491.67, 'rankine', 'fahrenheit').value, 32, 1e-3));
  });

  it('kelvin ↔ rankine', () => {
    // 1 K = 1.8 R
    assert.ok(close(convert(100, 'kelvin', 'rankine').value, 180));
  });
});

describe('convert — mass', () => {
  it('kg ↔ lb', () => {
    assert.ok(close(convert(1, 'kilogram', 'pound').value, 2.20462262));
  });

  it('oz → g', () => {
    assert.ok(close(convert(1, 'ounce', 'gram').value, 28.349523125));
  });
});

describe('convert — time', () => {
  it('hr ↔ s', () => {
    assert.equal(convert(1, 'hour', 'second').value, 3600);
    assert.ok(close(convert(60, 'min', 's').value, 3600));
  });

  it('day ↔ hour', () => {
    assert.equal(convert(1, 'day', 'hour').value, 24);
  });
});

describe('convert — volume', () => {
  it('liter ↔ cubic_centimeter', () => {
    assert.ok(close(convert(1, 'liter', 'milliliter').value, 1000));
  });

  it('gallon_us → liter', () => {
    assert.ok(close(convert(1, 'gallon_us', 'liter').value, 3.785411784));
  });

  it('teaspoon roundtrips exactly with fluid_ounce / tablespoon', () => {
    // 1 fl_oz = 6 tsp = 3 tbsp by exact US customary definition.
    assert.ok(close(convert(6, 'teaspoon_us', 'fluid_ounce_us').value, 1, 1e-12));
    assert.ok(close(convert(3, 'teaspoon_us', 'tablespoon_us').value, 1, 1e-12));
    assert.ok(close(convert(1, 'fluid_ounce_us', 'teaspoon_us').value, 6, 1e-12));
    assert.ok(close(convert(1, 'tablespoon_us', 'teaspoon_us').value, 3, 1e-12));
  });
});

describe('convert — area', () => {
  it('hectare → m^2', () => {
    assert.equal(convert(1, 'hectare', 'square_meter').value, 10000);
  });
});

describe('convert — speed', () => {
  it('km/h → mph', () => {
    assert.ok(close(convert(100, 'kilometer_per_hour', 'mile_per_hour').value, 62.137119, 1e-5));
  });

  it('knot → m/s', () => {
    // 1 knot = 1852 m / 3600 s exactly.
    assert.ok(close(convert(1, 'knot', 'meter_per_second').value, 1852 / 3600, 1e-12));
  });
});

describe('convert — pressure / energy / power / force', () => {
  it('atm → pa', () => {
    assert.equal(convert(1, 'atmosphere', 'pascal').value, 101325);
  });

  it('kcal → kj', () => {
    assert.ok(close(convert(1, 'kilocalorie', 'kilojoule').value, 4.184));
  });

  it('hp → kW', () => {
    assert.ok(close(convert(1, 'horsepower_metric', 'kilowatt').value, 0.73549875));
  });

  it('lbf → newton', () => {
    assert.ok(close(convert(1, 'pound_force', 'newton').value, 4.4482216152605));
  });
});

describe('convert — angle', () => {
  it('radian ↔ degree', () => {
    assert.ok(close(convert(Math.PI, 'radian', 'degree').value, 180));
    assert.ok(close(convert(180, 'degree', 'radian').value, Math.PI));
  });

  it('turn ↔ degree', () => {
    assert.ok(close(convert(1, 'turn', 'degree').value, 360));
  });
});

describe('convert — data', () => {
  it('decimal vs binary kb', () => {
    assert.equal(convert(1, 'kilobyte', 'byte').value, 1000);
    assert.equal(convert(1, 'kibibyte', 'byte').value, 1024);
  });

  it('byte ↔ bit', () => {
    assert.equal(convert(1, 'byte', 'bit').value, 8);
  });
});

describe('convert — error paths', () => {
  it('rejects unknown source unit', () => {
    assert.throws(() => convert(1, 'nope', 'meter'), UnitsError);
    assert.throws(() => convert(1, '', 'meter'), UnitsError);
  });

  it('rejects unknown target unit', () => {
    assert.throws(() => convert(1, 'meter', 'gallone'), UnitsError);
  });

  it('error message includes a suggestion', () => {
    try {
      convert(1, 'metre_pe_secund', 'meter');
      assert.fail('expected throw');
    } catch (err) {
      assert.match((err as Error).message, /Closest matches/);
    }
  });

  it('rejects cross-category conversion', () => {
    assert.throws(() => convert(1, 'meter', 'gram'), /different categories/);
  });

  it('rejects non-finite value', () => {
    assert.throws(() => convert(Number.NaN, 'meter', 'foot'), /finite/);
  });
});

describe('listUnits', () => {
  it('returns all when no category specified', () => {
    const all = listUnits();
    assert.ok(all.length > 50);
  });

  it('filters by category', () => {
    const lengths = listUnits('length');
    assert.ok(lengths.every((u) => u.category === 'length'));
    assert.ok(lengths.length >= 10);
  });
});
