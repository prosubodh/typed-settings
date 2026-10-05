import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, settingsAsync, ConfigError, withOverrides } from '../src/index.js';

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

describe('break2: file source spellings (sync)', () => {
  it('{file} loads structured and env payloads; {dir} is skipped', () => {
    inject({ 'c.json': JSON.stringify({ a: 'file' }), 'e.env': 'B=2' });
    try {
      const js = z.object({ a: z.string() });
      expect(settings({ schema: js, sources: [{ file: 'c.json' }], env: {}, expand: false, coerce: false }).a).toBe('file');
      const es = z.object({ b: z.coerce.number().default(0) });
      expect(settings({ schema: es, sources: [{ file: 'e.env' }], env: {}, expand: false }).b).toBe(2);
      // {dir} is inert in core: resolve via loadSecretsDir() and pass {map} instead.
      const ds = z.object({ a: z.string().default('d') });
      expect(settings({ schema: ds, sources: [{ dir: '/run/secrets' } as never], env: {}, expand: false, coerce: false }).a).toBe('d');
    } finally {
      uninject();
    }
  });

  it('structured layers honor the global prefix (non-matching tops dropped)', () => {
    inject({ 'c.json': JSON.stringify({ APP_A: '1', OTHER: '2' }) });
    try {
      // NOTE: file keys keep their case (structured data is case-sensitive,
      // unlike flat env keys which normalize to lowercase) — schemas must match.
      const schema = z.object({ A: z.coerce.number().default(0) });
      const out = settings({ schema, sources: ['c.json'], prefix: 'APP_', env: {}, expand: false }) as Record<string, unknown>;
      expect(out['A']).toBe(1);
      expect('OTHER' in (out as object)).toBe(false);
      expect('other' in (out as object)).toBe(false);
    } finally {
      uninject();
    }
  });

  it('bad structured files throw E_PARSE naming the file', () => {
    inject({ 'c.json': '{bad json', 'c.toml': 'a = ', 'c.yaml': 'a: [1, 2' });
    try {
      for (const f of ['c.json', 'c.toml', 'c.yaml']) {
        try {
          settings({ schema: z.object({}).passthrough(), sources: [f], env: {}, expand: false });
          expect.unreachable(f);
        } catch (e) {
          expect((e as ConfigError).code, f).toBe('E_PARSE');
          expect((e as ConfigError).issues[0]?.from, f).toBe(f);
        }
      }
    } finally {
      uninject();
    }
  });
});

describe('break2: async source parity', () => {
  it('collects .env, text, map, dir and file sources like sync', async () => {
    inject({ '.env': 'DOTENV=yes', 'a.env': 'FROM_ENV_FILE=yes', 'c.json': JSON.stringify({ n: 5 }), 'q.env': 'Q=qval' });
    try {
      const prov = { name: 'p', load: async () => ({ P: 'v' }) };
      const schema = z.object({
        dotenv: z.string().default(''),
        from_env_file: z.string().default(''),
        n: z.number().default(0),
        t: z.string().default(''),
        m: z.string().default(''),
        p: z.string().default(''),
        bare: z.string().default(''),
        q: z.string().default(''),
        fq: z.string().default(''),
      });
      const out = await settingsAsync({
        schema,
        sources: [
          '.env', 'a.env', 'env', { text: 'T=textval' }, { map: { M: 'mval' } }, { map: undefined } as never, { dir: '/x' } as never,
          'c.json', { file: 'c.json' }, { file: 'q.env' }, { BARE: 'b' } as never, { provider: prov },
        ],
        env: {},
        expand: false,
        coerce: false,
      });
      expect(out.dotenv).toBe('yes');
      expect(out.from_env_file).toBe('yes');
      expect(out.t).toBe('textval');
      expect(out.m).toBe('mval');
      expect(out.n).toBe(5);
      expect(out.p).toBe('v');
      expect(out.bare).toBe('b');
      expect(out.q).toBe('qval');
      expect(out.fq).toBe('');
    } finally {
      uninject();
    }
  });

  it('omitted sources fall back to .env,env in both modes', async () => {
    inject({});
    try {
      const schema = z.object({ port: z.coerce.number().default(3000) });
      expect(settings({ schema, env: {} }).port).toBe(3000);
      expect((await settingsAsync({ schema, env: {} })).port).toBe(3000);
    } finally {
      uninject();
    }
  });

  it('bad {text} in async mode is E_PARSE, not a raw error', async () => {
    const prov = { name: 'p', load: async () => ({}) };
    await expect(
      settingsAsync({ schema: z.object({}), sources: [{ text: 'barekey' }, { provider: prov }], env: {} }),
    ).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('sync-throwing providers become E_PROVIDER in async mode', async () => {
    const prov = { name: 'p', load: () => { throw new Error('sync boom'); } };
    await expect(
      settingsAsync({ schema: z.object({}), sources: [{ provider: prov }], env: {} }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER' });
  });

  it('provider ConfigErrors pass through unwrapped (403 stays E_DENIED)', async () => {
    const prov = {
      name: 'deny',
      load: async () => {
        throw new ConfigError([{ path: 'p', from: 'deny', message: 'E_DENIED: HTTP 403' }], 'E_DENIED');
      },
    };
    await expect(
      settingsAsync({ schema: z.object({}), sources: [{ provider: prov }], env: {} }),
    ).rejects.toMatchObject({ code: 'E_DENIED' });
  });

  it('async schemas succeed end-to-end and honor the schema timeout', async () => {
    const ok = { '~standard': { version: 1, vendor: 't', validate: async (v: unknown) => ({ value: v }) } };
    const out = (await settingsAsync({ schema: ok as never, sources: [{ map: { A: '1' } }], env: {}, expand: false, coerce: false })) as Record<string, unknown>;
    expect(out['a']).toBe('1');
    const hanging = { '~standard': { version: 1, vendor: 't', validate: () => new Promise(() => {}) } };
    await expect(
      settingsAsync({ schema: hanging as never, sources: [{ map: {} }], env: {}, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });
});

describe('break2: expandSecrets and nested expansion', () => {
  const schema = z.object({ msg: z.string(), db: z.object({ url: z.string() }).optional() }).passthrough();

  it('provider values skip expansion by default, expand with the flag', async () => {
    const prov = { name: 'v', load: async () => ({ MSG: 'hi ${WHO}', WHO: 'bob' }) };
    const skipped = (await settingsAsync({ schema: schema as never, sources: [{ provider: prov }], env: {}, coerce: false })) as Record<string, string>;
    expect(skipped['msg']).toBe('hi ${WHO}');
    const expanded = (await settingsAsync({
      schema: schema as never, sources: [{ provider: prov }], env: {}, coerce: false, expandSecrets: true,
    })) as Record<string, string>;
    expect(expanded['msg']).toBe('hi bob');
  });

  it('nested objects and top-level arrays expand recursively', () => {
    const nestedSchema = z.object({ msg: z.string().default(''), db: z.object({ url: z.string() }).optional() });
    const nested = settings({
      schema: nestedSchema as never,
      sources: [{ map: { DB__URL: 'pg://${H}', H: 'db.local' } }],
      env: {},
      coerce: false,
    }) as Record<string, Record<string, string>>;
    expect(nested['db']!['url']).toBe('pg://db.local');
  });

  it('top-level arrays from JSON files expand per element', () => {
    inject({ 'arr.json': JSON.stringify(['${V}', 'plain']) });
    try {
      const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
      // V arrives via the env snapshot (the map layer would replace the array in merge).
      const out = settings({
        schema: fake as never, sources: ['arr.json'], env: { V: 'x' }, coerce: false,
      }) as unknown;
      expect(out).toEqual(['x', 'plain']);
    } finally {
      uninject();
    }
  });
});

describe('break2: lookup and unknownKeys corners', () => {
  it('lowercase env keys resolve case-insensitively', () => {
    const out = settings({
      schema: z.object({ msg: z.string() }),
      sources: [{ map: { MSG: 'v=${CUSTOM_X}' } }],
      env: { custom_x: '1' },
      coerce: false,
    });
    expect(out.msg).toBe('v=1');
  });

  it('reject flags renamed array elements; preserve tolerates non-objects', () => {
    const fakeArr = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: ['a'] }) } };
    try {
      settings({ schema: fakeArr as never, sources: [{ map: { TAGS: 'a,b' } }], env: {}, coerce: false, unknownKeys: 'reject' });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_UNKNOWN_KEY');
    }
    const kept = settings({ schema: fakeArr as never, sources: [{ map: {} }], env: {}, expand: false, coerce: false, unknownKeys: 'preserve' });
    expect(kept).toEqual(['a']);
  });
});

describe('break2: redaction internals', () => {
  it('secret paths into arrays resolve; base64 without btoa/Buffer degrades', async () => {
    const secret = 'tok-array-secret-1';
    // TOKENS coerces to ['x', secret], so issue path ['tokens', 1] resolves.
    const echoing = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: () => ({ issues: [{ path: ['tokens', 1], message: `bad ${secret}` }] }),
      },
    };
    const run = () =>
      settingsAsync({
        schema: echoing as never, sources: [{ map: { TOKENS: `x,${secret}` } }], env: {}, expand: false, coerce: true,
      });
    try {
      await run();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).toContain('(redacted)');
    }
    const g = globalThis as { btoa?: unknown; Buffer?: unknown };
    const savedBtoa = g.btoa;
    const savedBuffer = g.Buffer;
    (g as Record<string, unknown>)['btoa'] = undefined;
    (g as Record<string, unknown>)['Buffer'] = undefined;
    try {
      await run().then(
        () => expect.unreachable(),
        (e: Error) => expect(e.message).not.toContain(secret),
      );
    } finally {
      g.btoa = savedBtoa as never;
      g.Buffer = savedBuffer as never;
    }
    // Throwing btoa also degrades to raw-only redaction.
    (g as Record<string, unknown>)['btoa'] = () => { throw new Error('nope'); };
    try {
      await run().then(
        () => expect.unreachable(),
        (e: Error) => expect(e.message).not.toContain(secret),
      );
    } finally {
      g.btoa = savedBtoa as never;
      g.Buffer = savedBuffer as never;
    }
  });

  it('withOverrides without process.env runs bare', () => {
    const g = globalThis as { process?: unknown };
    const saved = g.process;
    delete g.process;
    try {
      expect(withOverrides({}, () => 'ok')).toBe('ok');
    } finally {
      g.process = saved;
    }
  });
});
