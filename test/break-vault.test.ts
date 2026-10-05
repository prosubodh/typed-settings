import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settingsAsync, ConfigError } from '../src/index.js';
import { hashicorpProvider } from '../src/vault/hashicorp.js';
import { httpProvider } from '../src/vault/http.js';
import { awsProvider } from '../src/vault/aws.js';
import { fetchWithRedirectGuard, normalizeSecretMap, statusToCode, getFetch } from '../src/vault/shared.js';

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

describe('break: redirect guard', () => {
  it('strips ALL sensitive headers cross-host, keeps the rest', async () => {
    const seen: Record<string, string | null> = {};
    let n = 0;
    const f = async (u: string, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response('', { status: 302, headers: { location: 'https://evil.test/x' } });
      const h = new Headers(init?.headers);
      for (const k of ['authorization', 'x-vault-token', 'x-api-key', 'cookie', 'x-custom-token', 'accept', 'x-plain']) {
        seen[k] = h.get(k);
      }
      return new Response('{}', { status: 200 });
    };
    await fetchWithRedirectGuard(
      'https://a.test/',
      { headers: new Headers({ Authorization: 'b', 'X-Vault-Token': 'v', 'X-Api-Key': 'k', Cookie: 'c', 'X-Custom-Token': 't', Accept: 'application/json', 'X-Plain': 'p' }) },
      f,
    );
    expect(seen['authorization']).toBeNull();
    expect(seen['x-vault-token']).toBeNull();
    expect(seen['x-api-key']).toBeNull();
    expect(seen['cookie']).toBeNull();
    expect(seen['x-custom-token']).toBeNull();
    expect(seen['accept']).toBe('application/json');
    expect(seen['x-plain']).toBe('p');
  });

  it('same-host redirects keep auth; missing location ends the chain', async () => {
    let calls = 0;
    const f = async (u: string, init?: RequestInit) => {
      calls++;
      if (u === 'https://a.test/1') return new Response('', { status: 302, headers: { location: '/2' } });
      if (u === 'https://a.test/2') return new Response('', { status: 302 });
      return new Response('{}', { status: 200 });
    };
    const res = await fetchWithRedirectGuard('https://a.test/1', { headers: new Headers({ Authorization: 'b' }) }, f);
    expect(res.status).toBe(302); // no Location: chain ends, response returned
    expect(calls).toBe(2);
  });

  it('exhausted redirects and invalid Location fail closed', async () => {
    const loop = async () => new Response('', { status: 302, headers: { location: '/x' } });
    await expect(fetchWithRedirectGuard('https://a.test/', {}, loop, 1)).rejects.toMatchObject({ code: 'E_REDIRECT' });
    const badLoc = async () => new Response('', { status: 302, headers: { location: 'http://%zz' } });
    await expect(
      hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: badLoc }).load(),
    ).rejects.toMatchObject({ code: 'E_REDIRECT' });
    // A non-positive budget settles without any fetch: nothing is followed, fail closed.
    let called = 0;
    const spy = async () => {
      called++;
      return new Response('{}', { status: 200 });
    };
    await expect(fetchWithRedirectGuard('https://a.test/', {}, spy, -1)).rejects.toMatchObject({ code: 'E_REDIRECT' });
    expect(called).toBe(0);
  });

  it('no global fetch surfaces E_NO_FETCH', () => {
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    delete g.fetch;
    try {
      expect(() => getFetch()).toThrow(/E_NO_FETCH/);
    } finally {
      g.fetch = saved;
    }
  });

  it('falls back to the global fetch when no fetchFn is injected', async () => {
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    g.fetch = (async () => json({ data: { Q: '9' }, metadata: {} })) as unknown;
    try {
      const prov = hashicorpProvider({ url: 'https://v.test', path: 'p' });
      await expect(prov.load()).resolves.toEqual({ Q: '9' });
    } finally {
      g.fetch = saved;
    }
  });

  it('statusToCode mapping is pinned', () => {
    expect([statusToCode(401), statusToCode(403), statusToCode(404), statusToCode(429), statusToCode(500), statusToCode(400)]).toEqual([
      'E_DENIED', 'E_DENIED', 'E_NOT_FOUND', 'E_THROTTLED', 'E_UPSTREAM', 'E_PROVIDER',
    ]);
  });
});

describe('break: normalizeSecretMap', () => {
  it('rejects non-object roots, skips nulls, trims one newline', () => {
    expect(() => normalizeSecretMap([1], 't')).toThrow(/E_SHAPE/);
    expect(() => normalizeSecretMap('str', 't')).toThrow(/E_SHAPE/);
    expect(normalizeSecretMap({ A: null, B: undefined, C: 'x\n' }, 't')).toEqual({ C: 'x' });
    // Only ONE trailing newline is trimmed (pinned).
    expect(normalizeSecretMap({ A: 'x\n\n' }, 't')).toEqual({ A: 'x\n' });
    // Arrays stringify (documented): coerce splits them back for string[] targets.
    expect(normalizeSecretMap({ L: ['a', 'b'] }, 't')).toEqual({ L: 'a,b' });
    // Nested objects are preserved for __ expansion downstream.
    expect(normalizeSecretMap({ DB: { HOST: 'h' } }, 't')).toEqual({ DB: { HOST: 'h' } });
    expect(normalizeSecretMap({ N: 0 }, 't')).toEqual({ N: '0' });
    // Trimming is opt-out (kept verbatim for pre-trimmed secret stores).
    expect(normalizeSecretMap({ A: 'x\n' }, 't', { trimNewline: false })).toEqual({ A: 'x\n' });
  });
});

describe('break: hashicorp unwrap matrix', () => {
  const load = (body: unknown, status = 200) =>
    hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: async () => json(body, status) }).load();

  it('KVv1 key literally named data does NOT unwrap', async () => {
    await expect(load({ data: { data: { x: 1 }, other: 'y' } })).resolves.toEqual({ data: { x: 1 }, other: 'y' });
  });

  it('KVv2 data.data null/string with metadata sibling is E_SHAPE', async () => {
    await expect(load({ data: { data: null, metadata: {} } })).rejects.toMatchObject({ code: 'E_SHAPE' });
    await expect(load({ data: { data: 's', metadata: {} } })).rejects.toMatchObject({ code: 'E_SHAPE' });
  });

  it('missing/invalid payloads are E_SHAPE/E_PARSE, never partial', async () => {
    await expect(load({ nodata: 1 })).rejects.toMatchObject({ code: 'E_SHAPE' });
    await expect(load([1, 2])).rejects.toMatchObject({ code: 'E_SHAPE' });
    const bad = hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: async () => new Response('not-json', { status: 200 }) });
    await expect(bad.load()).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('multibyte bodies are capped by bytes', async () => {
    const big = 'é'.repeat(1024); // 1k chars, 2k bytes
    const prov = hashicorpProvider({ url: 'https://v.test', path: 'p', maxBytes: 1500, fetchFn: async () => json({ data: { K: big } }) });
    await expect(prov.load()).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
  });

  it('explicit empty token sends no credential (no env fallback)', async () => {
    process.env['VAULT_TOKEN'] = 'envtok';
    let got: string | null = 'unset';
    const f = async (_u: string, init?: RequestInit) => {
      got = new Headers(init?.headers).get('x-vault-token');
      return json({ data: { A: '1' }, metadata: {} });
    };
    try {
      await hashicorpProvider({ url: 'https://v.test', path: 'p', auth: { token: '' }, fetchFn: f }).load();
      expect(got).toBeNull();
      // ...while explicit and env tokens ARE sent.
      await hashicorpProvider({ url: 'https://v.test', path: 'p', auth: { token: 'abc' }, fetchFn: f }).load();
      expect(got).toBe('abc');
      await hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: f }).load();
      expect(got).toBe('envtok');
    } finally {
      delete process.env['VAULT_TOKEN'];
    }
  });

  it('single-flight coalesces concurrent loads; failures reset', async () => {
    let n = 0;
    const f = async () => {
      n++;
      await new Promise((r) => setTimeout(r, 10));
      return json({ data: { A: '1' }, metadata: {} });
    };
    const p = hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: f });
    await Promise.all([p.load(), p.load()]);
    expect(n).toBe(1);
    let m = 0;
    const flaky = async () => {
      m++;
      if (m === 1) return new Response('x', { status: 500 });
      return json({ data: { A: '1' }, metadata: {} });
    };
    const p2 = hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: flaky });
    await expect(p2.load()).rejects.toMatchObject({ code: 'E_UPSTREAM' });
    await expect(p2.load()).resolves.toEqual({ A: '1' });
    expect(m).toBe(2);
  });

  it('timeouts and connection failures map distinctly', async () => {
    // A fetch that honors AbortSignal (like real fetch): the provider's
    // AbortSignal.timeout must surface E_TIMEOUT instead of hanging boot.
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, rej) => {
        if (init?.signal?.aborted) rej(new DOMException('TimeoutError', 'TimeoutError'));
        else init?.signal?.addEventListener('abort', () => rej(new DOMException('TimeoutError', 'TimeoutError')));
      });
    await expect(
      hashicorpProvider({ url: 'https://v.test', path: 'p', timeoutMs: 30, fetchFn: hanging }).load(),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    const conn = async () => {
      throw new Error('socket hang up');
    };
    await expect(hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: conn }).load()).rejects.toMatchObject({
      code: 'E_CONN',
    });
    const strThrow = async () => {
      throw 'string failure';
    };
    await expect(hashicorpProvider({ url: 'https://v.test', path: 'p', fetchFn: strThrow }).load()).rejects.toMatchObject({
      code: 'E_CONN',
    });
  });

  it('pinned version is sent as a query param', async () => {
    let seen = '';
    const f = async (u: string) => {
      seen = u;
      return json({ data: { A: '1' }, metadata: {} });
    };
    await hashicorpProvider({ url: 'https://v.test/', path: '/p', version: 3, fetchFn: f }).load();
    expect(seen).toContain('?version=3');
  });
});

describe('break: http provider', () => {
  it('jsonPath "" reads the root; dotted paths traverse', async () => {
    const root = httpProvider({ url: 'https://h', jsonPath: '', fetchFn: async () => json({ A: '1' }) });
    await expect(root.load()).resolves.toEqual({ A: '1' });
    const nested = httpProvider({ url: 'https://h', jsonPath: 'a.b', fetchFn: async () => json({ a: { b: { C: '2' } } }) });
    await expect(nested.load()).resolves.toEqual({ C: '2' });
    // A path through a scalar resolves to E_SHAPE, never undefined-spread.
    const throughScalar = httpProvider({ url: 'https://h', jsonPath: 'a.b.c', fetchFn: async () => json({ a: 'scalar' }) });
    await expect(throughScalar.load()).rejects.toMatchObject({ code: 'E_SHAPE' });
  });

  it('data/data collision without metadata does NOT unwrap', async () => {
    const prov = httpProvider({ url: 'https://h', fetchFn: async () => json({ data: { data: { a: 1 }, b: 2 } }) });
    // `b` survives (numbers stringify through the Flat map — documented).
    await expect(prov.load()).resolves.toEqual({ data: { a: 1 }, b: '2' });
    // A real KVv2 envelope (metadata sibling) DOES unwrap.
    const kv2 = httpProvider({ url: 'https://h', fetchFn: async () => json({ data: { data: { Q: '1' }, metadata: {} } }) });
    await expect(kv2.load()).resolves.toEqual({ Q: '1' });
  });

  it('{data:null} is E_SHAPE and errors never carry bodies', async () => {
    const prov = httpProvider({ url: 'https://h', fetchFn: async () => json({ data: null }) });
    await expect(prov.load()).rejects.toMatchObject({ code: 'E_SHAPE' });
    try {
      await prov.load();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('null');
      expect((e as ConfigError).code).toBe('E_SHAPE');
    }
  });

  it('status codes map like hashicorp', async () => {
    for (const [status, code] of [[403, 'E_DENIED'], [404, 'E_NOT_FOUND'], [429, 'E_THROTTLED'], [500, 'E_UPSTREAM'], [400, 'E_PROVIDER']] as const) {
      const prov = httpProvider({ url: 'https://h', fetchFn: async () => new Response('', { status }) });
      await expect(prov.load()).rejects.toMatchObject({ code });
    }
  });

  it('timeouts, connections, caps and bad JSON map distinctly', async () => {
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, rej) => {
        if (init?.signal?.aborted) rej(new DOMException('TimeoutError', 'TimeoutError'));
        else init?.signal?.addEventListener('abort', () => rej(new DOMException('TimeoutError', 'TimeoutError')));
      });
    await expect(httpProvider({ url: 'https://h', timeoutMs: 30, fetchFn: hanging }).load()).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
    const conn = async () => {
      throw new Error('socket hang up');
    };
    await expect(httpProvider({ url: 'https://h', fetchFn: conn }).load()).rejects.toMatchObject({ code: 'E_CONN' });
    // Non-Error throws stringify instead of crashing on .message access.
    const strThrow = async () => {
      throw 'string failure';
    };
    await expect(httpProvider({ url: 'https://h', fetchFn: strThrow }).load()).rejects.toMatchObject({ code: 'E_CONN' });
    // ConfigErrors (e.g. redirect exhaustion) pass through unwrapped.
    const loop = async () => new Response('', { status: 302, headers: { location: '/x' } });
    await expect(httpProvider({ url: 'https://h', fetchFn: loop }).load()).rejects.toMatchObject({ code: 'E_REDIRECT' });
    const big = httpProvider({ url: 'https://h', maxBytes: 10, fetchFn: async () => json({ data: { K: 'x'.repeat(100) } }) });
    await expect(big.load()).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
    const bad = httpProvider({ url: 'https://h', fetchFn: async () => new Response('nope', { status: 200 }) });
    await expect(bad.load()).rejects.toMatchObject({ code: 'E_PARSE' });
  });
});

describe('break: aws provider', () => {
  it('empty secret object is E_SHAPE, not silent {}', async () => {
    const c = { getSecretValue: async () => ({}) };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: c }).load()).rejects.toMatchObject({ code: 'E_SHAPE' });
  });

  it('synchronous client throws map to E_UPSTREAM', async () => {
    const c = {
      getSecretValue: () => {
        throw new Error('boom');
      },
    };
    await expect(awsProvider({ secrets: ['x'], secretsClient: c as never }).load()).rejects.toMatchObject({ code: 'E_UPSTREAM' });
    const cStr = {
      getSecretValue: () => {
        throw 'string failure';
      },
    };
    await expect(awsProvider({ secrets: ['x'], secretsClient: cStr as never }).load()).rejects.toMatchObject({ code: 'E_UPSTREAM' });
    const c2 = {
      getParameters: () => {
        throw new Error('ssm boom');
      },
    };
    await expect(awsProvider({ params: ['/a'], ssmClient: c2 as never }).load()).rejects.toMatchObject({ code: 'E_UPSTREAM' });
  });

  it('missing SDK clients explain themselves', async () => {
    await expect(awsProvider({ secrets: ['a'] }).load()).rejects.toMatchObject({ code: 'E_NO_SDK' });
    await expect(awsProvider({ params: ['/a'] }).load()).rejects.toMatchObject({ code: 'E_NO_SDK' });
  });

  it('param prefix without trailing slash still nests; exact dir path is skipped', async () => {
    const ssm = { getParameters: async () => ({ '/app/prod/a/b': 'v' }) };
    await expect(awsProvider({ params: ['/app/prod'], ssmClient: ssm }).load()).resolves.toEqual({ A__B: 'v' });
    const ssm2 = { getParameters: async () => ({ '/app/': 'v' }) };
    await expect(awsProvider({ params: ['/app/'], ssmClient: ssm2 }).load()).resolves.toEqual({});
    // Exact file-style match yields the basename; '' requested entries are ignored.
    const ssm3 = { getParameters: async () => ({ '/app/prod': 'w' }) };
    await expect(awsProvider({ params: ['/app/prod'], ssmClient: ssm3 }).load()).resolves.toEqual({ PROD: 'w' });
    const ssm4 = { getParameters: async () => ({ '/x': 'v' }) };
    await expect(awsProvider({ params: [''], ssmClient: ssm4 }).load()).resolves.toEqual({ X: 'v' });
  });

  it('invalid base64 SecretBinary is E_SHAPE; Uint8Array decodes', async () => {
    const bad = { getSecretValue: async () => ({ SecretBinary: '!!!not-b64!!!' }) };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: bad }).load()).rejects.toMatchObject({ code: 'E_SHAPE' });
    const bin = { getSecretValue: async () => ({ SecretBinary: new TextEncoder().encode('hi') }) };
    await expect(awsProvider({ secrets: ['a/B'], secretsClient: bin as never }).load()).resolves.toEqual({ B: 'hi' });
  });

  it('raw values keep one trailing newline trimmed (pinned parity)', async () => {
    const c = { getSecretValue: async () => 'plain\n\n' };
    await expect(awsProvider({ secrets: ['a/B'], secretsClient: c }).load()).resolves.toEqual({ B: 'plain\n' });
    const arr = { getSecretValue: async () => '[1,2]' };
    await expect(awsProvider({ secrets: ['a/k'], secretsClient: arr }).load()).resolves.toEqual({ K: '[1,2]' });
  });

  it('trailing-slash secret ids key on the last non-empty segment', async () => {
    const c = { getSecretValue: async () => 'v' };
    await expect(awsProvider({ secrets: ['a/b/'], secretsClient: c }).load()).resolves.toEqual({ B: 'v' });
  });

  it('raw string secrets that parse as objects merge; XOR violations fail', async () => {
    const obj = { getSecretValue: async () => '{"K":"v"}' };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: obj }).load()).resolves.toEqual({ K: 'v' });
    const both = { getSecretValue: async () => ({ SecretString: 'a', SecretBinary: new Uint8Array([1]) }) };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: both as never }).load()).rejects.toMatchObject({
      code: 'E_SHAPE',
    });
  });

  it('string SecretBinary must be well-formed base64', async () => {
    const badLen = { getSecretValue: async () => ({ SecretBinary: 'abc' }) };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: badLen }).load()).rejects.toMatchObject({ code: 'E_SHAPE' });
    const good = { getSecretValue: async () => ({ SecretBinary: Buffer.from('hey').toString('base64') }) };
    await expect(awsProvider({ secrets: ['a/B'], secretsClient: good }).load()).resolves.toEqual({ B: 'hey' });
  });

  it('size caps apply to every secret shape', async () => {
    const big = 'x'.repeat(100);
    const s1 = { getSecretValue: async () => big };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: s1, maxBytesSecret: 10 }).load()).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
    const sStr = { getSecretValue: async () => ({ SecretString: big }) };
    await expect(
      awsProvider({ secrets: ['a/b'], secretsClient: sStr, maxBytesSecret: 10 }).load(),
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
    const s2 = { getSecretValue: async () => ({ SecretBinary: new TextEncoder().encode(big) }) };
    await expect(awsProvider({ secrets: ['a/b'], secretsClient: s2 as never, maxBytesSecret: 10 }).load()).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
    const ssm = { getParameters: async () => ({ '/a': big }) };
    await expect(awsProvider({ params: ['/a'], ssmClient: ssm, maxBytesParam: 10 }).load()).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
  });

  it('degenerate ids and prefixes degrade gracefully', async () => {
    const c = { getSecretValue: async () => 'v' };
    // No non-empty segments: the id itself is the key (pinned, never '').
    await expect(awsProvider({ secrets: ['///'], secretsClient: c }).load()).resolves.toEqual({ '///': 'v' });
    const ssm = { getParameters: async () => ({ '/a/b': 'v', '/other': 'w', '///': 's', '': 'e' }) };
    // '' requested entry is ignored; exact file-style match yields the basename;
    // foreign params fall back to their basename. A path of only slashes maps
    // every '/' to '__' ('///' -> '______').
    await expect(awsProvider({ params: ['', '/a/b'], ssmClient: ssm }).load()).resolves.toEqual({ B: 'v', OTHER: 'w', ______: 's' });
  });

  it('timeouts race the SDK call', async () => {
    const slow = { getSecretValue: () => new Promise<never>(() => {}) };
    await expect(awsProvider({ secrets: ['x'], secretsClient: slow as never, timeoutMs: 20 }).load()).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
  });

  it('end-to-end through settingsAsync with prefix', async () => {
    const prov = awsProvider({
      secrets: ['prod/app'],
      secretsClient: { getSecretValue: async () => ({ SecretString: JSON.stringify({ APP_PORT: '9000' }) }) },
    });
    const schema = z.object({ port: z.coerce.number().default(0) });
    const cfg = await settingsAsync({
      schema,
      sources: [{ provider: prov, prefix: 'APP_' }],
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(9000);
  });
});
