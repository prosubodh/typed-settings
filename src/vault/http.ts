/**
 * Generic HTTP secret provider: GETs a JSON endpoint and reads a dot-path
 * (`jsonPath`, default `'data'`) into a flat map. Auth rides in `headers`.
 *
 * @module
 */
import type { Flat, SecretProvider } from '../types.js';
import { ConfigError } from '../errors.js';
import { assertPositive, fetchWithRedirectGuard, getFetch, normalizeSecretMap, raceTimeout, readBodyCapped, sanitizeUrl, statusToCode, timeoutSignal, type FetchFn } from './shared.js';

/** Options for {@link httpProvider}. */
export interface HttpProviderOptions {
  /** Endpoint URL. */
  url: string;
  /** Extra headers. Feed auth from env-injected values, never CLI args. */
  headers?: Flat; // auth from env-injected headers, never CLI args for secrets
  /** Dot path into the JSON body. Default `'data'`; `''` reads the whole body. */
  jsonPath?: string; // dot path, default 'data'
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number; // default 5000
  /** Injectable fetch for tests. */
  fetchFn?: FetchFn;
  /** Response body cap in bytes. Default 1 MiB. */
  maxBytes?: number; // default 1MiB
}

function getAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    // Own properties only: `in` would resolve inherited members
    // (`__proto__`, `toString`) into attacker-influenced shapes.
    if (cur && typeof cur === 'object' && Object.hasOwn(cur as object, seg)) cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/**
 * GETs a JSON endpoint and reads `jsonPath` into a flat map. Concurrent loads
 * share one in-flight request; failures reset so the next call retries.
 */
export function httpProvider(opts: HttpProviderOptions): SecretProvider {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  assertPositive(timeoutMs, 'timeoutMs', 'http');
  assertPositive(maxBytes, 'maxBytes', 'http');
  const jsonPath = opts.jsonPath ?? 'data';
  // Credentials embedded in the URL (userinfo, ?token=) must never reach logs:
  // ConfigError path/from carry the URL, and check/watch print those.
  const safeUrl = sanitizeUrl(opts.url);
  const name = `http://${safeUrl}`;
  let inflight: Promise<Flat> | null = null;

  async function doLoad(): Promise<Flat> {
    const fetchFn = getFetch(opts.fetchFn);
    const headers = new Headers();
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v !== undefined) headers.set(k, v);
    }
    // A caller-provided Accept (e.g. a Vault KVv2 media type) wins; the default
    // only fills the gap instead of clobbering it.
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    let res: Response;
    try {
      // Race the whole fetch, not just the signal: injected fetchFns routinely
      // ignore `signal`, and without this a hanging backend hangs boot forever.
      res = await raceTimeout(
        fetchWithRedirectGuard(opts.url, { headers, signal: timeoutSignal(timeoutMs) }, fetchFn),
        timeoutMs,
        safeUrl,
        name,
      );
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      const err = e as Error;
      const isTimeout = /timeout|abort/i.test(err?.name + err?.message);
      throw new ConfigError(
        [{ path: safeUrl, from: name, message: `${isTimeout ? 'E_TIMEOUT' : 'E_CONN'}: ${err?.message ?? String(e)}` }],
        isTimeout ? 'E_TIMEOUT' : 'E_CONN',
      );
    }
    if (!res.ok) {
      const code = statusToCode(res.status);
      throw new ConfigError([{ path: safeUrl, from: name, message: `${code}: HTTP ${res.status}` }], code);
    }
    // Bounded body read: the fetch signal covers headers only, so race the
    // body against the same budget (slowloris) and enforce maxBytes.
    const text = await readBodyCapped(res, safeUrl, name, maxBytes, timeoutMs);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConfigError([{ path: safeUrl, from: name, message: 'E_PARSE: invalid JSON' }], 'E_PARSE');
    }
    let inner: unknown = getAtPath(json, jsonPath);
    // Unwrap KV-style data.data only for real KVv2 envelopes (metadata sibling
    // present) — a payload that merely contains a `data` key must not unwrap.
    if (
      inner && typeof inner === 'object' && !Array.isArray(inner) &&
      Object.hasOwn(inner as object, 'data') && Object.hasOwn(inner as object, 'metadata')
    ) {
      inner = (inner as { data: unknown }).data;
    }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      throw new ConfigError([{ path: jsonPath, from: name, message: 'E_SHAPE: missing data' }], 'E_SHAPE');
    }
    return normalizeSecretMap(inner, name);
  }

  return {
    name,
    load(): Promise<Flat> {
      if (!inflight) {
        inflight = doLoad().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
