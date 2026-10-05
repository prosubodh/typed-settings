// Variable expansion per spec v0.1.1: ${VAR} / $VAR, ${VAR:-def} / ${VAR-def},
// $$ escape, single pass, longest match, reject := :? :+, forbid ${${}}.

import { ConfigError } from './errors.js';

const NAME_RE = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * Expands `$VAR` / `${VAR}` / `${VAR:-default}` / `${VAR-default}` in one string,
 * single pass. `$$` and `\$` stay literal, defaults recurse, and only `:-`
 * and `-` operators exist (`E_BAD_OP` otherwise). Unknown names throw
 * `E_UNRESOLVED` unless `allowUnresolved` keeps them verbatim.
 */
export function expandValue(
  input: string,
  lookup: (name: string) => string | undefined,
  opts?: { allowUnresolved?: boolean; from?: string },
): string {
  // Single pass scan
  let out = '';
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '$' && input[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (c === '\\' && input[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    // c === '$'
    const rest = input.slice(i);
    if (rest.startsWith('${')) {
      const parsed = parseBraced(input, i);
      if (!parsed) {
        // $ + invalid -> literal
        out += '$';
        i++;
        continue;
      }
      const { name, op, def, end } = parsed;
      // NOTE: `def` may itself contain `${...}` — recursive defaults such as
      // `${A:-${B:-z}}` are supported (expanded on line 60 below), not forbidden.
      if (op && op !== ':-' && op !== '-') {
        throw new ConfigError([
          { path: name, from: opts?.from ?? 'env', message: `E_BAD_OP: only :- and - supported, got ${op}` },
        ], 'E_BAD_OP');
      }
      const val = lookup(name);
      const missing = val === undefined || (op === ':-' && val === '');
      if (!missing) {
        out += val as string;
      } else if (def !== undefined) {
        // Recursive defaults
        out += expandValue(def, lookup, opts);
      } else if (opts?.allowUnresolved) {
        out += input.slice(i, end);
      } else {
        throw new ConfigError([
          { path: name, from: opts?.from ?? 'env', message: `E_UNRESOLVED: ${name} missing (expand)` },
        ], 'E_UNRESOLVED');
      }
      i = end;
      continue;
    }
    const m = new RegExp(`^\\$(?<name>${NAME_RE})`).exec(rest);
    if (!m || !m.groups) {
      out += '$';
      i++;
      continue;
    }
    const name = m.groups['name'];
    const val = lookup(name);
    if (val === undefined) {
      if (opts?.allowUnresolved) {
        out += '$' + name;
      } else {
        throw new ConfigError([
          { path: name, from: opts?.from ?? 'env', message: `E_UNRESOLVED: ${name} missing (expand)` },
        ], 'E_UNRESOLVED');
      }
    } else {
      out += val;
    }
    i += 1 + name.length;
  }
  return out;
}

function parseBraced(input: string, start: number): { name: string; op?: string; def?: string; end: number } | null {
  // input[start] === '$', input[start+1] === '{'
  let i = start + 2;
  const nameMatch = new RegExp(`^(?<name>${NAME_RE})`).exec(input.slice(i));
  if (!nameMatch?.groups) return null;
  const name = nameMatch.groups['name'];
  i += name.length;
  if (input[i] === '}') return { name, end: i + 1 };
  // Check for :- or - or invalid : ops
  if (input[i] === ':') {
    const two = input.slice(i, i + 2);
    if (two !== ':-') return { name, op: two[0] + (input[i + 1] ?? ''), def: '', end: input.length } as never;
    i += 2;
    const { value, end } = readUntilCloseBrace(input, i);
    return { name, op: ':-', def: value, end };
  }
  if (input[i] === '-') {
    i += 1;
    const { value, end } = readUntilCloseBrace(input, i);
    return { name, op: '-', def: value, end };
  }
  return null;
}

function readUntilCloseBrace(input: string, start: number): { value: string; end: number } {
  let depth = 0;
  let i = start;
  let val = '';
  while (i < input.length) {
    if (input[i] === '\\' && input[i + 1] === '}') {
      val += '}';
      i += 2;
      continue;
    }
    if (input[i] === '{') depth++;
    if (input[i] === '}') {
      if (depth === 0) return { value: val, end: i + 1 };
      depth--;
    }
    val += input[i];
    i++;
  }
  throw new Error('ParseError: unterminated ${}');
}
