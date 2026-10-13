import type { ArrayStrategy } from './types.js';
import { ConfigError } from './errors.js';

const INDEX_RE = /^(0|[1-9][0-9]*)$/;

/** The only key that can hijack an assignment (`o[k] = v` hits the prototype
 * setter): exact `__proto__`, case-insensitive. `constructor`/`prototype` are
 * inert own data properties and flow as ordinary keys. */
export function isProtoKey(key: string): boolean {
  return key.toLowerCase() === '__proto__';
}

/**
 * Strips `prefix` (case-insensitive, once) from a flat key. Returns the
 * remainder, or `null` when the key doesn't qualify (too short, no match, or
 * the prefix would cut mid-word: `APP` never strips `APPLE`, only `APP_FOO`).
 */
export function stripPrefix(key: string, prefix?: string): string | null {
  if (!prefix) return key;
  if (key.length <= prefix.length) return null;
  if (key.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  const rest = key.slice(prefix.length);
  // Segment boundary: a prefix ending in a word character only strips when the
  // remainder starts with a non-word character. (A prefix like `APP_` already
  // ends at a boundary, so it always qualifies.)
  if (/[A-Za-z0-9]$/.test(prefix) && /^[A-Za-z0-9]/.test(rest)) return null;
  return rest;
}

/**
 * Expands flat `UPPER__NESTED` keys into nested objects. Only `__` splits;
 * keys lowercase; `envMap` entries stay literal. Throws `E_PROTO` on
 * `__proto__` (the only assignment-hijacking key), `E_BAD_KEY` on keys outside
 * `[A-Za-z0-9_]` (envMap rescues first), `E_ARRAY_MIX` on indexed-vs-named
 * mixing under one parent, and `E_COLLISION` when two keys claim one path or
 * a scalar blocks a subtree. Keys whose `__` separators don't split into
 * all-non-empty segments (e.g. Next.js's `__NEXT_*`) are kept as literal
 * top-level keys instead of throwing.
 */
export function expandKeys(
  flat: Record<string, unknown>,
  opts?: { separator?: '__'; prefix?: string; envMap?: Record<string, string>; tolerantKeys?: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Mixing detection per parent node (dotted path, '' for top level).
  const nodeKinds = new Map<string, { indexed: boolean; named: boolean }>();
  const kindOf = (parent: string) => {
    let k = nodeKinds.get(parent);
    if (!k) {
      k = { indexed: false, named: false };
      nodeKinds.set(parent, k);
    }
    return k;
  };
  // Full dotted paths already claimed, mapped to the raw key that claimed them.
  const claimed = new Map<string, string>();
  const lookupEnvMap = (rawKey: string): string | undefined => {
    if (!opts?.envMap) return undefined;
    // Full case-fold on both sides: envMap keys match by meaning, so
    // `FoO__BaR` finds its entry regardless of capitalization style.
    const low = rawKey.toLowerCase();
    for (const [k, v] of Object.entries(opts.envMap)) {
      if (k.toLowerCase() === low) return v;
    }
    return undefined;
  };
  const collision = (rawKey: string, dotted: string, why: string): never => {
    throw new ConfigError(
      [{ path: rawKey, from: 'keys', message: `E_COLLISION: '${rawKey}' ${why} (already claimed by '${claimed.get(dotted)}')` }],
      'E_COLLISION',
    );
  };
  for (const [rawKey, value] of Object.entries(flat)) {
    // envMap rescues awkward keys first — even ones outside the key charset.
    const escaped = lookupEnvMap(rawKey);
    if (escaped !== undefined) {
      // Escaped keys are literal: they skip BOTH prefix-stripping and `__`
      // splitting (lowercased like everything else), last wins on collision.
      const k = escaped.toLowerCase();
      if (isProtoKey(k)) throw new ConfigError([{ path: rawKey, from: 'keys', message: 'E_PROTO: forbidden key' }], 'E_PROTO');
      out[k] = value;
      continue;
    }
    if (!/^[A-Za-z0-9_]+$/.test(rawKey)) {
      // Tolerant mode (ambient process.env only): that namespace is full of
      // unrelated OS vars (COMMONPROGRAMFILES(X86), JAVA_HOME\... no) — skip
      // rather than fail the whole config load. Authored sources are strict.
      if (opts?.tolerantKeys) continue;
      throw new ConfigError(
        [{ path: rawKey, from: 'keys', message: `E_BAD_KEY: '${rawKey}' cannot be a config key (allowed: A-Z a-z 0-9 _, nesting with __) — bridge it with envMap` }],
        'E_BAD_KEY',
      );
    }
    const stripped = stripPrefix(rawKey, opts?.prefix);
    if (stripped === null) continue;
    const useKey = stripped;
    // Whole-key E_PROTO check first: '__proto__' splits into empties that
    // would otherwise hide the real problem.
    if (isProtoKey(useKey)) throw new ConfigError([{ path: rawKey, from: 'keys', message: 'E_PROTO: forbidden key' }], 'E_PROTO');
    const parts = useKey.split('__');
    // A clean `__`-split can never contain a `__proto__` segment (parts would
    // have to contain `__` themselves), so the whole-key check above plus the
    // merge/setPath guards cover the fail-closed path; constructor/prototype
    // are inert own-data properties and flow as ordinary segments.
    const cleanSplit = parts.length > 1 && parts.every((p) => p !== '');
    if (cleanSplit) {
      const lowered = parts.map((p) => p.toLowerCase());
      const full = lowered.join('.');
      const parent = lowered.slice(0, -1).join('.');
      const top = lowered[0]!;
      const prev = claimed.get(full);
      if (prev !== undefined) collision(rawKey, full, 'duplicates a claimed path');
      // Legacy top-level rule (pinned): a scalar top + an indexed direct child
      // in one layer is E_ARRAY_MIX, not E_COLLISION. Deeper conflicts are
      // E_COLLISION.
      if (lowered.length === 2 && claimed.has(top) && INDEX_RE.test(lowered[1]!)) {
        throw new ConfigError(
          [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${top}' has both scalar/list and indexed (__0) values in the same layer` }],
          'E_ARRAY_MIX',
        );
      }
      // Collision scan: a subtree already grows here, an ancestor is claimed
      // (scalar blocks a subtree), or this leaf shadows an existing subtree.
      for (const [path] of claimed) {
        if (path.startsWith(`${full}.`) || full.startsWith(`${path}.`)) {
          collision(rawKey, path, 'collides with a conflicting value at');
        }
      }
      // Mixing is scoped per parent layer: indexed __0 and named siblings under
      // one parent error (sibling tops never interfere, A__0 + B__NAME is fine).
      const kind = kindOf(parent);
      const childIsIndex = INDEX_RE.test(lowered[lowered.length - 1]!);
      if (childIsIndex) {
        if (kind.named) {
          throw new ConfigError(
            [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${parent}' mixes indexed (__0) and named children in the same layer` }],
            'E_ARRAY_MIX',
          );
        }
        kind.indexed = true;
      } else {
        if (kind.indexed) {
          throw new ConfigError(
            [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${parent}' mixes named and indexed (__0) children in the same layer` }],
            'E_ARRAY_MIX',
          );
        }
        kind.named = true;
      }
      claimed.set(full, rawKey);
      setPath(out, lowered, value);
    } else {
      const k = useKey.toLowerCase();
      // Legacy top-level rule (pinned): indexed-then-scalar is E_ARRAY_MIX.
      if (nodeKinds.get(k)?.indexed) {
        throw new ConfigError(
          [{ path: rawKey, from: 'keys', message: `E_ARRAY_MIX: '${k}' has both indexed (__0) and scalar/list values in the same layer` }],
          'E_ARRAY_MIX',
        );
      }
      const prev = claimed.get(k);
      if (prev !== undefined) collision(rawKey, k, 'duplicates a claimed path');
      // Scalars may not shadow subtrees: k is always a single segment (no dots),
      // so only claimed paths living under k can conflict.
      for (const [path] of claimed) {
        if (path.startsWith(`${k}.`)) {
          collision(rawKey, path, 'collides with a conflicting value at');
        }
      }
      claimed.set(k, rawKey);
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
          [{ path, from: 'keys', message: `E_SPARSE_ARRAY: indexes [${idx.join(',')}] are not dense 0..${idx[idx.length - 1]}` }],
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
  // Single gate per merge call: the recursive worker below re-validates
  // nothing, so deep trees cost O(N) proto checks, not O(N·depth).
  assertNoProtoDeep(override);
  return deepMergeInner(base, override, arrayStrategy);
}

function deepMergeInner(base: unknown, override: unknown, arrayStrategy: ArrayStrategy): unknown {
  if (override === undefined) return base;
  if (base === undefined) {
    return override;
  }
  if (override === null) return null; // null wins
  // Object-vs-array across layers is a shape conflict, not an override: it
  // means one source said "map" and another said "list" for the same subtree.
  // Scalars still last-win (ordinary layering); only populated map/list flips
  // throw — an empty seed/base (`{}` first layer, `[]`) carries no shape.
  if (Array.isArray(base) !== Array.isArray(override) && (isPlainObject(base) || isPlainObject(override))) {
    const bare = (v: unknown) =>
      v != null && typeof v === 'object' && (Array.isArray(v) ? v.length === 0 : isPlainObject(v) && Object.keys(v).length === 0);
    if (!bare(base) && !bare(override)) {
      throw new ConfigError(
        [{ path: '<array>', from: 'merge', message: `E_ARRAY_MIX: cannot merge object with array across layers (arrayStrategy '${arrayStrategy}' only merges arrays with arrays) — use matching shapes` }],
        'E_ARRAY_MIX',
      );
    }
  }
  if (Array.isArray(base) && Array.isArray(override)) {
    if (arrayStrategy === 'replace') return override;
    if (arrayStrategy === 'concat') {
      if (base.length + override.length > 1024) {
        throw new ConfigError([{ path: '<array>', from: 'merge', message: 'E_ARRAY_CAP: concat would exceed 1024 elements' }], 'E_ARRAY_CAP');
      }
      return [...base, ...override];
    }
    // mergeIndex: union per-index
    const len = Math.max(base.length, override.length);
    if (len > 1024) throw new ConfigError([{ path: '<array>', from: 'merge', message: 'E_ARRAY_CAP: >1024' }], 'E_ARRAY_CAP');
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      if (i in override) {
        out[i] = i in base ? deepMergeInner(base[i], override[i], arrayStrategy) : override[i];
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
    // Override subtree already passed assertNoProtoDeep above, so no per-key
    // E_PROTO check is needed here (keeps a single fail-closed gate).
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? deepMergeInner(out[k], v, arrayStrategy) : v;
    }
    return out;
  }
  return override;
}

/** Recursively reject prototype keys (any object shape, any realm). */
function assertNoProtoDeep(value: unknown): void {
  if (Array.isArray(value)) {
    for (const x of value) assertNoProtoDeep(x);
    return;
  }
  // Any object — plain, class instance, or cross-realm: only own keys matter,
  // and a data property literally named `__proto__` must never flow into a
  // `out[k] = v` assignment (prototype setter, silent drop/pollution).
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isProtoKey(k)) throw new ConfigError([{ path: k, from: 'merge', message: 'E_PROTO' }], 'E_PROTO');
      assertNoProtoDeep(v);
    }
  }
}

/** Canonical index test: `0` or non-zero-padded positives (`01` is a name, not an index). */
export { INDEX_RE };
