/**
 * Typed config in one call.
 *
 * `settings()` / `settingsAsync()` load env, `.env` files, YAML/TOML/JSON,
 * secrets-dir maps, and vault secrets, then merge, expand `$VAR` references,
 * coerce, validate against a Standard Schema, and return the result frozen.
 * Anything invalid throws `ConfigError` at boot with the key and source attached.
 *
 * @module
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Flat, SettingsOptions, SourceInput } from './types.js';
import { ConfigError, redactValue, byteLengthUtf8, isSecretKey } from './errors.js';
import { parseEnvText } from './formats/env.js';
import { parseJsonText } from './formats/json.js';
import { parseYamlText } from './formats/yaml.js';
import { parseTomlText } from './formats/toml.js';
import { expandValue } from './expand.js';
import { coerceDeep } from './coerce.js';
import { deepMerge, expandKeys, isPlainObject, isProtoKey, normalizeIndexedObjects } from './merge.js';
import { validateStandard } from './adapter.js';

export { ConfigError, isSecretKey } from './errors.js';
export { validateStandard } from './adapter.js';
export type { Flat, SettingsOptions, SourceInput, SecretProvider, ArrayStrategy, UnknownKeys } from './types.js';

/** Depth cap for transitive `$VAR` chain resolution (DoS guard; cycles throw E_CIRCULAR first). */
const MAX_EXPAND_DEPTH = 50;

function getEnvSnapshot(injected?: Flat): Flat {
  if (injected) return { ...injected };
  const g = globalThis as { process?: { env?: Flat } };
  if (g.process?.env) return { ...(g.process.env as Flat) };
  return {};
}

/**
 * Runs `fn` with `process.env` patched by `map` (`undefined` deletes a key),
 * then restores the exact previous environment — synchronously for sync `fn`,
 * held until settle for async `fn`. Restores on throw too.
 *
 * NOTE: not safe for overlapping concurrent use — two in-flight `withOverrides`
 * calls interleave on the shared global. Serialize them, or pass `env:` instead.
 */
export function withOverrides<T>(map: Flat, fn: () => T): T {
  const g = globalThis as { process?: { env?: Flat } };
  const keys = Object.keys(map);
  // Per-key save: ambient keys created mid-override survive the restore, and
  // nested/overlapping overrides only touch their own keys.
  const had = new Set<string>();
  const prev = new Map<string, string | undefined>();
  const restore = () => {
    const env = g.process?.env;
    if (!env) return;
    for (const k of keys) {
      if (had.has(k)) (env as Record<string, string | undefined>)[k] = prev.get(k);
      else delete (env as Record<string, string | undefined>)[k];
    }
  };
  if (g.process?.env) {
    for (const k of keys) {
      if (k in g.process.env) {
        had.add(k);
        prev.set(k, g.process.env[k]);
      }
      const v = map[k];
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
  // would pull the env out from under pending continuations. Promise.resolve
  // assimilates foreign thenables (which may lack .finally) instead of calling
  // methods on them directly.
  if (isThenable(out)) return Promise.resolve(out as unknown).finally(restore) as T;
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
  // Use own-property check (not `in`) and refuse prototype keys so secrets
  // can't leak through and `__proto__` can't pollute the result.
  for (const k of keys) {
    const ks = String(k);
    if (ks === '__proto__' || ks === 'constructor' || ks === 'prototype') continue;
    if (Object.hasOwn(cfg as object, k)) out[k] = cfg[k];
  }
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

type FsHook = {
  readFileSync(p: string, e: string): string;
  statSync?(p: string): { size: number };
};

function readFileSyncSafe(
  path: string,
  maxBytes = 2 * 1024 * 1024,
  injectedFs?: FsHook,
): string | undefined {
  const getFs = (): FsHook | null => {
    if (injectedFs) return injectedFs;
    const injected = (globalThis as unknown as { __typedSettingsFs?: FsHook }).__typedSettingsFs;
    if (injected) return injected;
    const g = globalThis as { process?: unknown };
    if (g.process) {
      let fn: { readFileSync(p: string, e: string): string } | null;
      try {
        fn = new Function('return typeof require !== "undefined" ? require("node:fs") : null')() as {
          readFileSync(p: string, e: string): string;
        } | null;
        /* v8 ignore next 5 -- CSP no-unsafe-eval runtimes only; untestable under vitest/node */
      } catch {
        // CSP-locked runtimes (no unsafe-eval) cannot probe require — treat as
        // no-filesystem rather than leaking an EvalError.
        fn = null;
      }
      if (!fn) {
        // ESM without `typed-settings/node` imported: file sources cannot be read.
        // Fail loudly (never silently skip) so Edge/ESM misconfiguration surfaces at boot.
        // Prefer `opts.fs` or `import 'typed-settings/node'` (which installs the hook).
        // NOTE: path is '<root>' (not the filename): `path` is a config key path
        // everywhere; the filename travels in `from` and the message.
        throw new ConfigError(
          [{ path: '<root>', from: path, message: `E_NO_FS: cannot read '${path}' under ESM — import 'typed-settings/node', pass opts.fs, or use { text }/{ map }` }],
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
    // Pre-read size gate: avoids materializing a huge file just to reject it.
    // Falls back to the post-read byte check when no statSync is available.
    if (fs.statSync) {
      try {
        if (fs.statSync(path).size > maxBytes) {
          throw new ConfigError(
            [{ path: '<root>', from: path, message: `E_FILE_TOO_LARGE: '${path}' >${maxBytes} bytes — raise maxBytes or shrink the file` }],
            'E_FILE_TOO_LARGE',
          );
        }
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        // stat miss (ENOENT etc.) -> let readFileSync decide (skip vs throw).
      }
    }
    const text = fs.readFileSync(path, 'utf8');
    if (byteLengthUtf8(text) > maxBytes) {
      throw new ConfigError(
        [{ path: '<root>', from: path, message: `E_FILE_TOO_LARGE: '${path}' >${maxBytes} bytes — raise maxBytes or shrink the file` }],
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

/** Rejects nonsensical numeric options before any I/O runs. */
function validateOptions(opts: SettingsOptions<StandardSchemaV1>): void {
  if (opts.maxBytes !== undefined && (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0)) {
    throw new ConfigError(
      [{ path: 'maxBytes', from: 'options', message: 'E_USAGE: maxBytes must be a positive finite number' }],
      'E_USAGE',
    );
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new ConfigError(
      [{ path: 'timeoutMs', from: 'options', message: 'E_USAGE: timeoutMs must be a positive finite number' }],
      'E_USAGE',
    );
  }
}

/** Maps stack exhaustion from hostile nesting depth to a ConfigError. */
function depthGuarded<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    // Only genuine stack exhaustion maps to E_DEPTH: a RangeError raised for
    // domain reasons (validator throwing `new RangeError('port out of range')`)
    // keeps its message and type instead of being misattributed.
    if (e instanceof RangeError && /call stack|recursion|too much/i.test((e as Error).message)) {
      throw new ConfigError(
        [{ path: '<root>', from: label, message: 'E_DEPTH: nesting too deep (possible hostile input)' }],
        'E_DEPTH',
      );
    }
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
    // path is '<root>': the filename travels in `from` and the message.
    throw new ConfigError([{ path: '<root>', from: path, message: err.message }], 'E_PARSE');
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
  const rest = key.slice(effPrefix.length);
  // Same segment-boundary rule as stripPrefix: no mid-word cuts.
  if (/[A-Za-z0-9]$/.test(effPrefix) && /^[A-Za-z0-9]/.test(rest)) return null;
  return rest;
}

/** Reject cyclic in-memory values (maps/providers) before recursive passes run. */
function assertAcyclic(value: unknown, label: string): void {
  const visiting = new Set<object>();
  const visit = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object') return;
    if (visiting.has(v)) {
      // `path` is never '' here (the root call always has ≥1 key before any
      // revisit), so no '<root>' fallback games — the dotted path is exact.
      throw new ConfigError(
        [{ path, from: label, message: `E_CIRCULAR: cyclic value at '${path}' — remove the self-reference (shared DAG refs are fine, true cycles are not)` }],
        'E_CIRCULAR',
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
  tolerantKeys = false,
): Layer {
  assertAcyclic(m, label);
  const effPrefix = srcPrefix ?? globalPrefix;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    // Prefix is matched against the raw key; surviving keys are lowercased by expandKeys.
    // A per-source prefix replaces (not composes with) the global prefix.
    const s = stripFlatKey(k, effPrefix);
    if (s === null) continue;
    // Fail closed on the assignment-hijacking key: `stripped['__proto__']=v`
    // would not create an own property (setter semantics) and would silently
    // vanish instead of throwing E_PROTO downstream.
    if (isProtoKey(s)) {
      throw new ConfigError([{ path: k, from: label, message: 'E_PROTO: forbidden key' }], 'E_PROTO');
    }
    stripped[s] = v;
  }
  const node = normalizeIndexedObjects(
    expandKeys(stripped, { prefix: undefined, envMap: opts.envMap, tolerantKeys }),
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
  // Nested `__proto__` anywhere in a structured file must fail closed
  // (deep check covers top level too).
  assertNoProtoDeep(value, label);
  if (!isPlainObject(value)) return { node: (value ?? {}) as Record<string, unknown>, label, skipExpand: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (prefix) {
      const s = stripFlatKey(k, prefix);
      if (s === null) continue;
      // Same fail-closed rule as the flat path: the stripped remainder lands in
      // a bare assignment, so `{"APP__proto__":…}` + prefix APP must throw here,
      // not vanish into the prototype setter.
      if (isProtoKey(s)) {
        throw new ConfigError([{ path: k, from: label, message: 'E_PROTO: forbidden key' }], 'E_PROTO');
      }
      out[s] = v;
    } else {
      out[k] = v;
    }
  }
  // Parity with the flat path: all-index objects fold to arrays, with the same
  // dense/1024 rules (and the same E_SPARSE_ARRAY/E_ARRAY_CAP failures).
  return { node: normalizeIndexedObjects(out, label) as Record<string, unknown>, label, skipExpand: false };
}

/** Recursively reject prototype-hijacking keys (case-insensitive, any depth). */
function assertNoProtoDeep(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const x of value) assertNoProtoDeep(x, label);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isProtoKey(k)) {
        throw new ConfigError([{ path: k, from: label, message: 'E_PROTO: forbidden key' }], 'E_PROTO');
      }
      assertNoProtoDeep(v, label);
    }
  }
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

function timeoutError(name: string, budgetMs: number): ConfigError {
  return new ConfigError(
    [{ path: '<root>', from: name, message: `E_TIMEOUT: provider '${name}' load outran timeoutMs (${budgetMs}ms) — raise timeoutMs or fix the backend` }],
    'E_TIMEOUT',
  );
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
      throw new ConfigError([{ path: '<root>', from: label, message: err.message }], 'E_PARSE');
    }
  };

  // Precedence is listed order: later sources deep-merge over earlier ones.
  // Default ['.env','env'] gives env highest — correct.
  for (const src of sources) {
    if (src === 'env') {
      push(flatToLayer({ ...envSnapshot } as Record<string, unknown>, 'env', undefined, prefix, opts, false, true));
    } else if (src === '.env' || src === '.env.local') {
      const text = readFileSyncSafe(src, maxBytes, opts.fs);
      if (text === undefined) continue; // missing file -> skip
      push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
    } else if (typeof src === 'string') {
      const text = readFileSyncSafe(src, maxBytes, opts.fs);
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
      const text = readFileSyncSafe(p, maxBytes, opts.fs);
      if (text === undefined) continue;
      const lower = p.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(p, text), p, prefix));
      } else {
        push(flatToLayer(parseEnv(text, p), p, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'dir' in src) {
      // Core never touches directories: resolve them with loadSecretsDir()
      // from `typed-settings/node` and pass the result back as `{ map }`.
      // Loud, not silent — an unread secrets dir must never look like defaults.
      throw new ConfigError(
        [{ path: (src as { dir: string }).dir, from: 'config', message: 'E_USAGE: { dir } sources need loadSecretsDir() from typed-settings/node, passed back as { map }' }],
        'E_USAGE',
      );
    } else if (src && typeof src === 'object') {
      const prov = asProvider(src);
      if (prov) {
        const srcPrefix = 'prefix' in src ? (src as { prefix?: string }).prefix : undefined;
        let loaded: unknown;
        try {
          loaded = prov.load();
        } catch (e) {
          // A foreign copy's ConfigError (dual ESM/CJS) still matches via
          // Symbol.hasInstance — keep its code instead of wrapping as E_PROVIDER.
          if (e instanceof ConfigError) throw e;
          const err = e as Error;
          // Parity with async path: provider throws become E_PROVIDER, never raw.
          throw new ConfigError(
            [{ path: prov.name, from: prov.name, message: `E_PROVIDER: ${err?.message ?? String(e)}` }],
            'E_PROVIDER',
          );
        }
        if (isThenable(loaded)) {
          throw new ConfigError(
            [{ path: '<root>', from: prov.name, message: `USE_ASYNC: provider '${prov.name}' is async — switch to settingsAsync()` }],
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
  const deadline = Date.now() + timeoutMs;
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
      throw new ConfigError([{ path: '<root>', from: label, message: err.message }], 'E_PARSE');
    }
  };
  const withTimeout = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    // Shared deadline: the whole async collection races `timeoutMs`, so N slow
    // providers fail in ~timeoutMs total, not N*timeoutMs.
    const remaining = Math.max(1, deadline - Date.now());
    // Assigned synchronously by the executor below, so the timer is always live here.
    let t!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(timeoutError(name, timeoutMs)), remaining);
    });
    // Attach a no-op catch to the racer input: if the timeout wins, the losing
    // provider promise still settles later — without this it surfaces as an
    // unhandled rejection (fatal under --unhandled-rejections=strict).
    const attempt = Promise.resolve().then(fn);
    void attempt.catch(() => {});
    const winner = await Promise.race([attempt, timeout]).catch((e: unknown) => {
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
      push(flatToLayer({ ...envSnapshot } as Record<string, unknown>, 'env', undefined, prefix, opts, false, true));
    } else if (src === '.env' || src === '.env.local') {
      const text = readFileSyncSafe(src, maxBytes, opts.fs);
      if (text === undefined) continue;
      push(flatToLayer(parseEnv(text, src), src, undefined, prefix, opts, false));
    } else if (typeof src === 'string') {
      const text = readFileSyncSafe(src, maxBytes, opts.fs);
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
      const text = readFileSyncSafe(p, maxBytes, opts.fs);
      if (text === undefined) continue;
      const lower = p.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
        push(structuredToLayer(parseStructuredFile(p, text), p, prefix));
      } else {
        push(flatToLayer(parseEnv(text, p), p, undefined, prefix, opts, false));
      }
    } else if (src && typeof src === 'object' && 'dir' in src) {
      // Core never touches directories: resolve them with loadSecretsDir()
      // from `typed-settings/node` and pass the result back as `{ map }`.
      // Loud, not silent — an unread secrets dir must never look like defaults.
      throw new ConfigError(
        [{ path: (src as { dir: string }).dir, from: 'config', message: 'E_USAGE: { dir } sources need loadSecretsDir() from typed-settings/node, passed back as { map }' }],
        'E_USAGE',
      );
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

function computeSkipTops(layers: Layer[]): Set<string> {
  // Vault/secrets layers skip `$VAR` expansion unless `expandSecrets:true`.
  // Granularity is top-level by design (documented): if ANY vault layer provides
  // a top, that top skips expansion wholesale. This protects vault `$` literals
  // (passwords, connection strings) at the cost of also skipping a plain-map
  // sibling under the same top — prefer distinct tops or `expandSecrets:true`
  // with escaped `$$` when mixing. See docs/syntax.md.
  return new Set(
    layers.filter((l) => l.skipExpand).flatMap((l) => Object.keys(l.node as object)).map((k) => k.toLowerCase()),
  );
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
  const skipTops = computeSkipTops(layers);

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
  // Fully case-insensitive env index (exact match still wins below): mixed-case
  // keys like Db_Host used to miss all three exact/upper/lower probes.
  const ciEnv = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(envSnapshot)) ciEnv.set(k.toLowerCase(), v);
  return (name: string): string | undefined => {
    const hit = ciKeys.get(name.toLowerCase());
    if (hit !== undefined) {
      const direct = rec[hit];
      if (typeof direct === 'string') return direct;
      if (typeof direct === 'number' || typeof direct === 'boolean' || typeof direct === 'bigint') return String(direct);
      // Nullish falls back to env (a null placeholder defers); objects and
      // arrays are unresolved — never the silent "[object Object]".
      if (direct === undefined || direct === null) return envSnapshot[name] ?? ciEnv.get(name.toLowerCase());
      return undefined;
    }
    return envSnapshot[name] ?? ciEnv.get(name.toLowerCase());
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
    // Fast path: no `$` means expandValue is the identity (it only rewrites
    // `$`/`\$` sequences), so skip the lookup, context spread, and scan.
    if (!obj.includes('$')) return obj;
    const top = (path[0] ?? '<root>').toLowerCase();
    const from = ctx.fromMap.get(top) ?? 'config';
    // The dotted leaf path (e.g. db.url) travels with the value so expansion
    // errors blame the referencing leaf — not the referenced variable. The
    // resolution stack itself starts empty: path segments are not variables in
    // scope (seeding it caused false E_CIRCULAR on e.g. server.port="$port").
    const leaf = path.map((p) => String(p).toLowerCase()).join('.') || '<root>';
    try {
      return expandLeaf(obj, lookup, { ...ctx, from }, [], leaf);
    } catch (e) {
      // Ambient process.env values regularly contain literal `$` (shell prompts
      // like `$P`, build scripts). Only *unresolved* names degrade to the raw
      // literal — cycles, bad operators, and depth violations are almost always
      // typos, so they throw exactly like file/map/provider values do.
      if (from === 'env' && e instanceof ConfigError && e.code === 'E_UNRESOLVED') return obj;
      throw e;
    }
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
  leaf: string,
): string {
  return expandValue(
    value,
    (name: string) => {
      const lower = name.toLowerCase();
      if (stack.includes(lower)) {
        throw new ConfigError(
          [{ path: leaf, from: ctx.from, message: `E_CIRCULAR: $${[...stack, name].join('->$')} reachable from '${leaf}' — unwind the $VAR references` }],
          'E_CIRCULAR',
        );
      }
      if (stack.length >= MAX_EXPAND_DEPTH) {
        // Long non-cyclic chains (A=${B}, B=${C}, ...) recurse per link and
        // would otherwise end in a RangeError. Fail closed with a ConfigError.
        throw new ConfigError(
          [{ path: leaf, from: ctx.from, message: `E_CIRCULAR: $VAR chain from '${leaf}' exceeded ${MAX_EXPAND_DEPTH} links — flatten the indirection` }],
          'E_CIRCULAR',
        );
      }
      const raw = lookup(name);
      if (raw === undefined) return undefined;
      // Resolve chains (A=${B}, B=hi); the substituted result is inserted verbatim.
      if (raw.includes('$')) return expandLeaf(raw, lookup, ctx, [...stack, lower], leaf);
      return raw;
    },
    { allowUnresolved: ctx.allowUnresolved, from: ctx.from, leafPath: leaf },
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

function applyUnknownKeys(input: unknown, value: unknown, mode: 'strip' | 'preserve' | 'reject', fromFor: (path: string) => string): unknown {
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
      unknown.map((p) => ({ path: p, from: fromFor(p), message: `E_UNKNOWN_KEY: '${p}' is not in the schema — remove it, or use unknownKeys 'strip'/'preserve'` })),
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
 * the inferred output type, frozen. Each issue names the failing `path` and the
 * source that won it, with secrets redacted.
 *
 * @throws ConfigError on merge, parse, expansion, or validation failure.
 * @throws ConfigError with `code: 'USE_ASYNC'` if a provider or the schema is
 * async — switch to `settingsAsync()`.
 */
export function settings<S extends StandardSchemaV1>(opts: SettingsOptions<S>): StandardSchemaV1.InferOutput<S> {
  validateOptions(opts as SettingsOptions<StandardSchemaV1>);
  const secrets = (opts as SettingsOptions<StandardSchemaV1>).secretKeys;
  const envSnapshot = getEnvSnapshot(opts.env);
  const { input, fromFor } = depthGuarded('config', () => buildConfigObject(opts as SettingsOptions<StandardSchemaV1>, envSnapshot));
  const r = depthGuarded('schema', () => validateStandard(opts.schema, input));
  if ('promise' in r) {
    throw new ConfigError(
      [{ path: '<root>', from: 'schema', message: 'USE_ASYNC: schema is async, use settingsAsync()' }],
      'USE_ASYNC',
    );
  }
  if ('issues' in r) {
    throw new ConfigError(
      r.issues.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input, secrets) })),
    );
  }
  const value = (r as { value: unknown }).value;
  const final = depthGuarded('config', () => applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip', fromFor));
  return (opts.freeze === false ? final : depthGuarded('config', () => freezeDeep(final))) as StandardSchemaV1.InferOutput<S>;
}

/**
 * Async twin of `settings()`: awaits async providers (the whole collection
 * shares one `timeoutMs` deadline) and async schemas (which race a separate
 * `timeoutMs` budget), with the same merge/expand/coerce/validate/freeze
 * pipeline and the same `ConfigError` contract.
 */
export async function settingsAsync<S extends StandardSchemaV1>(
  opts: SettingsOptions<S>,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  validateOptions(opts as SettingsOptions<StandardSchemaV1>);
  const secrets = (opts as SettingsOptions<StandardSchemaV1>).secretKeys;
  const envSnapshot = getEnvSnapshot(opts.env);
  // Async provider support: re-collect allowing async loads. RangeError from
  // hostile nesting maps to E_DEPTH (the sync path covers this via depthGuarded).
  const { input, fromFor } = await buildConfigObjectAsync(opts as SettingsOptions<StandardSchemaV1>, envSnapshot).catch((e: unknown) => {
    if (e instanceof ConfigError) throw e;
    if (e instanceof RangeError) {
      throw new ConfigError(
        [{ path: '<root>', from: 'config', message: 'E_DEPTH: nesting too deep (possible hostile input)' }],
        'E_DEPTH',
      );
    }
    throw e;
  });
  const r = validateStandard(opts.schema, input);
  if ('promise' in r) {
    // Suppress a late loser rejection: without this, a validation that settles
    // after the timeout wins surfaces as an unhandled rejection.
    void r.promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new ConfigError([{ path: '<root>', from: 'schema', message: `E_TIMEOUT: async validation outran timeoutMs (${timeoutMs}ms) — raise timeoutMs or fix the validator` }], 'E_TIMEOUT')), timeoutMs);
    });
    let raced: Awaited<typeof r.promise>;
    try {
      raced = await Promise.race([r.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!raced.ok) {
      throw new ConfigError(raced.issues!.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input, secrets) })));
    }
    const value = raced.value;
    const final = depthGuarded('config', () => applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip', fromFor));
    return (opts.freeze === false ? final : depthGuarded('config', () => freezeDeep(final))) as StandardSchemaV1.InferOutput<S>;
  }
  if ('issues' in r) {
    throw new ConfigError(r.issues.map((i) => ({ path: i.path, from: fromFor(i.path), message: maskIfSecret(i.path, i.message, input, secrets) })));
  }
  const value = (r as { value: unknown }).value;
  const final = depthGuarded('config', () => applyUnknownKeys(input, value, opts.unknownKeys ?? 'strip', fromFor));
  return (opts.freeze === false ? final : depthGuarded('config', () => freezeDeep(final))) as StandardSchemaV1.InferOutput<S>;
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
  const skipTops = computeSkipTops(layers);
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
  // Split `a.b`, `a.0.b` (collectLeafPaths shape), and `a[0].b` (adapter shape)
  // into steps so array-indexed secret paths actually resolve for scrubbing.
  const parts: (string | number)[] = [];
  for (const seg of path.split('.')) {
    const m = /^([^\[\]]+)\[(\d+)\]$/.exec(seg);
    if (m) parts.push(m[1]!, Number(m[2]));
    else parts.push(seg);
  }
  let cur: unknown = input;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = typeof part === 'number' ? part : Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = (cur as unknown[])[idx];
      continue;
    }
    const rec = cur as Record<string, unknown>;
    const found = Object.keys(rec).find((k) => k.toLowerCase() === String(part).toLowerCase());
    if (!found) return undefined;
    cur = rec[found];
  }
  return cur;
}

function base64Of(s: string): string | null {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  // btoa is latin1-only: non-latin1 secrets throw InvalidCharacterError, so a
  // throwing btoa falls through to Buffer instead of abandoning the scrub.
  if (g.btoa) {
    try {
      return g.btoa(s);
    } catch {
      // fall through to Buffer below
    }
  }
  try {
    if (g.Buffer) return g.Buffer.from(s, 'utf8').toString('base64');
  } catch {
    // broken Buffer shim — give up on the base64 scrub (raw scrub still applies)
  }
  return null;
}

function maskIfSecret(path: string, message: string, input: unknown, secretKeys?: (string | RegExp)[]): string {
  if (!isSecretKey(path, secretKeys)) return message;
  let out = message;
  // Value-equality redaction: strip the raw (and base64) secret from the message itself,
  // e.g. custom refinements that echo the received value.
  const leaf = getLeafByPath(input, path);
  const raw = typeof leaf === 'string' ? leaf : typeof leaf === 'number' || typeof leaf === 'boolean' || typeof leaf === 'bigint' ? String(leaf) : undefined;
  // Short values (<4 chars) are skipped for the equality scrub: replacing every
  // 'a' or '12' in a message corrupts it, while the appended `(redacted)` tag
  // still marks the issue as secret.
  if (raw !== undefined && raw.length >= 4) {
    const redacted = redactValue(path, raw, secretKeys);
    out = out.split(raw).join(redacted);
    const b64 = base64Of(raw);
    if (b64 && b64.length > 8) out = out.split(b64).join(redacted);
  }
  return `${out} (redacted)`;
}
