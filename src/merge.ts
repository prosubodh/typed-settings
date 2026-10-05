import type { ArrayStrategy } from './types.js';
import { ConfigError } from './errors.js';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const INDEX_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Strips `prefix` (case-insensitive, once) from a flat key. Returns the
 * remainder, or `null` when the key doesn't qualify (too short, no match).
 */
export function stripPrefix(key: string, prefix?: string): string | null {
  if (!prefix) return key;
  if (key.length <= prefix.length) return null;
  if (key.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  // The length check above guarantees a non-empty remainder.
  return key.slice(prefix.length);
}

/**
 * Expands flat `UPPER__NESTED` keys into nested objects. Only `__` splits;
 * keys lowercase; `envMap` entries stay literal. Throws `E_PROTO` on forbidden
 * segments and `E_ARRAY_MIX` on same-layer scalar/indexed/named mixing. Keys
 * whose `__` separators don't split into all-non-empty segments (e.g. Next.js's
 * `__NEXT_*`) are kept as literal top-level keys instead of throwing.
 */
export function expandKeys(
  flat: Record<string, unknown>,
  opts?: { separator?: '__'; prefix?: string; envMap?: Record<string, string> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Per-top tracking for same-layer mixing detection (scalar vs indexed vs named).
  const topKinds = new Map<string, { indexed: boolean; named: boolean; scalar: boolean }>();
  const kindOf = (top: string) => {
    let k = topKinds.get(top);
    if (!k) {
      k = { indexed: false, named: false, scalar: false };
      topKinds.set(top, k);
    }
    return k;
  };
  const lookupEnvMap = (rawKey: string): string | undefined => {
    if (!opts?.envMap) return undefined;
    // trackFlat lowercases keys before this runs, so match case-insensitively.
    for (const cand of [rawKey, rawKey.toLowerCase(), rawKey.toUpperCase()]) {
      const hit = opts.envMap[cand];
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (const [rawKey, value] of Object.entries(flat)) {
    if (!/^[A-Za-z0-9_]+$/.test(rawKey)) continue; // ignore + warn (warn omitted in core)
    const escaped = lookupEnvMap(rawKey);
    const effective = escaped ?? rawKey;
    // Escaped keys are literal: they skip BOTH prefix-stripping and `__` splitting.
    if (escaped !== undefined) {
      const k = effective.toLowerCase();
      if (FORBIDDEN.has(k)) throw new ConfigError([{ path: rawKey, from: 'keys', message: 'E_PROTO' }], 'E_PROTO');
      out[k] = value;
      continue;
    }
    const stripped = stripPrefix(rawKey, opts?.prefix);
    if (stripped === null) continue;
    const useKey = stripped;
    // Whole-key E_PROTO check first (case-insensitive): '__proto__' splits into
    // empties that would otherwise hide the real problem.
    if (FORBIDDEN.has(useKey.toLowerCase())) throw new ConfigError([{ path: rawKey, from: 'keys', message: 'E_PROTO: forbidden key' }], 'E_PROTO');
    const parts = useKey.split('__');
    const cleanSplit = parts.length > 1 && parts.every((p) => p !== '');
    if (cleanSplit) {
      for (const p of parts) {
        // Forbidden segments, case-insensitive: keys are lowercased below.
        if (FORBIDDEN.has(p.toLowerCase())) throw new ConfigError([{ path: rawKey, from: 'keys', message: 'E_PROTO: forbidden key' }], 'E_PROTO');
      }
      const lowered = parts.map((p) => p.toLowerCase());
      const top = lowered[0]!;
      const kind = kindOf(top);
      const childIsIndex = lowered.length > 1 && INDEX_RE.test(lowered[1]!);
      if (kind.scalar && childIsIndex) {
        throw new ConfigError(
          [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${top}' has both scalar/list and indexed (__0) values in the same layer` }],
          'E_ARRAY_MIX',
        );
      }
      if (childIsIndex) {
        if (kind.named) {
          throw new ConfigError(
            [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${top}' mixes indexed (__0) and named children in the same layer` }],
            'E_ARRAY_MIX',
          );
        }
        kind.indexed = true;
      } else if (lowered.length > 1) {
        if (kind.indexed) {
          throw new ConfigError(
            [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${top}' mixes named and indexed (__0) children in the same layer` }],
            'E_ARRAY_MIX',
          );
        }
        kind.named = true;
      }
      setPath(out, lowered, value);
    } else {
      const k = useKey.toLowerCase();
      // No E_PROTO check here: the whole-key check above already rejected every
      // forbidden key (k === useKey.toLowerCase()), split or not.
      const kind = kindOf(k);
      if (kind.indexed) {
        throw new ConfigError(
          [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${k}' has both indexed (__0) and scalar/list values in the same layer` }],
          'E_ARRAY_MIX',
        );
      }
      kind.scalar = true;
      // Case-insensitive collision handled at validate layer; last wins here.
      out[k] = value;
    }
  }
  return out;
}

/**
 * Folds all-index objects (`{0:.., 1:..}`) into arrays, depth-first. Gaps throw
 * `E_SPARSE_ARRAY`, over 1024 elements throws `E_ARRAY_CAP`. Objects with any
 * non-index key keep literal keys.
 */
export function normalizeIndexedObjects(value: unknown, path = '<root>'): unknown {
  if (Array.isArray(value)) return value.map((x, i) => normalizeIndexedObjects(x, `${path}[${i}]`));
  if (!isPlainObject(value)) return value;
  const entries = Object.entries(value);
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    normalized[k] = normalizeIndexedObjects(v, path === '<root>' ? k : `${path}.${k}`);
  }
  if (entries.length > 0 && entries.every(([k]) => INDEX_RE.test(k))) {
    const idx = entries.map(([k]) => Number(k)).sort((a, b) => a - b);
    if (idx.length > 1024) {
      throw new ConfigError([{ path, from: 'keys', message: 'E_ARRAY_CAP: >1024 elements' }], 'E_ARRAY_CAP');
    }
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] !== i) {
        throw new ConfigError(
          [{ path, from: 'keys', message: `E_SPARSE_ARRAY: indexes [${idx.join(',')}] are not dense 0..${idx.length - 1}` }],
          'E_SPARSE_ARRAY',
        );
      }
    }
    return idx.map((_, i) => (normalized as Record<string, unknown>)[String(i)]);
  }
  return normalized;
}

function setPath(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const existing = cur[p];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      cur = existing as Record<string, unknown>;
    } else {
      const n: Record<string, unknown> = {};
      cur[p] = n;
      cur = n;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

/** True for plain object literals (and `Object.create(null)`), false for arrays, class instances, and primitives. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merges `override` over `base` (later source wins per leaf). `undefined`
 * passes through, `null` wins outright, class instances replace instead of
 * merging, and `__proto__` keys throw `E_PROTO`. Arrays follow `arrayStrategy`
 * (`replace` wins wholesale, `concat` appends, `mergeIndex` unions per index).
 */
export function deepMerge(base: unknown, override: unknown, arrayStrategy: ArrayStrategy = 'replace'): unknown {
  if (override === undefined) return base;
  if (base === undefined) return override;
  if (override === null) return null; // null wins
  if (Array.isArray(base) && Array.isArray(override)) {
    if (arrayStrategy === 'replace') return override;
    if (arrayStrategy === 'concat') return [...base, ...override];
    // mergeIndex: union per-index
    const len = Math.max(base.length, override.length);
    if (len > 1024) throw new ConfigError([{ path: '<array>', from: 'merge', message: 'E_ARRAY_CAP: >1024' }], 'E_ARRAY_CAP');
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      if (i in override) {
        out[i] = i in base ? deepMerge(base[i], override[i], arrayStrategy) : override[i];
      } else if (i in base) {
        out[i] = base[i];
      }
      // else: hole in both — detected below
    }
    for (let i = 0; i < len; i++) {
      if (!(i in out)) {
        throw new ConfigError(
          [{ path: `<array>[${i}]`, from: 'merge', message: 'E_SPARSE_ARRAY: hole at index ' + i }],
          'E_SPARSE_ARRAY',
        );
      }
    }
    return out;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (FORBIDDEN.has(k)) throw new ConfigError([{ path: k, from: 'merge', message: 'E_PROTO' }], 'E_PROTO');
      out[k] = k in out ? deepMerge(out[k], v, arrayStrategy) : v;
    }
    return out;
  }
  return override;
}

/** Canonical index test: `0` or non-zero-padded positives (`01` is a name, not an index). */
export { INDEX_RE };
