import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, settingsAsync, ConfigError } from '../src/index.js';

const inject = (files: Record<string, string>) => {
  (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
    readFileSync: (p: string) => {
      if (p in files) return files[p];
      const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    },
  };
};
const uninject = () => {
  delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
};

describe('break3: async source spellings', () => {
  it('missing .env, string paths and {file} are skipped in async mode', async () => {
    inject({ 'keep.env': 'Q=qval' });
    try {
      const prov = { name: 'p', load: async () => ({ P: 'v' }) };
      const schema = z.object({ p: z.string().default(''), q: z.string().default('') });
      const out = await settingsAsync({
        schema,
        sources: ['.env', '.env.local', 'gone.env', { file: 'missing.json' }, 'keep.env', { provider: prov }],
        env: {},
        expand: false,
        coerce: false,
      });
      expect(out.p).toBe('v');
      expect(out.q).toBe('qval');
    } finally {
      uninject();
    }
  });

  it('missing {file} is skipped in sync mode; sync {provider,prefix} strips', () => {
    inject({});
    try {
      const schema = z.object({ port: z.coerce.number().default(0) });
      expect(settings({ schema, sources: [{ file: 'missing.json' }], env: {}, expand: false }).port).toBe(0);
      const prov = { name: 'v', load: () => ({ APP_PORT: '4321' }) };
      expect(
        settings({ schema, sources: [{ provider: prov, prefix: 'APP_' }], env: {}, expand: false }).port,
      ).toBe(4321);
    } finally {
      uninject();
    }
  });

  it('async null providers contribute nothing; string throws map to E_PROVIDER', async () => {
    const nil = { name: 'nil', load: async () => null };    const schema = z.object({ a: z.string().default('d') });
    expect(
      (await settingsAsync({ schema, sources: [{ provider: nil } as never], env: {}, expand: false, coerce: false }))
        .a,
    ).toBe('d');
    const strThrow = {
      name: 's',
      load: () => {
        throw 'string failure';
      },
    };
    await expect(
      settingsAsync({ schema: z.object({}), sources: [{ provider: strThrow }], env: {} }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER' });
  });

  it('root-level issues attribute to schema in both modes', async () => {
    const root = {
      '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ message: 'root bad' }] }) },
    };
    for (const from of [
      () => settings({ schema: root as never, sources: [{ map: {} }], env: {}, expand: false, coerce: false }),
      () => settingsAsync({ schema: root as never, sources: [{ map: {} }], env: {}, expand: false, coerce: false }),
    ]) {
      try {
        await from();
        expect.unreachable();
      } catch (e) {
        expect((e as ConfigError).issues[0]).toMatchObject({ path: '<root>', from: 'schema' });
      }
    }
  });

  it('lookup stringifies numbers and falls back through the env snapshot', () => {
    // N is numeric in the merged layer -> String(5); U is undefined -> env miss -> default.
    const out = settings({
      schema: z.object({ m: z.string(), n: z.coerce.number().default(0) }),
      sources: [{ map: { M: 'v=${N}-${U:-dflt}', N: 5, U: undefined } as never }],
      env: {},
      coerce: false,
    });
    expect(out.m).toBe('v=5-dflt');
    // UPPER-case env hit: ref is lowercase, snapshot holds FOO.
    const out2 = settings({
      schema: z.object({ m: z.string() }),
      sources: [{ map: { M: 'v=${foo}' } }],
      env: { FOO: '1' },
      coerce: false,
    });
    expect(out2.m).toBe('v=1');
  });

  it('top-level string files expand with the root label', () => {
    inject({ 's.json': '"${V}-suffix"' });
    try {
      const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
      const out = settings({ schema: fake as never, sources: ['s.json'], env: { V: 'x' }, coerce: false });
      expect(out).toBe('x-suffix');
    } finally {
      uninject();
    }
  });

  it('reject mode reports nested and root-array extras', () => {
    const schema = z.object({ db: z.object({ host: z.string() }) });
    try {
      settings({
        schema: schema as never,
        sources: [{ map: { DB__HOST: 'h', DB__PORT: '1', TOP_EXTRA: 'x' } }],
        env: {},
        expand: false,
        coerce: false,
        unknownKeys: 'reject',
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_UNKNOWN_KEY');
      const paths = (e as ConfigError).issues.map((i) => i.path);
      expect(paths).toContain('db.port');
      expect(paths).toContain('top_extra');
    }
    // Nested arrays recurse with dotted prefixes.
    const fakeNested = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: { tags: ['a'] } }) } };
    try {
      settings({
        schema: fakeNested as never,
        sources: [{ map: { TAGS: ['a', 'b'] } as never }],
        env: {},
        expand: false,
        coerce: false,
        unknownKeys: 'reject',
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues.map((i) => i.path)).toEqual(['tags.1']);
    }
    // Root-level arrays diff with bare indexes (input itself is the array).
    inject({ 'arr.json': '["a","b"]' });
    try {
      const fakeArr = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: ['a'] }) } };
      try {
        settings({
          schema: fakeArr as never,
          sources: ['arr.json'],
          env: {},
          expand: false,
          coerce: false,
          unknownKeys: 'reject',
        });
        expect.unreachable();
      } catch (e) {
        expect((e as ConfigError).issues.map((i) => i.path)).toEqual(['1']);
      }
      // Top-level scalars collect to [] (no crash on non-object input).
      inject({ 's2.json': '"plain"' });
      const fakeStr = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
      expect(
        settings({
          schema: fakeStr as never,
          sources: ['s2.json'],
          env: {},
          expand: false,
          coerce: false,
          unknownKeys: 'reject',
        }),
      ).toBe('plain');
    } finally {
      uninject();
    }
  });

  it('async schemas honor freeze:false', async () => {
    const ok = { '~standard': { version: 1, vendor: 't', validate: async (v: unknown) => ({ value: v }) } };
    const out = (await settingsAsync({
      schema: ok as never,
      sources: [{ map: { A: '1' } }],
      env: {},
      expand: false,
      coerce: false,
      freeze: false,
    })) as Record<string, unknown>;
    expect(Object.isFrozen(out)).toBe(false);
    expect(out['a']).toBe('1');
  });
});

describe('break3: secret path resolution corners', () => {
  const echoing = (path: (string | number)[]) =>
    ({
      '~standard': {
        version: 1,
        vendor: 't',
        validate: () => ({ issues: [{ path, message: 'bad value here' }] }),
      },
    }) as never;

  it('paths through string leaves and unknown keys resolve safely', async () => {
    // Secret-keyed paths always carry the redaction marker; anything else must
    // at least never leak the secret and never crash the resolver.
    for (const p of [
      ['api_token', 'sub'],
      ['tokens', 'abc'],
      ['tokens', '[0]'],
    ]) {
      try {
        await settingsAsync({
          schema: echoing(p as (string | number)[]),
          sources: [{ map: { API_TOKEN: 's3cret-value', TOKENS: 'a,b' } }],
          env: {},
          expand: false,
          coerce: true,
        });
        expect.unreachable(JSON.stringify(p));
      } catch (e) {
        // Must never leak the raw secret, and must still flag redaction.
        expect((e as Error).message).not.toContain('s3cret-value');
        expect((e as Error).message).toContain('(redacted)');
      }
    }
    // Non-secret paths resolve without the marker (and without crashing).
    // A secret-sounding but ABSENT key exercises the not-found path safely.
    try {
      await settingsAsync({
        schema: echoing(['ghost_secret', 'x']),
        sources: [{ map: { API_TOKEN: 's3cret-value' } }],
        env: {},
        expand: false,
        coerce: false,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('ghost_secret.x');
      expect((e as Error).message).not.toContain('s3cret-value');
      expect((e as Error).message).toContain('(redacted)');
    }
    try {
      await settingsAsync({
        schema: echoing(['nope', 'x']),
        sources: [{ map: { API_TOKEN: 's3cret-value' } }],
        env: {},
        expand: false,
        coerce: false,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('nope.x');
      expect((e as Error).message).not.toContain('s3cret-value');
      expect((e as Error).message).not.toContain('(redacted)');
    }
  });

  it('Buffer-backed base64 redaction when btoa is absent', async () => {
    const secret = 'buf-secret-abc-123';
    const g = globalThis as Record<string, unknown>;
    const savedBtoa = g['btoa'];
    g['btoa'] = undefined;
    try {
      expect(g['Buffer']).toBeDefined();
      try {
        await settingsAsync({
          schema: echoing(['api_token']),
          sources: [{ map: { API_TOKEN: secret } }],
          env: {},
          expand: false,
          coerce: false,
        });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain(secret);
      }
    } finally {
      g['btoa'] = savedBtoa;
    }
  });
});
