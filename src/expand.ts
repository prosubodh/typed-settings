// Variable expansion per spec v0.1.1: ${VAR} / $VAR, ${VAR:-def} / ${VAR-def},
// $$ escape, single pass, longest match, reject := :? :+, forbid ${${}}.

import { ConfigError } from './errors.js';

const NAME_RE = '[A-Za-z_][A-Za-z0-9_]*';
const BARE_REF_RE = new RegExp(`^\\$(?<name>${NAME_RE})`);
const BRACED_NAME_RE = new RegExp(`^(?<name>${NAME_RE})`);
/** Lexical `${...}` nesting cap for standalone expandValue recursion. */
const MAX_NESTING = 50;

/**
 * Expands `$VAR` / `${VAR}` / `${VAR:-default}` / `${VAR-default}` in one string,
 * single pass. `$$` and `\$` stay literal, defaults recurse, and only `:-`
 * and `-` operators exist (`E_BAD_OP` otherwise). Unknown names throw
 * `E_UNRESOLVED` unless `allowUnresolved` keeps them verbatim.
 */
export function expandValue(
  input: string,
  lookup: (name: string) => string | undefined,
  opts?: { allowUnresolved?: boolean; from?: string; leafPath?: string },
  depth = 0,
): string {
  // Lexical nesting cap: `${A:-${B:-...}}` recurses per level. The transitive
  // *chain* cap lives in index.ts; this guards standalone expandValue use.
  if (depth > MAX_NESTING) {
    throw new ConfigError(
      [{ path: opts?.leafPath ?? '<expand>', from: opts?.from ?? 'config', message: `E_DEPTH: \${} nesting too deep (>${MAX_NESTING})` }],
      'E_DEPTH',
    );
  }
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
      // Keep the backslash AND the dollar: `\$` is a literal dollar with its
      // backslash intact (Windows paths like C:\$RECYCLE must round-trip).
      // Use `$$` for a bare `$`.
      out += '\\$';
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
      const parsed = parseBraced(input, i, opts);
      if (!parsed) {
        // $ + invalid -> literal
        out += '$';
        i++;
        continue;
      }
      const { name, op, def, end } = parsed;
      // NOTE: `def` may itself contain `${...}` — recursive defaults such as
      // `${A:-${B:-z}}` are supported (expanded on line 60 below), not forbidden.
      // `path` is the referencing leaf when the pipeline threads it, else the
      // variable itself (direct expandValue callers have no leaf in scope).
      const leaf = opts?.leafPath ?? name;
      const from = opts?.from ?? 'config';
      if (op && op !== ':-' && op !== '-') {
        throw new ConfigError([
          { path: leaf, from, message: `E_BAD_OP: only :- and - supported, got ${op}` },
        ], 'E_BAD_OP');
      }
      const val = lookup(name);
      const missing = val === undefined || (op === ':-' && val === '');
      if (!missing) {
        out += val as string;
      } else if (def !== undefined) {
        // Recursive defaults
        out += expandValue(def, lookup, opts, depth + 1);
      } else if (opts?.allowUnresolved) {
        out += input.slice(i, end);
      } else {
        throw new ConfigError([
          { path: leaf, from, message: `E_UNRESOLVED: ${name} missing (expand)` },
        ], 'E_UNRESOLVED');
      }
      i = end;
      continue;
    }
    const m = BARE_REF_RE.exec(rest);
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
          { path: opts?.leafPath ?? name, from: opts?.from ?? 'config', message: `E_UNRESOLVED: ${name} missing (expand)` },
        ], 'E_UNRESOLVED');
      }
    } else {
      out += val;
    }
    i += 1 + name.length;
  }
  return out;
}

function parseBraced(
  input: string,
  start: number,
  opts?: { allowUnresolved?: boolean; from?: string; leafPath?: string },
): { name: string; op?: string; def?: string; end: number } | null {
  // input[start] === '$', input[start+1] === '{'
  let i = start + 2;
  const nameMatch = BRACED_NAME_RE.exec(input.slice(i));
  if (!nameMatch?.groups) return null;
  const name = nameMatch.groups['name'];
  i += name.length;
  if (input[i] === '}') return { name, end: i + 1 };
  if (i >= input.length) {
    // Truncated mid-expression (`${FOO` at end of input): fail loudly instead
    // of emitting a literal that hides the typo. Other malformed shapes
    // (`${}`, `${A x}`) with a closing brace stay literal (documented).
    throw new ConfigError(
      [{ path: opts?.leafPath ?? name, from: opts?.from ?? 'config', message: 'E_EXPAND: unterminated ${}' }],
      'E_EXPAND',
    );
  }
  // Check for :- or - or invalid : ops
  if (input[i] === ':') {
    const two = input.slice(i, i + 2);
    if (two !== ':-') {
      // Render the actual operator text (':}', ':=x', ':?foo') instead of a
      // fixed two-char slice, capped so hostile input can't bloat the message.
      const rawOp = input.slice(i).split('}')[0]!.slice(0, 12);
      return { name, op: rawOp, def: '', end: input.length } as never;
    }
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
  throw new ConfigError(
    [{ path: '<expand>', from: 'expand', message: 'E_EXPAND: unterminated ${}' }],
    'E_EXPAND',
  );
}
