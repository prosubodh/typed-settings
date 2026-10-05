// Best-effort leaf coercion. Final authority is the schema.
// Never throws; returns input unchanged when no rule matches.

/**
 * Coerces one env string to a boolean, number, null, JSON value, or string
 * list. Non-strings and empty strings pass through; unsafe integers, hex,
 * and `NaN`/`Infinity` stay strings.
 */
export function tryParseEnvValue(input: unknown): unknown {
  return tryParse(input, true);
}

function tryParse(input: unknown, allowSplit: boolean): unknown {
  if (typeof input !== 'string') return input;
  const s = input;
  if (s === '') return '';
  const low = s.toLowerCase();
  // Core booleans/null are case-insensitive (TRUE/FALSE/NULL coerce like true/false/null).
  if (low === 'true' || low === 'false') return low === 'true';
  if (low === 'null') return null;
  if (low === 'undefined') return undefined;
  // Numeric: decimal only, no hex/octal/underscore/NaN/Inf
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s;
  }
  if (/^-?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i.test(s) && s !== '-' && s !== '.') {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return s;
  }
  // Booleans ci (extended set) — only when clearly boolean words
  if (['yes', 'y', 'on'].includes(low)) return true;
  if (['no', 'n', 'off'].includes(low)) return false;
  // JSON objects/arrays/quoted strings
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return input;
    }
  }
  // Comma lists (quote-aware, backslash escape). Split only at this level —
  // parts are coerced without re-splitting so `\,` escapes survive recursion.
  if (allowSplit && s.includes(',')) {
    const parts = splitCsv(s);
    if (parts !== null) return parts.map((p) => tryParse(p, false)) as unknown;
  }
  return input;
}

function splitCsv(s: string): string[] | null {
  // Reject if it looks like JSON already handled; split on unquoted commas.
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        cur += c + s[i + 1];
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        cur += c;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && s[i + 1] === ',') {
      cur += ',';
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote) return null;
  out.push(cur.trim());
  // Every caller guarantees at least one comma, so each split yields 2+ parts.
  // Unwrap single-quoted items and unescape `\,` (the escape is consumed here,
  // and parts are NOT re-split, so the literal comma survives).
  return out.map((p) => {
    if (p.length >= 2 && p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1).replace(/\\,/g, ',');
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
    return p.replace(/\\,/g, ',');
  });
}

/** Applies `tryParseEnvValue` to every string leaf, recursing arrays and objects. */
export function coerceDeep(value: unknown): unknown {
  if (typeof value === 'string') return tryParseEnvValue(value);
  if (Array.isArray(value)) return value.map(coerceDeep);
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = coerceDeep(v);
    return o;
  }
  return value;
}
