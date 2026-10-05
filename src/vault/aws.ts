import type { Flat, SecretProvider } from '../types.js';
import { ConfigError, byteLengthUtf8 } from '../errors.js';
import { normalizeSecretMap } from './shared.js';

export interface AwsSecretsClient {
  getSecretValue(secretId: string): Promise<
    | { SecretString?: string; SecretBinary?: Uint8Array | string }
    | string
  >;
}

export interface AwsSsmClient {
  getParameters(names: string[], withDecryption?: boolean): Promise<Record<string, string>>;
}

export interface AwsProviderOptions {
  secrets?: string[]; // Secrets Manager ids
  params?: string[]; // SSM paths (exact names or path prefixes ending in /)
  region?: string; // from env AWS_REGION if omitted
  versionId?: string; // pin VersionId / stage
  timeoutMs?: number; // default 5000 (applies to load())
  secretsClient?: AwsSecretsClient; // injectable (tests); else dynamic SDK import
  ssmClient?: AwsSsmClient;
  maxBytesSecret?: number; // default 64kb (SM cap)
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
    // The alphabet + length guards make Buffer.from infallible below (no try/catch).
    const compact = b.replace(/\s/g, '');
    if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
      throw new ConfigError([{ path, from, message: 'E_SHAPE: SecretBinary is not valid base64' }], 'E_SHAPE');
    }
    return Buffer.from(compact, 'base64').toString('utf8');
  }
  return Buffer.from(b).toString('utf8');
}

export function awsProvider(opts: AwsProviderOptions): SecretProvider {
  const name = `aws://${(opts.secrets ?? []).join(',')}${(opts.params ?? []).join(',') || 'ssm'}`;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxSecret = opts.maxBytesSecret ?? 64 * 1024;
  const maxParam = opts.maxBytesParam ?? 8 * 1024;
  let inflight: Promise<Flat> | null = null;

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
        raw = await withTimeout(deferred(() => opts.secretsClient!.getSecretValue(id)), timeoutMs, name);
      } catch (e) {
        wrapClientError(e, id, name);
      }
      if (typeof raw === 'string') {
        if (byteLengthUtf8(raw) > maxSecret) throw new ConfigError([{ path: id, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
        // Try JSON object merge, else single value keyed by last segment
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(out, normalizeSecretMap(parsed, `${name}/${id}`));
            continue;
          }
        } catch {
          // fall through to raw
        }
        out[lastSegment(id)] = raw.replace(/\r?\n$/, '');
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
        try {
          const parsed = JSON.parse(SecretString) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(out, normalizeSecretMap(parsed, `${name}/${id}`));
            continue;
          }
        } catch {
          // raw string
        }
        out[lastSegment(id)] = SecretString.replace(/\r?\n$/, '');
      } else if (SecretBinary !== undefined) {
        const decoded = decodeBinary(SecretBinary, id, name);
        if (byteLengthUtf8(decoded) > maxSecret) throw new ConfigError([{ path: id, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
        out[lastSegment(id)] = decoded.replace(/\r?\n$/, '');
      }
    }
    return out;
  }

  /** Non-empty last path segment, uppercased (''-safe: falls back to the full id). */
  function lastSegment(id: string): string {
    const segs = id.split('/').filter((s) => s.length > 0);
    return (segs.length > 0 ? segs[segs.length - 1]! : id).toUpperCase();
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
        timeoutMs,
        name,
      );
    } catch (e) {
      wrapClientError(e, '<ssm>', name);
    }
    for (const [fullName, value] of Object.entries(map!)) {
      if (byteLengthUtf8(value) > maxParam) throw new ConfigError([{ path: fullName, from: name, message: 'E_TOO_LARGE' }], 'E_TOO_LARGE');
      const key = stripParamPrefix(fullName, opts.params!).toUpperCase();
      if (!key) continue; // unmappable name (e.g. the queried prefix itself) — never emit ''
      out[key] = value.replace(/\r?\n$/, '');
    }
    return out;
  }

  async function doLoad(): Promise<Flat> {
    const [s, p] = await Promise.all([loadSecrets(), loadParams()]);
    return { ...s, ...p };
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
