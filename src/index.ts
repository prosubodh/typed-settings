/**
 * Typed config in one call.
 *
 * `settings()` / `settingsAsync()` load env, `.env` files, YAML/TOML/JSON,
 * secrets-dir maps, and vault secrets, then merge, expand `$VAR` references,
 * coerce, validate against a Standard Schema, and return the result frozen.
 * Anything invalid throws `ConfigError` at boot with the key and source attached.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Flat, SettingsOptions, SourceInput } from './types.js';
import { ConfigError, redactValue, byteLengthUtf8 } from './errors.js';
import { parseEnvText } from './formats/env.js';
import { parseJsonText } from './formats/json.js';
import { parseYamlText } from './formats/yaml.js';
import { parseTomlText } from './formats/toml.js';
import { expandValue } from './expand.js';
import { coerceDeep } from './coerce.js';
import { deepMerge, expandKeys, isPlainObject, normalizeIndexedObjects } from './merge.js';
import { validateStandard } from './adapter.js';

export { ConfigError } from './errors.js';
export type { Flat, SettingsOptions, SourceInput, SecretProvider, ArrayStrategy, UnknownKeys } from './types.js';

function getEnvSnapshot(injected?: Flat): Flat {
  if (injected) return injected;
  const g = globalThis as { process?: { env?: Flat } };
  if (g.process?.env) return { ...(g.process.env as Flat) };
  return {};
}

function isSecretKey(key: string): boolean {
  return /key|secret|token|password|private/i.test(key);
}

/**
 * Runs `fn` with `process.env` patched by `map` (`undefined` deletes a key),
 * then restores the exact previous environment — synchronously for sync `fn`,
 * held until settle for async `fn`. Restores on throw too.
 */
export function withOverrides<T>(map: Flat, fn: () => T): T {
  const g = globalThis as { process?: { env?: Flat } };
  const prev = g.process?.env ? { ...g.process.env } : undefined;
  const restore = () => {
    if (g.process?.env && prev) {
      for (const k of Object.keys(g.process.env)) delete (g.process.env as Record<string, string | undefined>)[k];
      Object.assign(g.process.env, prev);
    }
  };
  if (g.process?.env) {
    for (const [k, v] of Object.entries(map)) {
      if (v === undefined) delete (g.process.env as Record<string, string | undefined>)[k];
      else (g.process.env as Record<string, string>)[k] = v;
    }
  }
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  // If fn is async, hold the override until it settles — restoring eagerly
  // would pull the env out from under pending continuations.
  if (isThenable(out)) return (out as Promise<unknown>).finally(restore) as T;
  restore();
  return out;
}

/**
 * Copies only the listed, actually-present keys. A missing key yields no entry
 * (not `{ k: undefined }`), and nothing is spread, so secrets can't leak through.
 */
export function pickPublic<T extends object>(cfg: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  // Only copy keys actually present — no `undefined` placeholders, no spread.
  for (const k of keys) if (k in (cfg as object)) out[k] = cfg[k];
  return out;
}

/**
 * Map-only settings for Vite-style `import.meta.env` objects: validates the
 * map with no filesystem and no ambient env. (The framework entry's overload
 * drops `sources`/`env` from the options.)
 */
export function viteSettings<S extends StandardSchemaV1>(
  opts: SettingsOptions<S>,
  metaEnv: Flat,
): StandardSchemaV1.InferOutput<S> {
  return settings({ ...opts, sources: [{ map: metaEnv }], env: {} });
}

function readFileSyncSafe(path: string, maxBytes = 2 * 1024 * 1024): string | undefined {
  const getFs = (): { readFileSync(p: string, e: string): string } | null => {
    const injected = (globalThis as unknown as { __typedSettingsFs?: { readFileSync(p: string, e: string): string } }).__typedSettingsFs;
    if (injected) return injected;
    const g = globalThis as { process?: unknown };
    if (g.process) {
      const fn = new Function('return typeof require !== "undefined" ? require("node:fs") : null')() as {
        readFileSync(p: string, e: string): string;
      } | null;
      if (!fn) {
        // ESM without `typed-settings/node` imported: file sources cannot be read.
        // Fail loudly (never silently skip) so Edge/ESM misconfiguration surfaces at boot.
        throw new ConfigError(
          [{ path, from: path, message: 'E_NO_FS: file sources need `typed-settings/node` under ESM (or pass { text }/{ map })' }],
          'E_NO_FS',
        );
      }
      return fn;
    }
    return null;
  };
  try {
    const fs = getFs();
    if (!fs) return undefined;
    const text = fs.readFileSync(path, 'utf8');
    if (byteLengthUtf8(text) > maxBytes) {
      throw new ConfigError(
        [{ path, from: path, message: `E_FILE_TOO_LARGE: >${maxBytes} bytes` }],
        'E_FILE_TOO_LARGE',
      );
    }
    return text;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const err = e as NodeJS.ErrnoException & Error;
    // Missing file -> skip; EACCES and others rethrow (never swallow EACCES).
    // (No ParseError/E_ prefix check needed: parsing happens outside this
    // function, so only filesystem errors can land here.)
    if (err?.code === 'ENOENT') return undefined;
    throw e;
  }
}

function parseStructuredFile(path: string, text: string): unknown {
  const lower = path.toLowerCase();
  try {
    if (lower.endsWith('.json')) return parseJsonText(text, path);
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return parseYamlText(text, path);
    // Callers only route json/yaml/toml extensions here; anything else is TOML.
    return parseTomlText(text, path);
  } catch (e) {
    const err = e as Error;
    throw new ConfigError([{ path, from: path, message: err.message }], 'E_PARSE');
  }
}

interface Layer {
  node: Record<string, unknown> | unknown[];
  label: string;
  /** Vault/secrets layers skip `$VAR` expansion unless `expandSecrets:true`. */
  skipExpand: boolean;
}

function stripFlatKey(key: string, effPrefix: string | undefined): string | null {
  if (!effPrefix) return key;
  if (key.length <= effPrefix.length) return null;
  if (key.slice(0, effPrefix.length).toLowerCase() !== effPrefix.toLowerCase()) return null;
  // The length check above guarantees a non-empty remainder.
  return key.slice(effPrefix.length);
}

/** Reject cyclic in-memory values (maps/providers) before recursive passes run. */
function assertAcyclic(value: unknown, label: string): void {
  const visiting = new Set<object>();
  const visit = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object') return;
    if (visiting.has(v)) {
      throw new ConfigError(
        [{ path, from: label, message: `E_CYCLE: cyclic value at ${path} (from ${label})` }],
        'E_CYCLE',
      );
    }
    visiting.add(v);
    try {
      for (const [k, child] of Object.entries(v)) visit(child, path ? `${path}.${k}` : k);
    } finally {
      visiting.delete(v); // shared (DAG) references are fine — only true cycles throw
    }
  };
  visit(value, '');
}

/** Flat record -> nested layer: prefix-strip, `__`-expand, index-fold. */
function flatToLayer(
  m: Record<string, unknown>,
  label: string,
  srcPrefix: string | undefined,
  globalPrefix: string | undefined,
  opts: SettingsOptions<StandardSchemaV1>,
  skipExpand: boolean,
): Layer {
  assertAcyclic(m, label);
  const effPrefix = srcPrefix ?? globalPrefix;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    // Prefix is matched against the raw key; surviving keys are lowercased by expandKeys.
    // A per-source prefix replaces (not composes with) the global prefix.
    const s = stripFlatKey(k, effPrefix);
    if (s === null) continue;
    stripped[s] = v;
  }
  const node = normalizeIndexedObjects(
    expandKeys(stripped, { prefix: undefined, envMap: opts.envMap }),
  ) as Record<string, unknown>;
  return { node, label, skipExpand };
}

/** Structured file value -> layer: native nesting (no `__` split), top-level prefix strip. */
function structuredToLayer(
  value: unknown,
  label: string,
  prefix: string | undefined,
): Layer {
  // YAML anchors/aliases can build true cycles (JSON.parse cannot) — fail closed
  // before any recursive pass runs. Shared (DAG) references stay legal.
  assertAcyclic(value, label);
  if (!isPlainObject(value)) return { node: (value ?? {}) as Record<string, unknown>, label, skipExpand: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) {
      throw new ConfigError([{ path: k, from: label, message: 'E_PROTO: forbidden key' }], 'E_PROTO');
    }
    if (prefix) {
      const s = stripFlatKey(k, prefix);
      if (s === null) continue;
      out[s] = v;
    } else {
      out[k] = v;
    }
  }
  return { node: out, label, skipExpand: false };
}

function recordLayerFrom(fromMap: Map<string, string>, layer: Layer): void {
  const node = layer.node as Record<string, unknown>;
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const k of Object.keys(node)) fromMap.set(k.toLowerCase(), layer.label);
  }
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';
}

function asProvider(src: object): { load(): unknown; name: string } | null {
  if (!('provider' in src || 'load' in src)) return null;
  const prov = ('provider' in src ? (src as { provider: unknown }).provider : src) as { load?: unknown; name?: unknown };
  // A plain config map may legitimately contain a `load` key — only treat it as a
  // provider when `load` is actually callable.
  if (!prov || typeof prov.load !== 'function') return null;
  return { load: prov.load as () => unknown, name: typeof prov.name === 'string' ? prov.name : '<provider>' };
}

function timeoutError(name: string): ConfigError {
  return new ConfigError([{ path: name, from: name, message: 'E_TIMEOUT: provider load timed out' }], 'E_TIMEOUT');
}

function collectSources(opts: SettingsOptions<StandardSchemaV1>, envSnapshot: Flat): { layers: Layer[]; fromMap: Map<string, string> } {
  const sources = opts.sources ?? ['.env', 'env'];
  const prefix = opts.prefix;
  const layers: Layer[] = [];
  const fromMap = new Map<string, string>();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

  const push = (layer: Layer) => {
    layers.push(layer);
    recordLayerFrom(fromMap, layer);
  };
  const parseEnv = (text: string, label: string): Record<string, unknown> => {
    try {
      return parseEnvText(text) as Record<string, unknown>;
    } catch (e) {
      const err = e as Error;
      throw new ConfigError([{ path: label, from: label, message: err.message }], 'E_PARSE');
    }
  };

  // Precedence is listed order: later sources deep-merge over earlier ones.
  // Default ['.env','env'] gives env highest — correct.
  for (const src of sources) {
    if (src === 'env') {
      push(flatToLayer({ ...envSnapshot } as Record<string, unknown>, 'env', undefined, prefix, opts, false));
    } else if (src === '.env' || src === '.env.local') {
      const text = readFileSyncSafe(src, maxBytes);
      if (text === undefined) continue; // missing file -> skip
      push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
    } else if (typeof src === 'string') {
      const text = readFileSyncSafe(src, maxBytes);
      if (text === undefined) continue;
      const lower = src.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(src, text), src, prefix));
      } else {
        push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'text' in src) {
      push(flatToLayer(parseEnv((src as { text: string }).text, 'text'), 'text', undefined, prefix, opts, false));
    } else if (src && typeof src === 'object' && 'map' in src) {
      const m = src as { map: Flat; prefix?: string };
      push(flatToLayer((m.map ?? {}) as Record<string, unknown>, 'overrides', m.prefix, prefix, opts, false));
    } else if (src && typeof src === 'object' && 'file' in src) {
      const p = (src as { file: string }).file;
      const text = readFileSyncSafe(p, maxBytes);
      if (text === undefined) continue;
      const lower = p.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(p, text), p, prefix));
      } else {
        push(flatToLayer(parseEnv(text, p), p, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'dir' in src) {
      // secrets-dir is resolved by `loadSecretsDir()` (typed-settings/node) and passed
      // back in as `{ map }` — core never touches the filesystem for directories.
      continue;
    } else if (src && typeof src === 'object') {
      const prov = asProvider(src);
      if (prov) {
        const srcPrefix = 'prefix' in src ? (src as { prefix?: string }).prefix : undefined;
        const loaded = prov.load();
        if (isThenable(loaded)) {
          throw new ConfigError(
            [{ path: '<provider>', from: prov.name, message: 'USE_ASYNC: provider is async, use settingsAsync()' }],
            'USE_ASYNC',
          );
        }
        push(flatToLayer((loaded ?? {}) as Record<string, unknown>, prov.name, srcPrefix, prefix, opts, !opts.expandSecrets));
      } else {
        push(flatToLayer(src as Record<string, unknown>, 'overrides', undefined, prefix, opts, false));
      }
    }
  }

  return { layers, fromMap };
}

async function collectSourcesAsync(
  opts: SettingsOptions<StandardSchemaV1>,
  envSnapshot: Flat,
): Promise<{ layers: Layer[]; fromMap: Map<string, string> }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const needsAsync = (opts.sources ?? []).some((s) => s && typeof s === 'object' && asProvider(s) !== null);
  if (!needsAsync) return collectSources(opts, envSnapshot);
  // Guaranteed defined: needsAsync=true implies opts.sources is set.
  const sources = opts.sources!;
  const prefix = opts.prefix;
  const layers: Layer[] = [];
  const fromMap = new Map<string, string>();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const push = (layer: Layer) => {
    layers.push(layer);
    recordLayerFrom(fromMap, layer);
  };
  const parseEnv = (text: string, label: string): Record<string, unknown> => {
    try {
      return parseEnvText(text) as Record<string, unknown>;
    } catch (e) {
      const err = e as Error;
      throw new ConfigError([{ path: label, from: label, message: err.message }], 'E_PARSE');
    }
  };
  const withTimeout = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    // Assigned synchronously by the executor below, so the timer is always live here.
    let t!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(timeoutError(name)), timeoutMs);
    });
    const winner = await Promise.race([Promise.resolve().then(fn), timeout]).catch((e: unknown) => {
      clearTimeout(t);
      if (e instanceof ConfigError) throw e;
      const err = e as Error;
      throw new ConfigError(
        [{ path: name, from: name, message: `E_PROVIDER: ${err?.message ?? String(e)}` }],
        'E_PROVIDER',
      );
    });
    clearTimeout(t);
    return winner;
  };
  for (const src of sources) {
    if (src === 'env') {
      push(flatToLayer({ ...envSnapshot } as Record<string, unknown>, 'env', undefined, prefix, opts, false));
    } else if (src === '.env' || src === '.env.local') {
      const text = readFileSyncSafe(src, maxBytes);
      if (text === undefined) continue;
      push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
    } else if (typeof src === 'string') {
      const text = readFileSyncSafe(src, maxBytes);
      if (text === undefined) continue;
      const lower = src.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(src, text), src, prefix));
      } else {
        push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'text' in src) {
      push(flatToLayer(parseEnv((src as { text: string }).text, 'text'), 'text', undefined, prefix, opts, false));
    } else if (src && typeof src === 'object' && 'map' in src) {
      const m = src as { map: Flat; prefix?: string };
      push(flatToLayer((m.map ?? {}) as Record<string, unknown>, 'overrides', m.prefix, prefix, opts, false));
    } else if (src && typeof src === 'object' && 'file' in src) {
      const p = (src as { file: string }).file;
      const text = readFileSyncSafe(p, maxBytes);
      if (text === undefined) continue;
      const lower = p.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(p, text), p, prefix));
      } else {
        push(flatToLayer(parseEnv(text, p), p, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'dir' in src) {
      continue;
    } else if (src && typeof src === 'object') {
      const prov = asProvider(src);
      if (prov) {
        const srcPrefix = 'prefix' in src ? (src as { prefix?: string }).prefix : undefined;
        const loaded = (await withTimeout(prov.name, () => prov.load())) as Record<string, unknown>;
        push(flatToLayer(loaded ?? {}, prov.name, srcPrefix, prefix, opts, !opts.expandSecrets));
      } else {
        push(flatToLayer(src as Record<string, unknown>, 'overrides', undefined, prefix, opts, false));
      }
    }
  }
  return { layers, fromMap };
}

function buildConfigObject(
  opts: SettingsOptions<StandardSchemaV1>,
  envSnapshot: Flat,
): { input: unknown; fromFor: (path: string) => string } {
  const { layers, fromMap } = collectSources(opts, envSnapshot);
  const arrayStrategy = opts.arrayStrategy ?? 'replace';

  // Ordered deep-merge: later sources win per leaf, across flat and file layers alike.
  let merged: unknown = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.node, arrayStrategy);
  }
  const skipTops = new Set(
    layers.filter((l) => l.skipExpand).flatMap((l) => Object.keys(l.node as object)).map((k) => k.toLowerCase()),
  );

  // Variable expansion post-merge (string scalars only), with cycle detection.
  if (opts.expand !== false) {
    merged = expandDeepStrings(merged, makeLookup(merged, envSnapshot), {
      allowUnresolved: opts.allowUnresolved,
      fromMap,
      skipTops,
    });
  }

  // Coercion (best-effort leaf coerce; the schema has final authority).
  if (opts.coerce !== false) {
    merged = coerceDeep(merged);
  }

  const fromFor = (path: string): string => {
    const top = path.split('.')[0]!.toLowerCase();
    if (top === '<root>') return 'schema';
    return fromMap.get(top) ?? 'defaults';
  };
  return { input: merged, fromFor };
}

interface ExpandCtx {
  allowUnresolved?: boolean;
  fromMap: Map<string, string>;
  skipTops: Set<string>;
}

/** Shared post-merge lookup: merged config first, then the raw env snapshot. */
function makeLookup(merged: unknown, envSnapshot: Flat): (name: string) => string | undefined {
  const rec = merged && typeof merged === 'object' && !Array.isArray(merged) ? (merged as Record<string, unknown>) : {};
  const ciKeys = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]));
  return (name: string): string | undefined => {
    const hit = ciKeys.get(name.toLowerCase());
    if (hit !== undefined) {
      const direct = rec[hit];
      if (typeof direct === 'string') return direct;
      if (direct !== undefined && direct !== null) return String(direct);
    }
    return envSnapshot[name] ?? envSnapshot[name.toUpperCase()] ?? envSnapshot[name.toLowerCase()];
  };
}

/**
 * Expand `$VAR` references in every string leaf, resolving chains recursively.
 * A reference that (transitively) resolves back to a name already on the
 * resolution stack is a cycle -> E_CIRCULAR. Results are never re-scanned,
 * so `$$` escapes and literal `$` text survive verbatim.
 */
function expandDeepStrings(
  obj: unknown,
  lookup: (n: string) => string | undefined,
  ctx: ExpandCtx,
  path: string[] = [],
): unknown {
  if (typeof obj === 'string') {
    const top = (path[0] ?? '<root>').toLowerCase();
    return expandLeaf(obj, lookup, { ...ctx, from: ctx.fromMap.get(top) ?? 'config' }, path.map((p) => p.toLowerCase()));
  }
  if (Array.isArray(obj)) return obj.map((x, i) => expandDeepStrings(x, lookup, ctx, [...path, String(i)]));
  if (obj && typeof obj === 'object') {
    // Vault/secrets subtrees are skipped unless expandSecrets:true (decided per top-level key).
    if (path.length === 0) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        o[k] = ctx.skipTops.has(k.toLowerCase()) ? v : expandDeepStrings(v, lookup, ctx, [k]);
      }
      return o;
    }
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) o[k] = expandDeepStrings(v, lookup, ctx, [...path, k]);
    return o;
  }
  return obj;
}

function expandLeaf(
  value: string,
  lookup: (n: string) => string | undefined,
  ctx: ExpandCtx & { from: string },
  stack: string[],
): string {
  return expandValue(
    value,
    (name: string) => {
      const lower = name.toLowerCase();
      if (stack.includes(lower)) {
        throw new ConfigError(
          [{ path: name, from: ctx.from, message: `E_CIRCULAR: $${[...stack, name].join('->$')}` }],
          'E_CIRCULAR',
        );
      }
      const raw = lookup(name);
      if (raw === undefined) return undefined;
      // Resolve chains (A=${B}, B=hi); the substituted result is inserted verbatim.
      if (raw.includes('$')) return expandLeaf(raw, lookup, ctx, [...stack, lower]);
      return raw;
    },
    { allowUnresolved: ctx.allowUnresolved, from: ctx.from },
  );
}

function collectLeafPaths(v: unknown, prefix = ''): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    v.forEach((x, i) => out.push(...collectLeafPaths(x, prefix ? `${prefix}.${i}` : `${i}`)));
    return out;
  }
  if (isPlainObject(v)) {
    const out: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k.toLowerCase()}` : k.toLowerCase();
      if (isPlainObject(val) || Array.isArray(val)) out.push(...collectLeafPaths(val, p));
      else out.push(p);
    }
    return out;
  }
  return prefix ? [prefix.toLowerCase()] : [];
}

function applyUnknownKeys(input: unknown, value: unknown, mode: 'strip' | 'preserve' | 'reject'): unknown {
  if (mode === 'strip' || mode === undefined) return value;
  if (mode === 'preserve') {
    if (isPlainObject(input) && isPlainObject(value)) return deepMerge(input, value, 'replace');
    return value;
  }
  // reject
  const inputPaths = new Set(collectLeafPaths(input));
  const valuePaths = new Set(collectLeafPaths(value));
  const unknown: string[] = [...inputPaths].filter((p) => !valuePaths.has(p));
  if (unknown.length > 0) {
    throw new ConfigError(
      unknown.map((p) => ({ path: p, from: 'schema', message: 'E_UNKNOWN_KEY: unknown key (unknownKeys=reject)' })),
      'E_UNKNOWN_KEY',
    );
  }
  return value;
}

function freezeDeep<T>(v: T): T {
  if (Array.isArray(v)) {
    for (const x of v) freezeDeep(x);
    return Object.freeze(v);
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) freezeDeep((v as Record<string, unknown>)[k]);
    return Object.freeze(v);
  }
  return v;
}

/**
 * Loads, merges, expands, coerces, and validates config synchronously, returning
 * the inferred output type, frozen. Throws `ConfigError` on invalid input (issues
 * carry `path` + winning-source `from`, secrets redacted) and `USE_ASYNC` when a
 * provider or the schema itself is async — then use `settingsAsync()`.
 */
export function settings<S extends StandardSchemaV1>(opts: SettingsOptions<S>): StandardSchemaV1.InferOutput<S> {
  const envSnapshot = getEnvSnapshot(opts.env);
  const { input, fromFor } = buildConfigObject(opts as SettingsOptions<StandardSchemaV1>, envSnapshot);
  const r = validateStandard(opts.schema, input);
  if ('promise' in r) {
    throw new ConfigError(
      [{ path: '<root>', from: 'schema', message: 'USE_ASYNC: schema is async, use settingsAsync()' }],
      'USE_ASYNC',
    );
  }
  if ('issues' in r) {
    throw new ConfigError(
      r.issues.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input) })),
    );
  }
  const value = (r as { value: unknown }).value;
  const final = applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip');
  void isSecretKey;
  return (opts.freeze === false ? final : freezeDeep(final)) as StandardSchemaV1.InferOutput<S>;
}

/**
 * Async twin of `settings()`: awaits async providers (whole collection races
 * `timeoutMs`) and async schemas, with the same merge/expand/coerce/validate/
 * freeze pipeline and the same `ConfigError` contract.
 */
export async function settingsAsync<S extends StandardSchemaV1>(
  opts: SettingsOptions<S>,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const envSnapshot = getEnvSnapshot(opts.env);
  // Async provider support: re-collect allowing async loads
  const { input, fromFor } = await buildConfigObjectAsync(opts as SettingsOptions<StandardSchemaV1>, envSnapshot);
  const r = validateStandard(opts.schema, input);
  if ('promise' in r) {
    const raced = await Promise.race([
      r.promise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new ConfigError([{ path: '<root>', from: 'schema', message: 'E_TIMEOUT' }], 'E_TIMEOUT')), timeoutMs)),
    ]);
    if (!raced.ok) {
      throw new ConfigError(raced.issues!.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input) })));
    }
    const value = raced.value;
    const final = applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip');
    return (opts.freeze === false ? final : freezeDeep(final)) as StandardSchemaV1.InferOutput<S>;
  }
  if ('issues' in r) {
    throw new ConfigError(r.issues.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input) })));
  }
  const value = (r as { value: unknown }).value;
  const final = applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip');
  return (opts.freeze === false ? final : freezeDeep(final)) as StandardSchemaV1.InferOutput<S>;
}

async function buildConfigObjectAsync(
  opts: SettingsOptions<StandardSchemaV1>,
  envSnapshot: Flat,
): Promise<{ input: unknown; fromFor: (path: string) => string }> {
  const { layers, fromMap } = await collectSourcesAsync(opts, envSnapshot);
  const arrayStrategy = opts.arrayStrategy ?? 'replace';
  let merged: unknown = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.node, arrayStrategy);
  }
  const skipTops = new Set(
    layers.filter((l) => l.skipExpand).flatMap((l) => Object.keys(l.node as object)).map((k) => k.toLowerCase()),
  );
  if (opts.expand !== false) {
    merged = expandDeepStrings(merged, makeLookup(merged, envSnapshot), {
      allowUnresolved: opts.allowUnresolved,
      fromMap,
      skipTops,
    });
  }
  if (opts.coerce !== false) merged = coerceDeep(merged);
  const fromFor = (path: string): string => {
    const top = path.split('.')[0]!.toLowerCase();
    if (top === '<root>') return 'schema';
    return fromMap.get(top) ?? 'defaults';
  };
  return { input: merged, fromFor };
}

function getLeafByPath(input: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = input;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const m = /\[(\d+)\]/.exec(part);
      const idx = m ? Number(m[1]) : Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = (cur as unknown[])[idx];
      continue;
    }
    const rec = cur as Record<string, unknown>;
    const found = Object.keys(rec).find((k) => k.toLowerCase() === part.toLowerCase());
    if (!found) return undefined;
    cur = rec[found];
  }
  return cur;
}

function base64Of(s: string): string | null {
  try {
    const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
    if (g.btoa) return g.btoa(s);
    if (g.Buffer) return g.Buffer.from(s, 'utf8').toString('base64');
  } catch {
    // ignore — redaction still applies to the raw value
  }
  return null;
}

function maskIfSecret(path: string, message: string, input: unknown): string {
  if (!isSecretKey(path)) return message;
  let out = message;
  // Value-equality redaction: strip the raw (and base64) secret from the message itself,
  // e.g. custom refinements that echo the received value.
  const leaf = getLeafByPath(input, path);
  if (typeof leaf === 'string' && leaf.length > 0) {
    const redacted = redactValue(path, leaf);
    out = out.split(leaf).join(redacted);
    const b64 = base64Of(leaf);
    if (b64 && b64.length > 8) out = out.split(b64).join(redacted);
  }
  return `${out} (redacted)`;
}
