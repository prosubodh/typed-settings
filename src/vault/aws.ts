/**
 * AWS provider: Secrets Manager ids plus SSM parameters (with decryption)
 * merged into one flat map. SDK clients are injected, never imported blindly,
 * so tests can pass fakes and Edge bundles stay lean.
 *
 * @module
 */
import type { Flat, SecretProvider } from '../types.js';
import { ConfigError, byteLengthUtf8 } from '../errors.js';
import { assertPositive, normalizeSecretMap } from './shared.js';

/** Minimal Secrets Manager surface this provider needs (real SDK client or a fake). */
export interface AwsSecretsClient {
  getSecretValue(secretId: string): Promise<
    | { SecretString?: string; SecretBinary?: Uint8Array | string }
    | string
  >;
}

/** Minimal SSM surface this provider needs (real SDK client or a fake). */
export interface AwsSsmClient {
  getParameters(names: string[], withDecryption?: boolean): Promise<Record<string, string>>;
}

/** Options for {@link awsProvider}. */
export interface AwsProviderOptions {
  /** Secrets Manager ids. */
  secrets?: string[]; // Secrets Manager ids
  /** SSM names or path prefixes (trailing `/` optional). */
  params?: string[]; // SSM paths (exact names or path prefixes ending in /)
  /** Reserved: region override (currently from env `AWS_REGION`). */
  region?: string; // IGNORED: configure region on your injected SDK client instead
  /** Reserved: VersionId / stage pin. */
  versionId?: string; // IGNORED: version pinning is not implemented; latest is always read
  /** Applies to the whole `load()`. Default 5000. */
  timeoutMs?: number; // default 5000 (applies to load())
  /** Injected Secrets Manager client (or test fake); missing throws `E_NO_SDK`. */
  secretsClient?: AwsSecretsClient; // injectable (tests); else dynamic SDK import
  /** Injected SSM client (or test fake); missing throws `E_NO_SDK`. */
  ssmClient?: AwsSsmClient;
  /** Secrets Manager value cap in bytes. Default 64 KiB. */
  maxBytesSecret?: number; // default 64kb (SM cap)
  /** SSM value cap in bytes. Default 8 KiB. */
  maxBytesParam?: number; // default 8kb (SSM cap)
}

async function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new ConfigError([{ path: name, from: name, message: 'E_TIMEOUT' }], 'E_TIMEOUT')),
      ms,
    );
  });
  // Suppress unhandled rejection if the timeout wins and the client call
  // settles later (fatal under --unhandled-rejections=strict otherwise).
  // The race below still observes the original outcome.
  void p.catch(() => {});
  try {
    return await Promise.race([p, timeout]);
  } finally {
    // clearTimeout tolerates undefined — no branch needed.
    clearTimeout(timer);
  }
}

/** Defer a client call so synchronous throws become rejections (mapped below). */
function deferred<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(fn);
}

function wrapClientError(e: unknown, path: string, from: string): never {
  if (e instanceof ConfigError) throw e;
  const err = e as Error;
  throw new ConfigError(
    [{ path, from, message: `E_UPSTREAM: ${err?.message ?? String(e)}` }],
    'E_UPSTREAM',
  );
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBinary(b: Uint8Array | string, path: string, from: string): string {
  if (typeof b === 'string') {
    // SecretBinary-as-string must be valid base64 — garbage would decode silently.
    // The alphabet + length guards make decoding infallible below (no try/catch).
    const compact = b.replace(/\s/g, '');
    if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
      throw new ConfigError([{ path, from, message: 'E_SHAPE: SecretBinary is not valid base64' }], 'E_SHAPE');
    }
    return utf8FromBase64(compact);
  }
  const g = globalThis as { Buffer?: { from(b: Uint8Array, e: string): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(b, 'binary').toString('utf8');
  // Non-UTF8 bytes must not silently become U+FFFD replacement characters
  // stored as if they were the secret: fail closed instead.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new ConfigError([{ path, from, message: 'E_SHAPE: SecretBinary is not valid UTF-8' }], 'E_SHAPE');
  }
}

/** Base64 -> UTF-8 without `node:buffer` (Edge-safe: Buffer -> atob fallback). */
function utf8FromBase64(compact: string): string {
  const g = globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } }; atob?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(compact, 'base64').toString('utf8');
  if (g.atob) {
    const bin = g.atob(compact);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // No decoder available — fail closed, never return garbage.
  throw new ConfigError([{ path: '<aws>', from: 'aws', message: 'E_NO_SDK: no base64 decoder (Buffer/atob) available' }], 'E_NO_SDK');
}

/**
 * Merges Secrets Manager values (JSON objects merge, scalars key on the last id
 * segment) with SSM parameters (longest-prefix strip, `/` to `__`, uppercased).
 * Concurrent `load()` calls share one in-flight request.
 */
export function awsProvider(opts: AwsProviderOptions): SecretProvider {
  const name = `aws://${(opts.secrets ?? []).join(',')}${(opts.params ?? []).join(',') || 'ssm'}`;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxSecret = opts.maxBytesSecret ?? 64 * 1024;
  const maxParam = opts.maxBytesParam ?? 8 * 1024;
  assertPositive(timeoutMs, 'timeoutMs', name);
  assertPositive(maxSecret, 'maxBytesSecret', name);
  assertPositive(maxParam, 'maxBytesParam', name);
  let inflight: Promise<Flat> | null = null;
  // Whole-load budget share: set when doLoad starts (always assigned before use).
  let remainingMs!: () => number;

  async function loadSecrets(): Promise<Flat> {
    const out: Flat = {};
    if (!opts.secrets?.length) return out;
    if (!opts.secretsClient) {
      throw new ConfigError(
        [{ path: '<aws>', from: name, message: 'E_NO_SDK: inject secretsClient (peer @aws-sdk/client-secrets-manager)' }],
        'E_NO_SDK',
      );
    }
    for (const id of opts.secrets) {
      let raw: { SecretString?: string; SecretBinary?: Uint8Array | string } | string;
      try {
        raw = await withTimeout(deferred(() => opts.secretsClient!.getSecretValue(id)), remainingMs(), name);
      } catch (e) {
        wrapClientError(e, id, name);
      }
      if (typeof raw === 'string') {
        if (byteLengthUtf8(raw) > maxSecret) throw new ConfigError([{ path: id, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
        // Try JSON object merge, else single value keyed by last segment.
        // (JSON.parse is iterative in V8 — hostile depth parses fine and any
        // nesting is bounded downstream by the pipeline's E_DEPTH guard.)
        // Only the parse is guarded: an E_COLLISION from the merge must escape.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = undefined; // not JSON — the raw string is the value
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          mergeOrThrow(out, normalizeSecretMap(parsed, `${name}/${id}`), `${name}/${id}`);
          continue;
        }
        emitSecret(out, id, raw);
        continue;
      }
      const { SecretString, SecretBinary } = raw;
      if (SecretString !== undefined && SecretBinary !== undefined) {
        throw new ConfigError([{ path: id, from: name, message: 'E_SHAPE: SecretString XOR SecretBinary' }], 'E_SHAPE');
      }
      if (SecretString === undefined && SecretBinary === undefined) {
        throw new ConfigError([{ path: id, from: name, message: 'E_SHAPE: neither SecretString nor SecretBinary present' }], 'E_SHAPE');
      }
      if (SecretString !== undefined) {
        if (byteLengthUtf8(SecretString) > maxSecret) throw new ConfigError([{ path: id, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
        // Only the parse is guarded: an E_COLLISION from the merge must escape.
        let parsed: unknown;
        try {
          parsed = JSON.parse(SecretString) as unknown;
        } catch {
          parsed = undefined; // plain strings stay raw (see note above)
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          mergeOrThrow(out, normalizeSecretMap(parsed, `${name}/${id}`), `${name}/${id}`);
          continue;
        }
        emitSecret(out, id, SecretString);
      } else if (SecretBinary !== undefined) {
        const decoded = decodeBinary(SecretBinary, id, name);
        if (byteLengthUtf8(decoded) > maxSecret) throw new ConfigError([{ path: id, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
        emitSecret(out, id, decoded);
      }
    }
    return out;
  }

  /** Non-empty last path segment, uppercased (''-safe: falls back to the full id). */
  function lastSegment(id: string): string {
    const segs = id.split('/').filter((s) => s.length > 0);
    return (segs.length > 0 ? segs[segs.length - 1]! : id).toUpperCase();
  }

  /** Stores one secrets-manager value, skipping unmappable (empty) keys. */
  function emitSecret(out: Flat, id: string, value: string): void {
    const key = lastSegment(id);
    // An empty id (or all-slash id) maps to '': emitting it would poison
    // downstream prefix/__ handling, so skip it instead.
    if (!key) return;
    setOrThrow(out, key, value.replace(/\r?\n$/, ''), id);
  }

  /** One key, one owner: duplicate mappings must fail closed, never last-wins. */
  function setOrThrow(out: Flat, key: string, value: string, from: string): void {
    if (key in out) {
      throw new ConfigError(
        [{ path: key, from, message: 'E_COLLISION: two secrets/params map to the same key — rename one or narrow the params prefix' }],
        'E_COLLISION',
      );
    }
    out[key] = value;
  }

  /** Collision-aware merge for multi-key payloads (JSON secrets, SSM maps). */
  function mergeOrThrow(out: Flat, add: Flat, from: string): void {
    // normalizeSecretMap/SSM maps never carry undefined values (`null`/`undefined`
    // entries are dropped upstream) — the `!` is a Flat-shape shim, not a coercion.
    for (const [k, v] of Object.entries(add)) setOrThrow(out, k, v!, from);
  }

  function stripParamPrefix(paramName: string, requested: string[]): string {
    // Longest requested-prefix match. A requested entry acts as a directory prefix
    // with or without trailing slash; an exact match yields the basename.
    // Params outside every requested entry/prefix fall back to the basename.
    if (!paramName) return '';
    let best = '';
    for (const r of requested) {
      if (!r) continue;
      if (paramName === r) {
        // Exact match on a directory-style entry ('/app/') is the prefix itself,
        // not a parameter — skip it. Exact file-style entries yield the basename
        // (a non-empty r without trailing slash always has one — hence `!`).
        if (r.endsWith('/')) return '';
        return r.split('/').filter((s) => s.length > 0).pop()!;
      }
      const dirPrefix = r.endsWith('/') ? r : `${r}/`;
      if (paramName.startsWith(dirPrefix) && dirPrefix.length > best.length) best = dirPrefix;
    }
    const rest = best ? paramName.slice(best.length) : (paramName.split('/').filter((s) => s.length > 0).pop() ?? paramName);
    return rest.replace(/\//g, '__');
  }

  async function loadParams(): Promise<Flat> {
    const out: Flat = {};
    if (!opts.params?.length) return out;
    if (!opts.ssmClient) {
      throw new ConfigError(
        [{ path: '<aws>', from: name, message: 'E_NO_SDK: inject ssmClient (peer @aws-sdk/client-ssm)' }],
        'E_NO_SDK',
      );
    }
    // WithDecryption:true is enforced by the real SDK call; injected test clients emulate it.
    let map: Record<string, string>;
    try {
      map = await withTimeout(
        deferred(() => opts.ssmClient!.getParameters(opts.params!, true)),
        remainingMs(),
        name,
      );
    } catch (e) {
      wrapClientError(e, '<ssm>', name);
    }
    for (const [fullName, value] of Object.entries(map!)) {
      if (byteLengthUtf8(value) > maxParam) throw new ConfigError([{ path: fullName, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
      const key = stripParamPrefix(fullName, opts.params!).toUpperCase();
      if (!key) continue; // unmappable name (e.g. the queried prefix itself) — never emit ''
      setOrThrow(out, key, value.replace(/\r?\n$/, ''), fullName);
    }
    return out;
  }

  async function doLoad(): Promise<Flat> {
    // Whole-load budget: N secrets + SSM share one `timeoutMs` deadline instead
    // of each getting a full budget (N*timeoutMs total before).
    const deadline = Date.now() + timeoutMs;
    remainingMs = () => Math.max(1, deadline - Date.now());
    const [s, p] = await Promise.all([loadSecrets(), loadParams()]);
    // Secrets-then-params: a param mapping to a secret's key is a collision
    // too (the two layers are independent), never a silent last-wins.
    const out: Flat = { ...s };
    mergeOrThrow(out, p, name);
    return out;
  }

  void opts.region;
  void opts.versionId;

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
