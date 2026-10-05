/**
 * HashiCorp Vault provider (KVv1 + KVv2): reads one secret path into a flat map.
 * Token comes from `auth.token` or `VAULT_TOKEN`; KVv2 envelopes unwrap only
 * when a `metadata` sibling is present. Fail-closed on 403.
 */
import type { Flat, SecretProvider } from '../types.js';
import { ConfigError, byteLengthUtf8 } from '../errors.js';
import { fetchWithRedirectGuard, getFetch, normalizeSecretMap, statusToCode, type FetchFn } from './shared.js';

/** Options for {@link hashicorpProvider}. */
export interface HashicorpOptions {
  /** Vault base URL, e.g. `https://vault:8200`. */
  url: string; // e.g. https://vault:8200
  /** KV mount. Default `'secret'`. */
  mount?: string; // default 'secret'
  /** Secret path: `data/app/prod` (KVv2) or `app/prod` (KVv1). */
  path: string; // e.g. 'data/app/prod' (KVv2) or 'app/prod' (KVv1)
  /** Explicit token. `''` means none (no `VAULT_TOKEN` fallback); unset reads `VAULT_TOKEN`. */
  auth?: { token?: string };
  /** Pinned KVv2 version (`?version=`). */
  version?: number | string; // pinned version (KVv2 ?version=)
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number; // default 5000
  /** Injectable fetch for tests. */
  fetchFn?: FetchFn; // injectable for tests
  /** Response body cap in bytes. Default 1 MiB. */
  maxBytes?: number; // default 1MiB
}

function tokenFromEnv(explicit?: string): string | undefined {
  // Nullish (not falsy): an explicit '' means "no token" and must NOT fall back
  // to VAULT_TOKEN — otherwise clearing a credential silently re-arms it.
  if (explicit !== undefined) return explicit || undefined;
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.['VAULT_TOKEN'];
}

/**
 * Reads one Vault path into a flat map. Concurrent `load()` calls share a
 * single in-flight request; failures reset so the next call retries.
 */
export function hashicorpProvider(opts: HashicorpOptions): SecretProvider {
  const mount = (opts.mount ?? 'secret').replace(/^\/+|\/+$/g, '');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const name = `hashicorp://${mount}/${opts.path}`;
  let inflight: Promise<Flat> | null = null;

  async function doLoad(): Promise<Flat> {
    const token = tokenFromEnv(opts.auth?.token);
    const fetchFn = getFetch(opts.fetchFn);
    const base = opts.url.replace(/\/+$/g, '');
    const p = opts.path.replace(/^\/+/, '');
    const qs = opts.version !== undefined ? `?version=${encodeURIComponent(String(opts.version))}` : '';
    const url = `${base}/v1/${mount}/${p}${qs}`;
    const headers = new Headers();
    if (token) headers.set('X-Vault-Token', token);
    headers.set('Accept', 'application/json');
    let res: Response;
    try {
      res = await fetchWithRedirectGuard(
        url,
        { headers, signal: AbortSignal.timeout(timeoutMs) },
        fetchFn,
      );
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      const err = e as Error;
      const isTimeout = /timeout|abort/i.test(err?.name + err?.message);
      throw new ConfigError(
        [{ path: p, from: name, message: `${isTimeout ? 'E_TIMEOUT' : 'E_CONN'}: ${err?.message ?? String(e)}` }],
        isTimeout ? 'E_TIMEOUT' : 'E_CONN',
      );
    }
    if (!res.ok) {
      const code = statusToCode(res.status);
      // 403 never falls through — fail closed, no value
      throw new ConfigError([{ path: p, from: name, message: `${code}: HTTP ${res.status}` }], code);
    }
    const text = await res.text();
    if (byteLengthUtf8(text) > maxBytes) {
      throw new ConfigError([{ path: p, from: name, message: 'E_TOO_LARGE: secret >cap' }], 'E_TOO_LARGE');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConfigError([{ path: p, from: name, message: 'E_PARSE: invalid JSON' }], 'E_PARSE');
    }
    const data = (json as { data?: unknown }).data as Record<string, unknown> | undefined;
    // Unwrap matrix: KVv2 envelopes carry a `metadata` sibling next to `data.data`;
    // a KVv1 secret that merely happens to contain a key named `data` must NOT unwrap.
    const isKv2 =
      !!data && typeof data === 'object' && 'data' in data && 'metadata' in data;
    const inner = (isKv2 ? (data as { data?: unknown }).data : data) as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      throw new ConfigError([{ path: p, from: name, message: 'E_SHAPE: missing data' }], 'E_SHAPE');
    }
    return normalizeSecretMap(inner, name);
  }

  return {
    name,
    load(): Promise<Flat> {
      // Single-flight refresh
      if (!inflight) {
        inflight = doLoad().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
