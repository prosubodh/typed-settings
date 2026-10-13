/**
 * Node.js entry: dotenv file loading, secrets-dir reading, and file watching.
 *
 * Importing this module installs the file-read hook that core uses under ESM.
 * Edge bundlers should skip it entirely and pass `{ text }` / `{ map }` sources.
 *
 * @module
 */
import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import type { Flat, SettingsOptions } from './types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { parseEnvText } from './formats/env.js';
import { isPlainObject } from './merge.js';
import { settings } from './index.js';
import { ConfigError, byteLengthUtf8 } from './errors.js';

// Make sync file reads work in ESM (vitest/node) via injection hook read by src/index.ts.
// Edge bundlers never import `typed-settings/node`, so core stays fs-free for them.
(globalThis as unknown as { __typedSettingsFs?: { readFileSync(p: string, e: string): string; statSync?(p: string): { size: number } } }).__typedSettingsFs ??= {
  readFileSync: (p: string, e: string) => readFileSync(p, e as BufferEncoding),
  statSync: (p: string) => statSync(p),
};

/**
 * Reads dotenv files and joins them with newlines for `{ text }` sources.
 * Missing files are skipped; anything else (e.g. `EACCES`) rethrows. Total
 * size is capped (default 2 MiB, same as `loadSecretsDir`) so a hostile or
 * symlinked `.env` cannot balloon memory — exceed it and `E_FILE_TOO_LARGE`.
 */
export function loadEnvFiles(paths: string[], opts: { maxBytes?: number } = {}): { text: string } {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new ConfigError([{ path: '<envFiles>', from: 'loadEnvFiles', message: 'E_USAGE: maxBytes must be a positive number' }], 'E_USAGE');
  }
  const parts: string[] = [];
  let total = 0;
  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf8');
      const bytes = byteLengthUtf8(raw);
      if (bytes > maxBytes || total + bytes > maxBytes) {
        throw new ConfigError(
          [{ path: p, from: 'loadEnvFiles', message: 'E_FILE_TOO_LARGE: env text over cap' }],
          'E_FILE_TOO_LARGE',
        );
      }
      total += bytes;
      parts.push(raw);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue; // missing -> skip
      throw e; // includes our own ConfigError: never swallowed as a 'missing' file
    }
  }
  return { text: parts.join('\n') };
}

/** Options for {@link loadSecretsDir}. */
export interface LoadSecretsDirOptions {
  /** Keep empty files as `''` instead of skipping them. Default false (skip). */
  preserveEmpty?: boolean;
  /** Per-file read cap in UTF-8 bytes. Default 2 MiB (matches core `maxBytes`). */
  maxBytes?: number;
}

/**
 * Reads a secrets dir (Docker/K8s `/run/secrets`) into a flat map keyed by
 * uppercased filenames. Skips subdirectories, `..*` entries, and (by default)
 * empties; strips one trailing newline but otherwise preserves whitespace
 * verbatim. Missing dir reads as `{}`; unreadable files throw (`EACCES` fails
 * closed). Symlinks are confined to the dir (K8s `..data` links resolve inside);
 * links escaping it throw. Case collisions (`Token` vs `TOKEN`) throw instead
 * of depending on readdir order.
 */
export function loadSecretsDir(dir: string, opts: LoadSecretsDirOptions = {}): Flat {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new ConfigError([{ path: dir, from: dir, message: 'E_USAGE: maxBytes must be a positive finite number' }], 'E_USAGE');
  }
  const out: Flat = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return out;
    throw e;
  }
  const root = resolve(dir);
  for (const name of entries) {
    const full = join(dir, name);
    // lstat first: never follow a symlink blindly. K8s mounts secrets as
    // symlinks to `..data_<ts>` inside the dir — allow those, reject escapes.
    let st: { isFile(): boolean; isSymbolicLink(): boolean; size: number };
    try {
      st = lstatSync(full);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw e;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(full);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') continue;
        throw e;
      }
      const rel = relative(root, target);
      // Escape = outside root (covers `..`, absolute cross-drive results, sep tricks).
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new ConfigError(
          [{ path: name, from: dir, message: 'E_SHAPE: secret symlink escapes its directory' }],
          'E_SHAPE',
        );
      }
      try {
        const tst = statSync(target);
        if (!tst.isFile()) continue;
        if (tst.size > maxBytes + 1) {
          throw new ConfigError([{ path: name, from: dir, message: 'E_FILE_TOO_LARGE: secret over cap' }], 'E_FILE_TOO_LARGE');
        }
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        const err = e as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') continue;
        throw e;
      }
    } else if (!st.isFile()) {
      continue; // dirs, FIFOs, sockets: never block on or read special files
    } else if (st.size > maxBytes + 1) {
      throw new ConfigError([{ path: name, from: dir, message: 'E_FILE_TOO_LARGE: secret over cap' }], 'E_FILE_TOO_LARGE');
    }
    if (name.startsWith('..')) continue; // skip K8s symlinks except pinned target handled by caller
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw e; // EACCES and friends fail closed — a missing secret must not read as {}
    }
    /* v8 ignore next 6 -- TOCTOU race window: stat gate covers it deterministically */
    if (byteLengthUtf8(raw) > maxBytes + 1) {
      // Post-read backstop for TOCTOU growth between stat and read. Bytes, not
      // string length: multibyte content must not slip the cap in the window.
      throw new ConfigError([{ path: name, from: dir, message: 'E_FILE_TOO_LARGE: secret over cap' }], 'E_FILE_TOO_LARGE');
    }
    // Strip one trailing newline (files conventionally end with \n); interior
    // and leading whitespace is significant secret material — never trim it.
    const v = raw.replace(/\r?\n$/, '');
    if (!v && !opts.preserveEmpty) continue;
    // ASCII fold: env keys are ASCII; locale-sensitive casing must not merge them.
    const key = name.replace(/[a-z]/g, (c) => c.toUpperCase());
    if (key in out) {
      throw new ConfigError(
        [{ path: name, from: dir, message: `E_SHAPE: secret name collision on ${key}` }],
        'E_SHAPE',
      );
    }
    out[key] = v;
  }
  return out;
}

/**
 * Parses one dotenv file into a flat map. Missing file reads as `{}`;
 * anything else (including `EACCES` and syntax errors) rethrows.
 */
export function parseEnvFile(path: string): Flat {
  try {
    const text = readFileSync(path, 'utf8');
    return parseEnvText(text) as Flat;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return {};
    throw e;
  }
}

/** Watch tuning: debounce, provider/dir refresh, stat-poll fallback, and callbacks. */
export interface WatchCallbacks {
  /** Coalesce rapid saves. Default 100. */
  debounceMs?: number; // default 100
  /** Re-poll providers/secrets-dirs. Default 0=off (60000 when providers present). */
  refreshMs?: number; // poll providers/secrets-dir, default 0=off (60000 if providers present)
  /** Stat-poll fallback for NFS/Docker where fs events are unreliable. Default 0=off. */
  pollMs?: number; // fallback stat poll for NFS/Docker, default 0=off
  /** Fires on each successful reload with the new config and changed leaf paths. */
  onUpdate?: (cfg: unknown, changed: string[]) => void;
  /** Fires when a reload fails; the old config stays live. Never throws outward. */
  onError?: (e: ConfigError | Error, info?: { version: number }) => void;
}

/** Live config subscription. `reload()` re-reads now; `dispose()` is idempotent. */
export interface WatchHandle<T = unknown> {
  get(): T;
  reload(): Promise<void>;
  dispose(): Promise<void>;
  readonly version: number;
}

function extractWatchFiles(sources: SettingsOptions<StandardSchemaV1>['sources']): string[] {
  const out: string[] = [];
  for (const s of sources ?? []) {
    if (s === 'env') continue; // process.env is not a file — nothing to watch
    if (s === '.env' || s === '.env.local') out.push(resolve(s));
    else if (typeof s === 'string') {
      const lower = s.toLowerCase();
      if (
        lower.endsWith('.env') || s === '.env.local' ||
        lower.endsWith('.json') || lower.endsWith('.yaml') ||
        lower.endsWith('.yml') || lower.endsWith('.toml')
      ) {
        out.push(resolve(s));
      } else if (!lower.endsWith('.env')) {
        // Bare string = file path shorthand per spec
        out.push(resolve(s));
      }
    } else if (s && typeof s === 'object' && 'file' in s) {
      out.push(resolve((s as { file: string }).file));
    }
  }
  return [...new Set(out)];
}

function hasPollSources(sources: SettingsOptions<StandardSchemaV1>['sources']): boolean {
  // Providers only: `{ dir }` throws in core (resolve via loadSecretsDir first),
  // so directory polling is the caller's job via refreshMs.
  return (sources ?? []).some(
    (s) => (s && typeof s === 'object' && ('provider' in s || 'load' in s)),
  );
}

function leafEqual(a: unknown, b: unknown): boolean {
  // Plain objects/arrays are compared structurally in diffLeafPaths (so key
  // order never reports a change); leaves only need identity, except non-plain
  // objects (Date, class instances), which compare by JSON shape. The stringify
  // is guarded: exotic values (BigInt holders) report changed, never crash.
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function diffLeafPaths(a: unknown, b: unknown, prefix = ''): string[] {
  // Explicit stack, not recursion: hostile nesting that survived the pipeline
  // guards (or grew between validation and diff) must report, never throw
  // RangeError out of doReload() into an unhandled rejection.
  const out: string[] = [];
  const stack: [unknown, unknown, string][] = [[a, b, prefix]];
  while (stack.length > 0) {
    const [x, y, p] = stack.pop()!;
    if (Array.isArray(x) && Array.isArray(y)) {
      const len = Math.max(x.length, y.length);
      for (let i = len - 1; i >= 0; i--) {
        const q = p ? `${p}[${i}]` : `[${i}]`;
        if (i >= x.length || i >= y.length) out.push(q);
        else stack.push([x[i], y[i], q]);
      }
    } else if (isPlainObject(x) && isPlainObject(y)) {
      const keys = [...new Set([...Object.keys(x as object), ...Object.keys(y as object)])];
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        const q = p ? `${p}.${k}` : k;
        if (!(k in (x as object)) || !(k in (y as object))) out.push(q);
        else stack.push([(x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], q]);
      }
    } else if (!leafEqual(x, y)) {
      out.push(p || '<root>');
    }
  }
  return out;
}

async function stableSize(path: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    let s1: { size: number; mtimeMs: number } | null = null;
    let s2: { size: number; mtimeMs: number } | null = null;
    try {
      const st = statSync(path);
      s1 = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return; // missing -> let reload decide (skip or throw)
    }
    await new Promise((r) => setTimeout(r, 20));
    try {
      const st = statSync(path);
      s2 = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return;
    }
    if (s1.size === s2.size && s1.mtimeMs === s2.mtimeMs) return;
  }
}

/**
 * Subscribes to config files with parent-dir watching (survives atomic renames),
 * debounced reloads, and stable-size settling. Each reload validates off-side and
 * swaps only on success, reporting changed leaf paths; failures keep the old
 * config and notify `onError`. Overlapping reloads drop the stale one.
 */
export function watchSettings<S extends StandardSchemaV1>(
  opts: SettingsOptions<S>,
  cb: WatchCallbacks = {},
): WatchHandle<StandardSchemaV1.InferOutput<S>> {
  const debounceMs = cb.debounceMs ?? 100;
  const refreshMs = cb.refreshMs ?? (hasPollSources(opts.sources) ? 60000 : 0);
  const pollMs = cb.pollMs ?? 0;

  let current = settings(opts);
  let version = 0;
  let lastError: unknown = null;
  let lastReloadAt = Date.now();
  void lastError;
  void lastReloadAt;
  let reloadId = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  const watchedDirs = new Set<string>();
  // Basenames of interest per dir. Updated on every re-arm so files created
  // after startup join the filter instead of being ignored forever.
  const wantedByDir = new Map<string, Set<string>>();

  const handle: WatchHandle<StandardSchemaV1.InferOutput<S>> = {
    get: () => current,
    reload: async () => {
      await doReload();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const iv of intervals) clearInterval(iv);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
    },
    get version() {
      return version;
    },
  };

  async function doReload(): Promise<void> {
    const myId = ++reloadId;
    if (disposed) return;
    // Re-arm watchers first (picks up files/dirs created since startup),
    // then settle files in parallel — sequential 20ms sleeps would stall N files.
    // (No staleness check here: no await has run yet, so reloadId cannot have changed.)
    ensureWatchers();
    const files = extractWatchFiles(opts.sources);
    await Promise.all(
      files.map((f) =>
        stableSize(f).catch(() => {
          // ignore, reload will report
        }),
      ),
    );
    if (disposed || myId !== reloadId) return;
    let next: StandardSchemaV1.InferOutput<S>;
    try {
      // Validate off-side: settings() builds fresh + freezes; only swap on success.
      next = settings(opts);
    } catch (e) {
      lastError = e;
      lastReloadAt = Date.now();
      try {
        cb.onError?.(e as Error, { version });
      } catch {
        // never throw uncaught from watcher
      }
      return;
    }
    // NOTE: settings() above is synchronous, so between the two staleness checks
    // only user code inside schema validate() can interleave (e.g. dispose()).
    if (disposed || myId !== reloadId) return; // drop stale
    const changed = diffLeafPaths(current, next);
    current = next;
    version++;
    lastReloadAt = Date.now();
    try {
      cb.onUpdate?.(current, changed);
    } catch {
      // ignore user callback throws
    }
  }

  function scheduleReload(): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doReload();
    }, debounceMs);
  }

  function ensureWatchers(): void {
    // (Re)arm parent-dir watchers. Watching the directory (not the file) survives
    // atomic renames; this also picks up files/dirs that did not exist at startup
    // (missing file = skip is valid, but creation must still trigger a reload).
    // Dedupe by directory: N files in one dir share one watcher.
    const byDir = new Map<string, string[]>();
    for (const file of extractWatchFiles(opts.sources)) {
      const dir = dirname(file);
      const base = basename(file);
      const list = byDir.get(dir) ?? [];
      list.push(base);
      byDir.set(dir, list);
    }
    for (const [dir, bases] of byDir) {
      let wanted = wantedByDir.get(dir);
      if (!wanted) {
        wanted = new Set<string>();
        wantedByDir.set(dir, wanted);
      }
      for (const b of bases) wanted.add(b);
      const key = dir;
      if (watchedDirs.has(key)) continue;
      try {
        const live = wanted;
        const w = watch(dir, (_event, filename) => {
          const name = typeof filename === 'string' ? filename : filename ? String(filename) : null;
          // filename may be null on some platforms — reload (debounced) rather
          // than ignore, but dir-dedupe keeps it to one reload per change.
          if (name && !live.has(name)) return;
          scheduleReload();
        });
        w.on('error', () => {
          // Evict so the next reload retries; drop the dead handle so failures
          // don't accumulate one entry per cycle. Re-arm on a tick (not inline:
          // error handlers may iterate live watcher lists, and inline re-arm
          // would append mid-iteration). If the dir recovered there is no blind
          // window; if not, the throw is swallowed and the next reload retries.
          watchedDirs.delete(key);
          wantedByDir.delete(key);
          watchers.splice(watchers.indexOf(w), 1);
          setTimeout(() => {
            if (!disposed) ensureWatchers();
          }, 0);
        });
        watchers.push(w);
        watchedDirs.add(key);
      } catch {
        // EACCES/ENOENT: keep-old; retried on the next reload + poll fallback
      }
    }
  }

  ensureWatchers();

  if (pollMs > 0) {
    // Poll/refresh drive reloads directly: routing them through the debounced
    // fs-event path would let a hot interval starve reloads forever.
    intervals.push(setInterval(() => void doReload(), pollMs));
  }
  if (refreshMs > 0) {
    intervals.push(setInterval(() => void doReload(), refreshMs));
  }

  return handle;
}
