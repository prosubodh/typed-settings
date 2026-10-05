/**
 * Node.js entry: dotenv file loading, secrets-dir reading, and file watching.
 *
 * Importing this module installs the file-read hook that core uses under ESM.
 * Edge bundlers should skip it entirely and pass `{ text }` / `{ map }` sources.
 */
import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import type { Flat, SettingsOptions } from './types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { parseEnvText } from './formats/env.js';
import { settings } from './index.js';
import { ConfigError } from './errors.js';

// Make sync file reads work in ESM (vitest/node) via injection hook read by src/index.ts.
// Edge bundlers never import `typed-settings/node`, so core stays fs-free for them.
(globalThis as unknown as { __typedSettingsFs?: { readFileSync(p: string, e: string): string } }).__typedSettingsFs ??= {
  readFileSync: (p: string, e: string) => readFileSync(p, e as BufferEncoding),
};

/**
 * Reads dotenv files and joins them with newlines for `{ text }` sources.
 * Missing files are skipped; anything else (e.g. `EACCES`) rethrows.
 */
export function loadEnvFiles(paths: string[]): { text: string } {
  const parts: string[] = [];
  for (const p of paths) {
    try {
      parts.push(readFileSync(p, 'utf8'));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue; // missing -> skip
      throw e;
    }
  }
  return { text: parts.join('\n') };
}

/**
 * Reads a secrets dir (Docker/K8s `/run/secrets`) into a flat map keyed by
 * uppercased filenames. Skips subdirectories, `..*` entries, and empties; strips
 * one trailing newline but otherwise preserves whitespace verbatim. Missing dir
 * reads as `{}`; unreadable files throw (`EACCES` fails closed).
 */
export function loadSecretsDir(dir: string): Flat {
  const out: Flat = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return out;
    throw e;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw e;
    }
    if (name.startsWith('..')) continue; // skip K8s symlinks except pinned target handled by caller
    let v: string;
    try {
      // Strip one trailing newline (files conventionally end with \n); interior
      // and leading whitespace is significant secret material — never trim it.
      v = readFileSync(full, 'utf8').replace(/\r?\n$/, '');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw e; // EACCES and friends fail closed — a missing secret must not read as {}
    }
    if (!v) continue;
    out[name.toUpperCase()] = v;
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
  return (sources ?? []).some(
    (s) => (s && typeof s === 'object' && ('dir' in s || 'provider' in s || 'load' in s)),
  );
}

function diffLeafPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (i >= a.length || i >= b.length) out.push(p);
      else out.push(...diffLeafPaths(a[i], b[i], p));
    }
    return out;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: string[] = [];
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in (a as object)) || !(k in (b as object))) out.push(p);
      else out.push(...diffLeafPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], p));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '<root>'];
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

  const handle: WatchHandle<StandardSchemaV1.InferOutput<S>> = {
    get: () => current,
    reload: async () => {
      await doReload();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
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
    // Re-arm watchers first (picks up files/dirs created since startup),
    // then settle files in parallel — sequential 20ms sleeps would stall N files.
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
    for (const file of extractWatchFiles(opts.sources)) {
      const dir = dirname(file);
      const base = basename(file);
      const key = dir + '\0' + base;
      if (watchedDirs.has(key)) continue;
      try {
        const w = watch(dir, (_event, filename) => {
          const name = typeof filename === 'string' ? filename : filename ? String(filename) : null;
          if (name && name !== base) return;
          scheduleReload();
        });
        w.on('error', () => {
          // best-effort; poll fallback covers failures
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
    intervals.push(setInterval(scheduleReload, pollMs));
  }
  if (refreshMs > 0) {
    intervals.push(setInterval(scheduleReload, refreshMs));
  }

  return handle;
}
