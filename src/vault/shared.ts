import type { Flat, SecretProvider } from '../types.js';
import { ConfigError } from '../errors.js';

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
  // Both sides are absolute URLs by construction (callers build them via new URL),
  // so no try/catch: an invalid URL is a programming error, not a redirect.
  return new URL(a).host === new URL(b).host;
}

/** Headers that must never survive a cross-host redirect (auth material). */
const SENSITIVE_HEADER_RE = /authorization|token|secret|api[-_]?key|cookie|auth/i;

function stripSensitiveForCrossHost(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (!SENSITIVE_HEADER_RE.test(key)) next.set(key, value);
  });
  return next;
}

/**
 * GET with manual redirects (max 2). Crossing hosts strips every auth header
 * (not just Vault's own); exhaustion or a non-URL `Location` throws `E_REDIRECT`.
 * Missing `Location` ends the chain and returns the response as-is.
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
    // headers — custom `X-Api-Key`/cookies would otherwise leak to the target).
    if (!sameHost(current, next)) headers = stripSensitiveForCrossHost(headers);
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
 * 429 `E_THROTTLED`, 5xx `E_UPSTREAM`, anything else `E_PROVIDER`.
 */
export function statusToCode(status: number): string {
  if (status === 403 || status === 401) return 'E_DENIED';
  if (status === 404) return 'E_NOT_FOUND';
  if (status === 429) return 'E_THROTTLED';
  if (status >= 500) return 'E_UPSTREAM';
  return 'E_PROVIDER';
}

/** Resolves the fetch implementation: injected `fetchFn` first, else global `fetch` (`E_NO_FETCH` when neither exists). */
export { getFetch };
export type { SecretProvider };
