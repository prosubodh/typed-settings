import type { Flat, SecretProvider } from '../types.js';
import { ConfigError, byteLengthUtf8 } from '../errors.js';
import { isProtoKey } from '../merge.js';

/** Injectable fetch shape, so tests never need a live server. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function getFetch(fetchFn?: FetchFn): FetchFn {
  if (fetchFn) return fetchFn;
  const g = globalThis as { fetch?: FetchFn };
  if (g.fetch) return g.fetch.bind(globalThis);
  throw new ConfigError(
    [{ path: '<provider>', from: 'vault', message: 'E_NO_FETCH: global fetch unavailable' }],
    'E_NO_FETCH',
  );
}

function sameHost(a: string, b: string): boolean {
  // Both sides are absolute URLs by construction (callers build them via new URL).
  // A non-URL here is a programming error — fail closed as cross-host so auth
  // headers are stripped rather than leaked to an attacker-controlled target.
  try {
    return new URL(a).host === new URL(b).host;
    /* v8 ignore next 3 -- unreachable: redirect targets are validated before this runs */
  } catch {
    return false;
  }
}

/** Headers that must never survive a cross-host redirect (auth material). */
const SENSITIVE_HEADER_RE = /authorization|token|secret|api[-_]?key|cookie|auth/i;

/** True when a redirect drops from https to a cleartext scheme. */
function isDowngrade(a: string, b: string): boolean {
  try {
    return new URL(a).protocol === 'https:' && new URL(b).protocol !== 'https:';
    /* v8 ignore next 3 -- unreachable: redirect targets are validated before this runs */
  } catch {
    return false;
  }
}

function stripSensitiveForCrossHost(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (!SENSITIVE_HEADER_RE.test(key)) next.set(key, value);
  });
  return next;
}

/**
 * GET with manual redirects (max 2). Crossing hosts — or downgrading from
 * https to a cleartext scheme, even on the same host — strips every auth
 * header (not just Vault's own); exhaustion or a non-URL `Location` throws
 * `E_REDIRECT`. Missing `Location` ends the chain and returns the response
 * as-is.
 */
export async function fetchWithRedirectGuard(
  url: string,
  init: RequestInit,
  fetchFn: FetchFn,
  maxRedirects = 2,
): Promise<Response> {
  let current = url;
  let headers = new Headers(init.headers);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchFn(current, { ...init, headers, redirect: 'manual' });
    const status = res.status;
    if (![301, 302, 303, 307, 308].includes(status)) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    let next: string;
    try {
      next = new URL(loc, current).toString();
    } catch {
      // A server-controlled Location that is not a URL is a redirect attack
      // surface — fail closed with E_REDIRECT, never E_CONN.
      throw new ConfigError(
        [{ path: current, from: 'vault', message: 'E_REDIRECT: invalid Location header' }],
        'E_REDIRECT',
      );
    }
    if (i === maxRedirects) {
      throw new ConfigError(
        [{ path: next, from: 'vault', message: 'E_REDIRECT: too many redirects' }],
        'E_REDIRECT',
      );
    }
    // Strip all auth material on cross-host redirect (not just Vault's own
    // headers — custom `X-Api-Key`/cookies would otherwise leak to the target)
    // and on https→http downgrade: credentials must never ride a cleartext hop.
    if (!sameHost(current, next) || isDowngrade(current, next)) headers = stripSensitiveForCrossHost(headers);
    current = next;
  }
  // Unreachable: the loop always returns a response or throws E_REDIRECT above,
  // even with maxRedirects <= 0 (the single pass settles it). Kept for TS.
  throw new ConfigError([{ path: url, from: 'vault', message: 'E_REDIRECT' }], 'E_REDIRECT');
}

/**
 * Coerces a provider payload into a flat map. Non-object roots throw `E_SHAPE`;
 * `null`/`undefined` values are skipped; nested objects are preserved for `__`
 * expansion downstream; other values stringify. Trims one trailing newline
 * unless `trimNewline: false`.
 */
export function normalizeSecretMap(raw: unknown, providerName: string, opts?: { trimNewline?: boolean }): Flat {
  const trim = opts?.trimNewline !== false;
  const clean = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined;
    let s = typeof v === 'string' ? v : String(v);
    if (trim) s = s.replace(/\r?\n$/, '');
    return s;
  };
  const out: Flat = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      [{ path: '<root>', from: providerName, message: 'E_SHAPE: provider returned non-object' }],
      'E_SHAPE',
    );
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Fail closed like every other ingestion path (only __proto__ hijacks an
    // assignment; constructor/prototype are inert own data properties).
    if (isProtoKey(k)) {
      throw new ConfigError([{ path: k, from: providerName, message: 'E_PROTO: forbidden key' }], 'E_PROTO');
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Nested object: keep JSON-encoded? No — keep nested for __ expansion later.
      // Store as-is via JSON marker: caller trackFlat preserves objects.
      (out as Record<string, unknown>)[k] = v;
      continue;
    }
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Maps HTTP status to a fail-closed code: 401/403 `E_DENIED`, 404 `E_NOT_FOUND`,
 * 429 `E_THROTTLED`, 408/504 `E_TIMEOUT`, other 5xx `E_UPSTREAM`, else `E_PROVIDER`.
 */
export function statusToCode(status: number): string {
  if (status === 403 || status === 401) return 'E_DENIED';
  if (status === 404) return 'E_NOT_FOUND';
  if (status === 429) return 'E_THROTTLED';
  if (status === 408 || status === 504) return 'E_TIMEOUT';
  if (status >= 500) return 'E_UPSTREAM';
  return 'E_PROVIDER';
}

/**
 * Returns an abort signal for `timeoutMs`, or `undefined` on runtimes without
 * `AbortSignal.timeout` (older Node / Edge polyfills). Callers still race the
 * body read against the same budget, so a missing signal degrades to
 * whole-load timeout rather than hanging.
 */
export function timeoutSignal(timeoutMs: number, impl?: { timeout?: (ms: number) => AbortSignal }): AbortSignal | undefined {
  const g = impl ?? (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal });
  if (typeof g.timeout === 'function') {
    try {
      return g.timeout(timeoutMs);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Rejects nonsensical numeric options (NaN/Infinity/zero/negative disable safety caps). */
export function assertPositive(value: number, option: string, from: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      [{ path: option, from, message: `E_USAGE: ${option} must be a positive finite number` }],
      'E_USAGE',
    );
  }
}

/**
 * Strips credentials from a URL for error attribution. ConfigError path/from
 * carry the URL and check/watch print those to logs — `user:pass@` and
 * `?token=`-style params must not survive. Unparseable input returns as-is.
 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      // Bare `key` is excluded: it false-positives on params like `monkey`
      // while the longer patterns still catch real credential names.
      if (/token|secret|auth|password|credential|api[-_]?key|pwd|passphrase/i.test(k)) u.searchParams.delete(k);
    }
    // Fragments never reach the server, but they do reach logs.
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}
export async function raceTimeout<T>(attempt: Promise<T>, timeoutMs: number, path: string, from: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new ConfigError([{ path, from, message: 'E_TIMEOUT: request timed out' }], 'E_TIMEOUT')),
      timeoutMs,
    );
  });
  void attempt.catch(() => {});
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads a response body bounded by both byte cap and timeout. The fetch signal
 * only covers headers; a slowloris body would otherwise hang past `timeoutMs`.
 */
export async function readBodyCapped(res: Response, path: string, from: string, maxBytes: number, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new ConfigError([{ path, from, message: 'E_TIMEOUT: response body timed out' }], 'E_TIMEOUT')),
      timeoutMs,
    );
  });
  try {
    // The body loser needs its own suppression: a slowloris body that rejects
    // after the timeout wins would otherwise surface as unhandled rejection.
    const body = res.text();
    void body.catch(() => {});
    const text = await Promise.race([body, timeout]);
    if (byteLengthUtf8(text) > maxBytes) {
      throw new ConfigError([{ path, from, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves the fetch implementation: injected `fetchFn` first, else global `fetch` (`E_NO_FETCH` when neither exists). */
export { getFetch };
export type { SecretProvider };
