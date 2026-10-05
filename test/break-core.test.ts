import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  settings,
  settingsAsync,
  ConfigError,
  withOverrides,
  pickPublic,
  viteSettings,
} from '../src/index.js';
import { stripPrefix } from '../src/merge.js';

describe('break: withOverrides', () => {
  it('holds the override across awaits and restores after settle', async () => {
    const seen: (string | undefined)[] = [];
    await withOverrides({ ASYNC_PROBE: '1' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(process.env['ASYNC_PROBE']);
    });
    expect(seen).toEqual(['1']);
    expect(process.env['ASYNC_PROBE']).toBeUndefined();
  });

  it('restores after rejection and deletes added keys', async () => {
    await expect(
      withOverrides({ ADDED_KEY: 'x' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect('ADDED_KEY' in process.env).toBe(false);
  });

  it('restores after a sync throw', () => {
    process.env['SYNC_PROBE'] = 'orig';
    expect(() =>
      withOverrides({ SYNC_PROBE: 'changed' }, () => {
        throw new Error('sync boom');
      }),
    ).toThrow('sync boom');
    expect(process.env['SYNC_PROBE']).toBe('orig');
  });

  it('undefined value deletes the key for the duration', () => {
    process.env['DEL_PROBE'] = 'keep';
    const seen = withOverrides({ DEL_PROBE: undefined }, () => process.env['DEL_PROBE']);
    expect(seen).toBeUndefined();
    expect(process.env['DEL_PROBE']).toBe('keep');
    delete process.env['DEL_PROBE'];
  });
});

describe('break: pickPublic / viteSettings', () => {
  it('skips missing keys instead of writing undefined', () => {
    expect(pickPublic({ a: 1 } as { a: number; b?: number }, ['a', 'b'])).toEqual({ a: 1 });
  });

  it('viteSettings validates an import.meta.env-style map', () => {
    const schema = z.object({ port: z.coerce.number().default(3000) });
    expect(viteSettings({ schema }, { PORT: '4000' }).port).toBe(4000);
  });
});

describe('break: source plumbing', () => {
  it('a plain { load: string } map is config data, not a provider crash', () => {
    const schema = z.object({ load: z.string() });
    expect(
      settings({ schema, sources: [{ load: 'foo' } as never], env: {}, expand: false, coerce: false }).load,
    ).toBe('foo');
  });

  it('{ text } syntax errors surface as E_PARSE with issues', () => {
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ text: 'barekeywithoutequals' }], env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_PARSE');
      expect((e as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });

  it('sync provider objects work in settings()', () => {
    const schema = z.object({ port: z.coerce.number().default(0) });
    const prov = { name: 'sync-vault', load: () => ({ PORT: '1111' }) };
    expect(settings({ schema, sources: [{ provider: prov }], env: {}, expand: false }).port).toBe(1111);
  });

  it('per-source prefix replaces (not composes with) the global prefix', () => {
    const schema = z.object({}).passthrough();
    // 'APP_X_Y' does not start with the source prefix 'X_', so it is dropped.
    expect(
      settings({ schema, sources: [{ map: { APP_X_Y: '1' }, prefix: 'X_' } as never], prefix: 'APP_', env: {}, expand: false, coerce: false }),
    ).toEqual({});
  });

  it('ESM without the node entry fails loudly (E_NO_FS), never silently skips', () => {
    // This file never imports src/node.ts, so no fs hook is installed in this worker.
    expect((globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs).toBeUndefined();
    try {
      settings({ schema: z.object({ a: z.string() }), sources: ['some-file.env'], env: {} });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_NO_FS');
    }
  });

  it('null providers become empty layers; nameless providers track as <provider>', () => {
    const schema = z.object({ port: z.coerce.number().default(3000) });
    const nil = { name: 'nil', load: () => null };
    expect(settings({ schema, sources: [{ provider: nil } as never], env: {} }).port).toBe(3000);
    // A provider without a name is still tracked (as <provider>).
    const anon = { load: () => ({ PORT: '4000' }) };
    try {
      settings({ schema: z.object({ port: z.number() }), sources: [{ provider: anon } as never], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues[0]?.from).toBe('<provider>');
    }
  });

  it('{map: undefined} contributes nothing', () => {
    const schema = z.object({ a: z.string().default('d') });
    expect(settings({ schema, sources: [{ map: undefined } as never], env: {}, expand: false, coerce: false }).a).toBe('d');
  });

  it('JSON null files merge as empty objects', () => {
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p === 'n.json') return 'null';
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const schema = z.object({ a: z.string().default('d') });
      expect(settings({ schema, sources: ['n.json'], env: {}, expand: false, coerce: false }).a).toBe('d');
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });

  it('freeze:false returns live objects (sync and async)', async () => {
    const schema = z.object({ a: z.string().default('x') });
    expect(Object.isFrozen(settings({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false, freeze: false }))).toBe(false);
    expect(
      Object.isFrozen(await settingsAsync({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false, freeze: false })),
    ).toBe(false);
  });

  it('missing required keys attribute to defaults (sync and async)', async () => {
    const schema = z.object({ port: z.number() });
    try {
      settings({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues[0]).toMatchObject({ path: 'port', from: 'defaults' });
    }
    try {
      await settingsAsync({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues[0]).toMatchObject({ path: 'port', from: 'defaults' });
    }
  });

  it('no process.env at all still works (Edge)', () => {
    const g = globalThis as { process?: unknown };
    const saved = g.process;
    delete g.process;
    try {
      const schema = z.object({ a: z.string().default('dflt') });
      expect(settings({ schema, sources: [{ map: {} }], expand: false, coerce: false }).a).toBe('dflt');
    } finally {
      g.process = saved;
    }
  });

  it('CJS-style require fallback reads files; absent require skips loudly-clean', () => {
    const g = globalThis as Record<string, unknown>;
    const savedRequire = g['require'];
    const savedHook = (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    delete (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    // Simulate a CJS host where require('node:fs') resolves.
    g['require'] = (mod: string) => {
      if (mod !== 'node:fs') throw new Error('nope');
      return {
        readFileSync: (p: string) => {
          if (p === 'c.env') return 'A=1';
          const e = new Error('ENOENT') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        },
      };
    };
    try {
      const schema = z.object({ a: z.coerce.number().default(0) });
      expect(settings({ schema, sources: ['c.env'], env: {}, expand: false }).a).toBe(1);
      expect(settings({ schema, sources: ['missing.env'], env: {}, expand: false }).a).toBe(0);
    } finally {
      if (savedRequire === undefined) delete g['require'];
      else g['require'] = savedRequire;
      if (savedHook !== undefined) {
        (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs = savedHook as never;
      }
    }
  });

  it('no fs at all (no hook, no require, no process) skips files', () => {
    const g = globalThis as Record<string, unknown>;
    const savedRequire = g['require'];
    const savedHook = (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    const gp = globalThis as { process?: unknown };
    const savedProcess = gp.process;
    delete (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    delete g['require'];
    delete gp.process;
    try {
      const schema = z.object({ a: z.string().default('dflt') });
      expect(settings({ schema, sources: ['c.env', { map: {} }], expand: false, coerce: false }).a).toBe('dflt');
    } finally {
      if (savedRequire !== undefined) g['require'] = savedRequire;
      gp.process = savedProcess;
      if (savedHook !== undefined) {
        (globalThis as { __typedSettingsFs?: unknown }).__typedSettingsFs = savedHook as never;
      }
    }
  });
});

describe('break: precedence and attribution', () => {
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

  it('listed order wins across flat and file layers', () => {
    inject({ 'c.json': JSON.stringify({ a: 'file' }) });
    try {
      const schema = z.object({ a: z.string() });
      expect(
        settings({ schema, sources: [{ map: { a: 'flat' } }, 'c.json'], env: {}, expand: false, coerce: false }).a,
      ).toBe('file');
      expect(
        settings({ schema, sources: ['c.json', { map: { a: 'flat' } }], env: {}, expand: false, coerce: false }).a,
      ).toBe('flat');
    } finally {
      uninject();
    }
  });

  it('validation errors name the file source, not defaults', () => {
    inject({ 'c.json': JSON.stringify({ port: 'notanumber' }) });
    try {
      settings({ schema: z.object({ port: z.number() }), sources: ['c.json'], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues[0]?.from).toBe('c.json');
    } finally {
      uninject();
    }
  });

  it('__proto__ smuggled via a JSON file throws E_PROTO', () => {
    inject({ 'evil.json': '{"__proto__":{"polluted":"yes"}}' });
    try {
      settings({ schema: z.object({}).passthrough(), sources: ['evil.json'], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_PROTO');
    } finally {
      uninject();
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('multibyte files are capped by bytes, not chars', () => {
    inject({ 'f.env': 'ok' });
    // 'é'.repeat(100) is 100 chars but 200 UTF-8 bytes > 150.
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: () => 'é'.repeat(100),
    };
    try {
      settings({ schema: z.object({}).passthrough(), sources: ['f.env'], env: {}, maxBytes: 150 });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_FILE_TOO_LARGE');
    } finally {
      uninject();
    }
  });

  it('expand errors carry the owning source, and allowUnresolved keeps literals', () => {
    inject({ 'c.env': 'A=${MISSING_VAR_XYZ}' });
    try {
      settings({ schema: z.object({ a: z.string() }), sources: ['c.env'], env: {}, coerce: false });
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.code).toBe('E_UNRESOLVED');
      expect(err.issues[0]?.from).toBe('c.env');
    } finally {
      uninject();
    }
    inject({ 'c.env': 'A=${MISSING_VAR_XYZ}' });
    try {
      const out = settings({
        schema: z.object({ a: z.string() }),
        sources: ['c.env'],
        env: {},
        coerce: false,
        allowUnresolved: true,
      });
      expect(out.a).toBe('${MISSING_VAR_XYZ}');
    } finally {
      uninject();
    }
  });
});

describe('break: expansion cycles and chains', () => {
  const schema = z.object({ a: z.string(), b: z.string().optional() }).passthrough();
  const run = (map: Record<string, string | undefined>, extra = {}) =>
    settings({ schema: schema as never, sources: [{ map: map as never }], env: {}, coerce: false, ...extra } as never) as Record<string, string>;

  it('self reference is E_CIRCULAR, not a silent literal', () => {
    try {
      run({ A: '${A}' });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CIRCULAR');
    }
  });

  it('mutual reference is E_CIRCULAR', () => {
    try {
      run({ A: '${B}', B: '${A}' });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CIRCULAR');
    }
  });

  it('chains resolve transitively', () => {
    expect(run({ A: '${B}', B: 'hi' }).a).toBe('hi');
  });

  it('$$ escapes and literal $ text survive without re-scan', () => {
    expect(run({ A: 'cost $$5' }).a).toBe('cost $5');
    expect(run({ A: 'pa$$w0rd' }).a).toBe('pa$w0rd');
    expect(run({ A: 'price $5 and $' }).a).toBe('price $5 and $');
  });

  it('longest name wins', () => {
    expect(run({ VAR: 'part', VAR_SUFFIX: 'full', A: '$VAR_SUFFIX' }).a).toBe('full');
  });

  it(':- treats empty as missing, - only treats unset as missing', () => {
    expect(run({ E: '', A: '${E:-d}' }).a).toBe('d');
    expect(run({ E: '', A: '${E-d}' }).a).toBe('');
  });

  it('recursive defaults expand', () => {
    expect(run({ A: '${M:-${N:-z}}' }).a).toBe('z');
  });

  it('\\} escapes a brace inside defaults', () => {
    expect(run({ A: 'x${M:-a\\}b}y' }).a).toBe('xa}by');
  });

  it(':= and :? are rejected', () => {
    for (const expr of ['${A:=x}', '${A:?x}']) {
      try {
        run({ A: expr });
        expect.unreachable();
      } catch (e) {
        expect((e as ConfigError).code).toBe('E_BAD_OP');
      }
    }
  });
});

describe('break: async parity', () => {
  it('async collects .env and file sources like sync does', async () => {
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p.endsWith('c.json')) return JSON.stringify({ port: 4242 });
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const schema = z.object({ port: z.number() });
      expect((await settingsAsync({ schema, sources: ['c.json'], env: {}, expand: false, coerce: false })).port).toBe(4242);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });

  it('a hanging provider trips timeoutMs instead of hanging boot', async () => {
    const hanging = { name: 'hang-vault', load: () => new Promise<Record<string, string>>(() => {}) };
    await expect(
      settingsAsync({ schema: z.object({ a: z.string() }), sources: [{ provider: hanging }], env: {}, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });

  it('async validation issues are redacted like sync ones', async () => {
    const secret = 'hunter2-async-secret-value';
    const fake = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: async () => ({ issues: [{ path: ['api_token'], message: `saw ${secret}` }] }),
      },
    };
    try {
      await settingsAsync({ schema: fake as never, sources: [{ map: { api_token: secret } }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).toContain('(redacted)');
    }
  });

  it('sync settings() rejects async schemas with USE_ASYNC', () => {
    const fake = { '~standard': { version: 1, vendor: 't', validate: async (v: unknown) => ({ value: v }) } };
    expect(() => settings({ schema: fake as never, sources: [{ map: {} }], env: {} })).toThrow(/USE_ASYNC/);
  });

  it('sync provider throwing synchronously propagates raw', () => {
    // A provider whose load() throws synchronously violates the provider contract;
    // settings() lets the raw error through (async callers wrap it as E_PROVIDER).
    const prov = {
      name: 'sync-boom',
      load: () => {
        throw new Error('sync boom');
      },
    };
    const schema = z.object({ a: z.string().default('x') });
    expect(() => settings({ schema: schema as never, sources: [{ provider: prov }], env: {} })).toThrow('sync boom');
  });

  it('cyclic provider maps fail closed with E_CYCLE (no stack overflow)', () => {
    const cyc: Record<string, unknown> = { a: '1' };
    cyc['self'] = cyc;
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    try {
      settings({ schema: fake as never, sources: [{ map: cyc as never }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CYCLE');
    }
    // Shared (DAG) references are fine — only true cycles throw.
    const shared = { x: '1' };
    const out = settings({
      schema: fake as never,
      sources: [{ map: { p: shared, q: shared } as never }],
      env: {},
      expand: false,
      coerce: false,
    }) as Record<string, unknown>;
    expect((out['p'] as Record<string, unknown>)['x']).toBe('1');
  });
});

describe('break: coercion and keys', () => {
  it('TRUE/FALSE/NULL fold case-insensitively', () => {
    const schema = z.object({ t: z.boolean(), f: z.boolean(), n: z.string().nullable() });
    const out = settings({
      schema: schema as never,
      sources: [{ map: { T: 'TRUE', F: 'FALSE', N: 'NULL' } }],
      env: {},
      expand: false,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({ t: true, f: false, n: null });
  });

  it('comma strings stay strings for string targets only when unquoted... documents array split', () => {
    // Best-effort coercion cannot see the schema: 'a,b' becomes an array.
    // A string schema then rejects it — pinned behavior (use quoting or arrays in target).
    try {
      settings({ schema: z.object({ greeting: z.string() }), sources: [{ map: { greeting: 'hello, world' } }], env: {}, expand: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
    }
  });

  it('prefix APP does not require a segment boundary (pinned)', () => {
    // 'APPLE' matches prefix 'APP' with remainder 'LE' — remainder-non-empty rule.
    expect(stripPrefix('APPLE', 'APP')).toBe('LE');
    expect(stripPrefix('APP', 'APP')).toBeNull();
    expect(stripPrefix('OTHER', 'APP')).toBeNull();
    expect(stripPrefix('a', undefined)).toBe('a');
  });

  it('unknownKeys preserve keeps extras, reject fires', () => {
    const schema = z.object({ port: z.number() });
    const kept = settings({
      schema: schema as never,
      sources: [{ map: { port: 1 as never, extra: 'x' } }],
      env: {},
      expand: false,
      coerce: false,
      unknownKeys: 'preserve',
    }) as Record<string, unknown>;
    expect(kept['extra']).toBe('x');
    expect(() =>
      settings({ schema: schema as never, sources: [{ map: { port: 1 as never, extra: 'x' } }], env: {}, expand: false, coerce: false, unknownKeys: 'reject' }),
    ).toThrow(/E_UNKNOWN_KEY/);
  });
});
