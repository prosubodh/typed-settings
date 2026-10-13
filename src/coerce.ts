// Best-effort leaf coercion. Final authority is the schema.
// Never throws; returns input unchanged when no rule matches.

import { ConfigError } from './errors.js';
import { isProtoKey } from './merge.js';

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i;

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
  // Core booleans/null are case-insensitive (TRUE/FALSE/NULL coerce like
  // true/false/null). Extended words (yes/y/on/no/n/off) intentionally do NOT:
  // they corrupt real data (countries, codes, prose) far more often than help.
  if (low === 'true' || low === 'false') return low === 'true';
  if (low === 'null') return null;
  // Numeric: decimal only, no hex/octal/underscore/NaN/Inf
  if (INT_RE.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s;
  }
  if (FLOAT_RE.test(s) && s !== '-' && s !== '.') {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return s;
  }
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
  // Quoted groups (dotenv single/double quotes, or `\,` escapes) suppress the
  // split: without a bare comma the value stays a string (unescaped on return).
  if (allowSplit && s.includes(',')) {
    if (!hasBareComma(s)) return s.replace(/\\,/g, ',');
    const parts = splitCsv(s);
    if (parts !== null) return parts.map((p) => tryParse(p, false)) as unknown;
  }
  return input;
}

/**
 * True when the string holds a comma that is neither quoted nor `\,`-escaped.
 * dotenv-level quoting is already stripped by then, so this mostly answers for
 * direct tryParse callers; the parser pre-escapes quoted commas (see env.ts).
 */
function hasBareComma(s: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '\\' && s[i + 1] === ',') {
      i++;
      continue;
    }
    if (c === ',') return true;
  }
  return false;
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
    // Only plain objects are rebuilt: class instances (Date, TOML dates, SDK
    // shapes) pass through untouched instead of degrading to `{}`.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Belt-and-braces: pipeline gates forbid __proto__ upstream, but a bare
      // `o[k] = v` with k='__proto__' would hit the prototype setter instead of
      // creating a key. Never reintroduce the sinkhole silently.
      if (isProtoKey(k)) {
        throw new ConfigError([{ path: k, from: 'coerce', message: 'E_PROTO: forbidden key' }], 'E_PROTO');
      }
      o[k] = coerceDeep(v);
    }
    return o;
  }
  return value;
}
