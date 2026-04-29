// Unit-conversion registry. SI-anchored: every unit defines a `toCanonical`
// (multiply by) factor and an optional `offsetCanonical` for affine units
// (temperature). All conversions go via the category's anchor.
//
// Aliases — abbreviations, plurals, common synonyms — are normalized to the
// canonical name. Lookups are case-insensitive.

export type UnitCategory =
  | 'length'
  | 'mass'
  | 'temperature'
  | 'time'
  | 'volume'
  | 'area'
  | 'speed'
  | 'pressure'
  | 'energy'
  | 'power'
  | 'force'
  | 'angle'
  | 'data';

export interface UnitDefinition {
  readonly canonical: string;
  readonly category: UnitCategory;
  readonly toCanonical: number; // multiply by to get canonical units
  readonly offsetCanonical?: number; // for affine units: canonical = value*toCanonical + offset
  readonly aliases: readonly string[]; // case-insensitive
}

export class UnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitsError';
  }
}

// Canonicals (the row each category measures against):
//   length: meter, mass: kilogram, temperature: kelvin, time: second,
//   volume: cubic_meter, area: square_meter, speed: meter_per_second,
//   pressure: pascal, energy: joule, power: watt, force: newton,
//   angle: radian, data: byte
const DEFINITIONS: readonly UnitDefinition[] = [
  // ---- Length (anchor: meter) ----
  {
    canonical: 'meter',
    category: 'length',
    toCanonical: 1,
    aliases: ['m', 'metre', 'meters', 'metres'],
  },
  {
    canonical: 'kilometer',
    category: 'length',
    toCanonical: 1000,
    aliases: ['km', 'kilometre', 'kilometers', 'kilometres'],
  },
  {
    canonical: 'centimeter',
    category: 'length',
    toCanonical: 0.01,
    aliases: ['cm', 'centimetre', 'centimeters', 'centimetres'],
  },
  {
    canonical: 'millimeter',
    category: 'length',
    toCanonical: 0.001,
    aliases: ['mm', 'millimetre', 'millimeters', 'millimetres'],
  },
  {
    canonical: 'micrometer',
    category: 'length',
    toCanonical: 1e-6,
    aliases: ['um', 'micron', 'micrometre', 'micrometers', 'microns'],
  },
  {
    canonical: 'nanometer',
    category: 'length',
    toCanonical: 1e-9,
    aliases: ['nm', 'nanometre', 'nanometers'],
  },
  { canonical: 'mile', category: 'length', toCanonical: 1609.344, aliases: ['mi', 'miles'] },
  { canonical: 'yard', category: 'length', toCanonical: 0.9144, aliases: ['yd', 'yards'] },
  { canonical: 'foot', category: 'length', toCanonical: 0.3048, aliases: ['ft', 'feet'] },
  { canonical: 'inch', category: 'length', toCanonical: 0.0254, aliases: ['in', 'inches'] },
  {
    canonical: 'nautical_mile',
    category: 'length',
    toCanonical: 1852,
    aliases: ['nmi', 'nautical_miles'],
  },
  {
    canonical: 'light_year',
    category: 'length',
    toCanonical: 9.4607304725808e15,
    aliases: ['ly', 'light_years', 'lightyear', 'lightyears'],
  },
  {
    canonical: 'astronomical_unit',
    category: 'length',
    toCanonical: 1.495978707e11,
    aliases: ['au', 'astronomical_units'],
  },

  // ---- Mass (anchor: kilogram) ----
  {
    canonical: 'kilogram',
    category: 'mass',
    toCanonical: 1,
    aliases: ['kg', 'kilo', 'kilos', 'kilograms'],
  },
  { canonical: 'gram', category: 'mass', toCanonical: 0.001, aliases: ['g', 'grams'] },
  { canonical: 'milligram', category: 'mass', toCanonical: 1e-6, aliases: ['mg', 'milligrams'] },
  { canonical: 'microgram', category: 'mass', toCanonical: 1e-9, aliases: ['ug', 'micrograms'] },
  {
    canonical: 'tonne',
    category: 'mass',
    toCanonical: 1000,
    aliases: ['t', 'metric_ton', 'metric_tonne', 'tonnes'],
  },
  {
    canonical: 'pound',
    category: 'mass',
    toCanonical: 0.45359237,
    aliases: ['lb', 'lbs', 'pounds', 'pound_mass'],
  },
  { canonical: 'ounce', category: 'mass', toCanonical: 0.028349523125, aliases: ['oz', 'ounces'] },
  { canonical: 'stone', category: 'mass', toCanonical: 6.35029318, aliases: ['st', 'stones'] },
  {
    canonical: 'ton_us',
    category: 'mass',
    toCanonical: 907.18474,
    aliases: ['short_ton', 'us_ton'],
  },
  {
    canonical: 'ton_uk',
    category: 'mass',
    toCanonical: 1016.0469088,
    aliases: ['long_ton', 'uk_ton', 'imperial_ton'],
  },

  // ---- Temperature (anchor: kelvin, AFFINE) ----
  {
    canonical: 'kelvin',
    category: 'temperature',
    toCanonical: 1,
    offsetCanonical: 0,
    aliases: ['k'],
  },
  {
    canonical: 'celsius',
    category: 'temperature',
    toCanonical: 1,
    offsetCanonical: 273.15,
    aliases: ['c', '°c', 'centigrade'],
  },
  {
    canonical: 'fahrenheit',
    category: 'temperature',
    toCanonical: 5 / 9,
    offsetCanonical: (459.67 * 5) / 9,
    aliases: ['f', '°f'],
  },
  {
    canonical: 'rankine',
    category: 'temperature',
    toCanonical: 5 / 9,
    offsetCanonical: 0,
    aliases: ['r', '°r'],
  },

  // ---- Time (anchor: second) ----
  {
    canonical: 'second',
    category: 'time',
    toCanonical: 1,
    aliases: ['s', 'sec', 'secs', 'seconds'],
  },
  {
    canonical: 'millisecond',
    category: 'time',
    toCanonical: 1e-3,
    aliases: ['ms', 'milliseconds'],
  },
  {
    canonical: 'microsecond',
    category: 'time',
    toCanonical: 1e-6,
    aliases: ['us', 'microseconds'],
  },
  { canonical: 'nanosecond', category: 'time', toCanonical: 1e-9, aliases: ['ns', 'nanoseconds'] },
  { canonical: 'minute', category: 'time', toCanonical: 60, aliases: ['min', 'mins', 'minutes'] },
  { canonical: 'hour', category: 'time', toCanonical: 3600, aliases: ['h', 'hr', 'hrs', 'hours'] },
  { canonical: 'day', category: 'time', toCanonical: 86400, aliases: ['d', 'days'] },
  { canonical: 'week', category: 'time', toCanonical: 604800, aliases: ['wk', 'weeks'] },
  { canonical: 'month_avg', category: 'time', toCanonical: 2629746, aliases: ['month', 'months'] },
  {
    canonical: 'year_avg',
    category: 'time',
    toCanonical: 31556952,
    aliases: ['year', 'years', 'yr', 'yrs'],
  },

  // ---- Volume (anchor: cubic_meter) ----
  {
    canonical: 'cubic_meter',
    category: 'volume',
    toCanonical: 1,
    aliases: ['m3', 'm^3', 'cubic_meters', 'cubic_metre', 'cubic_metres'],
  },
  {
    canonical: 'liter',
    category: 'volume',
    toCanonical: 1e-3,
    aliases: ['l', 'litre', 'liters', 'litres'],
  },
  {
    canonical: 'milliliter',
    category: 'volume',
    toCanonical: 1e-6,
    aliases: ['ml', 'millilitre', 'milliliters', 'millilitres'],
  },
  {
    canonical: 'cubic_centimeter',
    category: 'volume',
    toCanonical: 1e-6,
    aliases: ['cc', 'cm3', 'cm^3', 'cubic_centimeters', 'cubic_centimetre'],
  },
  {
    canonical: 'gallon_us',
    category: 'volume',
    toCanonical: 0.003785411784,
    aliases: ['gal', 'gallon', 'gallons', 'us_gallon', 'gallons_us'],
  },
  {
    canonical: 'gallon_uk',
    category: 'volume',
    toCanonical: 0.00454609,
    aliases: ['imperial_gallon', 'uk_gallon'],
  },
  {
    canonical: 'quart_us',
    category: 'volume',
    toCanonical: 0.000946352946,
    aliases: ['qt', 'quart', 'quarts'],
  },
  {
    canonical: 'pint_us',
    category: 'volume',
    toCanonical: 0.000473176473,
    aliases: ['pt', 'pint', 'pints'],
  },
  {
    canonical: 'cup_us',
    category: 'volume',
    toCanonical: 0.0002365882365,
    aliases: ['cup', 'cups'],
  },
  {
    canonical: 'fluid_ounce_us',
    category: 'volume',
    toCanonical: 0.0000295735295625,
    aliases: ['fl_oz', 'floz', 'fluid_ounces', 'fluid_oz'],
  },
  {
    canonical: 'tablespoon_us',
    category: 'volume',
    toCanonical: 0.00001478676478125,
    aliases: ['tbsp', 'tablespoon', 'tablespoons'],
  },
  {
    canonical: 'teaspoon_us',
    category: 'volume',
    // Exact: 1 fluid_ounce_us = 6 tsp = 3 tbsp. Stored as the exact double
    // so 6 tsp ↔ 1 fl_oz roundtrips. The previous literal (0.000004928922161458333)
    // was off by ~1.15e-7 — a typo, not the true definitional value.
    toCanonical: 0.00000492892159375,
    aliases: ['tsp', 'teaspoon', 'teaspoons'],
  },
  {
    canonical: 'cubic_foot',
    category: 'volume',
    toCanonical: 0.028316846592,
    aliases: ['ft3', 'ft^3', 'cubic_feet'],
  },
  {
    canonical: 'cubic_inch',
    category: 'volume',
    toCanonical: 0.000016387064,
    aliases: ['in3', 'in^3', 'cubic_inches'],
  },

  // ---- Area (anchor: square_meter) ----
  {
    canonical: 'square_meter',
    category: 'area',
    toCanonical: 1,
    aliases: ['m2', 'm^2', 'square_meters', 'square_metre', 'square_metres', 'sqm'],
  },
  {
    canonical: 'square_kilometer',
    category: 'area',
    toCanonical: 1e6,
    aliases: ['km2', 'km^2', 'square_kilometers'],
  },
  {
    canonical: 'square_centimeter',
    category: 'area',
    toCanonical: 1e-4,
    aliases: ['cm2', 'cm^2', 'square_centimeters'],
  },
  {
    canonical: 'square_millimeter',
    category: 'area',
    toCanonical: 1e-6,
    aliases: ['mm2', 'mm^2', 'square_millimeters'],
  },
  { canonical: 'hectare', category: 'area', toCanonical: 10000, aliases: ['ha', 'hectares'] },
  { canonical: 'acre', category: 'area', toCanonical: 4046.8564224, aliases: ['ac', 'acres'] },
  {
    canonical: 'square_mile',
    category: 'area',
    toCanonical: 2589988.110336,
    aliases: ['mi2', 'sq_mi', 'square_miles'],
  },
  {
    canonical: 'square_yard',
    category: 'area',
    toCanonical: 0.83612736,
    aliases: ['yd2', 'sq_yd', 'square_yards'],
  },
  {
    canonical: 'square_foot',
    category: 'area',
    toCanonical: 0.09290304,
    aliases: ['ft2', 'sq_ft', 'square_feet', 'sqft'],
  },
  {
    canonical: 'square_inch',
    category: 'area',
    toCanonical: 0.00064516,
    aliases: ['in2', 'sq_in', 'square_inches'],
  },

  // ---- Speed (anchor: meter_per_second) ----
  {
    canonical: 'meter_per_second',
    category: 'speed',
    toCanonical: 1,
    aliases: ['m/s', 'mps', 'meters_per_second', 'metres_per_second'],
  },
  {
    canonical: 'kilometer_per_hour',
    category: 'speed',
    toCanonical: 1 / 3.6,
    aliases: ['km/h', 'kph', 'kmh', 'kilometers_per_hour', 'kilometres_per_hour'],
  },
  {
    canonical: 'mile_per_hour',
    category: 'speed',
    toCanonical: 0.44704,
    aliases: ['mph', 'miles_per_hour'],
  },
  // 1 knot = 1 nautical_mile / hour = 1852 m / 3600 s. Use the exact ratio.
  {
    canonical: 'knot',
    category: 'speed',
    toCanonical: 1852 / 3600,
    aliases: ['kn', 'kt', 'knots'],
  },
  {
    canonical: 'foot_per_second',
    category: 'speed',
    toCanonical: 0.3048,
    aliases: ['ft/s', 'fps', 'feet_per_second'],
  },

  // ---- Pressure (anchor: pascal) ----
  { canonical: 'pascal', category: 'pressure', toCanonical: 1, aliases: ['pa', 'pascals'] },
  {
    canonical: 'kilopascal',
    category: 'pressure',
    toCanonical: 1000,
    aliases: ['kpa', 'kilopascals'],
  },
  {
    canonical: 'megapascal',
    category: 'pressure',
    toCanonical: 1e6,
    aliases: ['mpa', 'megapascals'],
  },
  { canonical: 'bar', category: 'pressure', toCanonical: 1e5, aliases: ['bars'] },
  { canonical: 'millibar', category: 'pressure', toCanonical: 100, aliases: ['mbar', 'millibars'] },
  {
    canonical: 'atmosphere',
    category: 'pressure',
    toCanonical: 101325,
    aliases: ['atm', 'atmospheres'],
  },
  { canonical: 'torr', category: 'pressure', toCanonical: 133.32236842105263, aliases: ['torrs'] },
  {
    canonical: 'psi',
    category: 'pressure',
    toCanonical: 6894.757293168361,
    aliases: ['pound_per_square_inch', 'pounds_per_square_inch'],
  },
  {
    canonical: 'mmhg',
    category: 'pressure',
    toCanonical: 133.322387415,
    aliases: ['mm_hg', 'millimeters_of_mercury'],
  },
  {
    canonical: 'inhg',
    category: 'pressure',
    // Exact: 1 inHg = 25.4 mm × ρ(Hg) × g = 25.4 · mmHg = 25.4 · 133.322387415 Pa.
    toCanonical: 25.4 * 133.322387415,
    aliases: ['in_hg', 'inches_of_mercury'],
  },

  // ---- Energy (anchor: joule) ----
  { canonical: 'joule', category: 'energy', toCanonical: 1, aliases: ['j', 'joules'] },
  { canonical: 'kilojoule', category: 'energy', toCanonical: 1000, aliases: ['kj', 'kilojoules'] },
  { canonical: 'megajoule', category: 'energy', toCanonical: 1e6, aliases: ['mj', 'megajoules'] },
  { canonical: 'calorie', category: 'energy', toCanonical: 4.184, aliases: ['cal', 'calories'] },
  {
    canonical: 'kilocalorie',
    category: 'energy',
    toCanonical: 4184,
    aliases: ['kcal', 'kilocalories', 'food_calorie', 'food_calories'],
  },
  { canonical: 'watt_hour', category: 'energy', toCanonical: 3600, aliases: ['wh', 'watt_hours'] },
  {
    canonical: 'kilowatt_hour',
    category: 'energy',
    toCanonical: 3.6e6,
    aliases: ['kwh', 'kilowatt_hours'],
  },
  {
    canonical: 'electronvolt',
    category: 'energy',
    toCanonical: 1.602176634e-19,
    aliases: ['ev', 'electron_volt', 'electron_volts'],
  },
  {
    canonical: 'btu',
    category: 'energy',
    toCanonical: 1055.05585262,
    aliases: ['british_thermal_unit', 'btus'],
  },
  {
    canonical: 'foot_pound',
    category: 'energy',
    toCanonical: 1.3558179483314003,
    aliases: ['ft_lb', 'foot_pounds'],
  },

  // ---- Power (anchor: watt) ----
  { canonical: 'watt', category: 'power', toCanonical: 1, aliases: ['w', 'watts'] },
  { canonical: 'kilowatt', category: 'power', toCanonical: 1000, aliases: ['kw', 'kilowatts'] },
  { canonical: 'megawatt', category: 'power', toCanonical: 1e6, aliases: ['mw', 'megawatts'] },
  {
    canonical: 'horsepower_metric',
    category: 'power',
    toCanonical: 735.49875,
    aliases: ['hp', 'horsepower', 'metric_hp', 'ps'],
  },
  {
    canonical: 'horsepower_mechanical',
    category: 'power',
    toCanonical: 745.6998715822702,
    aliases: ['mechanical_hp', 'imperial_hp', 'hp_mechanical'],
  },
  {
    canonical: 'btu_per_hour',
    category: 'power',
    // Exact ratio: 1 BTU (international steam table) per 3600 seconds.
    toCanonical: 1055.05585262 / 3600,
    aliases: ['btu/h', 'btu/hr', 'btu_h'],
  },

  // ---- Force (anchor: newton) ----
  { canonical: 'newton', category: 'force', toCanonical: 1, aliases: ['n', 'newtons'] },
  { canonical: 'kilonewton', category: 'force', toCanonical: 1000, aliases: ['kilonewtons'] },
  { canonical: 'dyne', category: 'force', toCanonical: 1e-5, aliases: ['dynes', 'dyn'] },
  {
    canonical: 'pound_force',
    category: 'force',
    toCanonical: 4.4482216152605,
    aliases: ['lbf', 'pounds_force'],
  },
  {
    canonical: 'kilogram_force',
    category: 'force',
    toCanonical: 9.80665,
    aliases: ['kgf', 'kilograms_force', 'kp', 'kilopond'],
  },

  // ---- Angle (anchor: radian) ----
  { canonical: 'radian', category: 'angle', toCanonical: 1, aliases: ['rad', 'radians'] },
  {
    canonical: 'degree',
    category: 'angle',
    toCanonical: Math.PI / 180,
    aliases: ['deg', '°', 'degrees'],
  },
  {
    canonical: 'gradian',
    category: 'angle',
    toCanonical: Math.PI / 200,
    aliases: ['grad', 'gon', 'gradians'],
  },
  {
    canonical: 'arcminute',
    category: 'angle',
    toCanonical: Math.PI / (180 * 60),
    aliases: ['arcmin', 'arcminutes'],
  },
  {
    canonical: 'arcsecond',
    category: 'angle',
    toCanonical: Math.PI / (180 * 3600),
    aliases: ['arcsec', 'arcseconds'],
  },
  {
    canonical: 'turn',
    category: 'angle',
    toCanonical: 2 * Math.PI,
    aliases: ['turns', 'rev', 'revolution', 'revolutions'],
  },

  // ---- Data (anchor: byte) ----
  { canonical: 'byte', category: 'data', toCanonical: 1, aliases: ['b', 'bytes'] },
  { canonical: 'kilobyte', category: 'data', toCanonical: 1e3, aliases: ['kb', 'kilobytes'] },
  { canonical: 'megabyte', category: 'data', toCanonical: 1e6, aliases: ['mb', 'megabytes'] },
  { canonical: 'gigabyte', category: 'data', toCanonical: 1e9, aliases: ['gb', 'gigabytes'] },
  { canonical: 'terabyte', category: 'data', toCanonical: 1e12, aliases: ['tb', 'terabytes'] },
  { canonical: 'petabyte', category: 'data', toCanonical: 1e15, aliases: ['pb', 'petabytes'] },
  { canonical: 'kibibyte', category: 'data', toCanonical: 1024, aliases: ['kib', 'kibibytes'] },
  {
    canonical: 'mebibyte',
    category: 'data',
    toCanonical: 1024 ** 2,
    aliases: ['mib', 'mebibytes'],
  },
  {
    canonical: 'gibibyte',
    category: 'data',
    toCanonical: 1024 ** 3,
    aliases: ['gib', 'gibibytes'],
  },
  {
    canonical: 'tebibyte',
    category: 'data',
    toCanonical: 1024 ** 4,
    aliases: ['tib', 'tebibytes'],
  },
  {
    canonical: 'pebibyte',
    category: 'data',
    toCanonical: 1024 ** 5,
    aliases: ['pib', 'pebibytes'],
  },
  { canonical: 'bit', category: 'data', toCanonical: 1 / 8, aliases: ['bits'] },
];

// Build the lookup once, keyed on normalized name (lowercase, trimmed).
// We freeze the map as a Map so new entries cannot be added later.
const LOOKUP: ReadonlyMap<string, UnitDefinition> = (() => {
  const m = new Map<string, UnitDefinition>();
  for (const def of DEFINITIONS) {
    const names = [def.canonical, ...def.aliases];
    for (const n of names) {
      const key = n.toLowerCase().trim();
      if (m.has(key) && m.get(key) !== def) {
        // Two definitions claim the same alias. Bail loudly at module load.
        throw new Error(`Unit alias collision on "${key}".`);
      }
      m.set(key, def);
    }
  }
  return m;
})();

function lookup(name: string): UnitDefinition | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) return undefined;
  return LOOKUP.get(name.toLowerCase().trim());
}

// Levenshtein-distance-based suggestion. Bounded by candidates ≤ 256 names.
function suggest(unknown: string, max = 3): readonly string[] {
  const target = unknown.toLowerCase().trim();
  if (target.length === 0) return [];
  const distances: { name: string; d: number }[] = [];
  for (const key of LOOKUP.keys()) {
    distances.push({ name: key, d: editDistance(target, key) });
  }
  distances.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return distances.slice(0, max).map((x) => x.name);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j] as number;
  }
  return prev[n] as number;
}

export interface ConvertResult {
  readonly value: number;
  readonly from: { readonly canonical: string; readonly category: UnitCategory };
  readonly to: { readonly canonical: string; readonly category: UnitCategory };
}

export function convert(value: number, fromName: string, toName: string): ConvertResult {
  if (!Number.isFinite(value)) {
    throw new UnitsError(`convert requires a finite value; got ${value}.`);
  }
  const fromDef = lookup(fromName);
  const toDef = lookup(toName);
  if (!fromDef) {
    const hints = suggest(fromName);
    throw new UnitsError(
      `Unknown unit "${fromName}". Closest matches: ${hints.join(', ') || '(none)'}.`,
    );
  }
  if (!toDef) {
    const hints = suggest(toName);
    throw new UnitsError(
      `Unknown unit "${toName}". Closest matches: ${hints.join(', ') || '(none)'}.`,
    );
  }
  if (fromDef.category !== toDef.category) {
    throw new UnitsError(
      `Cannot convert between different categories: "${fromName}" is ${fromDef.category}, "${toName}" is ${toDef.category}.`,
    );
  }

  // Convert via the canonical: canonical_value = value*toCanonical + offsetCanonical (if affine).
  const canonicalValue = value * fromDef.toCanonical + (fromDef.offsetCanonical ?? 0);
  const result = (canonicalValue - (toDef.offsetCanonical ?? 0)) / toDef.toCanonical;

  return {
    value: result,
    from: { canonical: fromDef.canonical, category: fromDef.category },
    to: { canonical: toDef.canonical, category: toDef.category },
  };
}

// Expose the registry for documentation / discovery (read-only).
export function listUnits(category?: UnitCategory): readonly UnitDefinition[] {
  if (category === undefined) return DEFINITIONS;
  return DEFINITIONS.filter((d) => d.category === category);
}
