import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import '../src/node.js';
import { settings, settingsAsync, ConfigError, isSecretKey, withOverrides } from '../src/index.js';
import { loadSecretsDir, watchSettings } from '../src/node.js';
import { loadSchema } from '../src/cli/load-schema.js';
import { timeoutSignal, statusToCode } from '../src/vault/shared.js';
import { httpProvider } from '../src/vault/http.js';
import { awsProvider } from '../src/vault/aws.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ts-harden2-'));
function localTmp(prefix: string): string {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}
const enoent = (p: string) => {
  const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  throw e;
};

describe('hardening2: secret matchers', () => {
  it('default pattern unchanged; string extras match case-insensitively', () => {
    expect(isSecretKey('api_token')).toBe(true);
    expect(isSecretKey('port')).toBe(false);
    expect(isSecretKey('db_passphrase', ['passphrase'])).toBe(true);
    expect(isSecretKey('db_PassPhrase', ['passphrase'])).toBe(true);
    expect(isSecretKey('port', [''])).toBe(false);
    expect(isSecretKey('port')).toBe(false);
  });
  it('regex extras work and global regexes do not alternate', () => {
    expect(isSecretKey('db_pwd', [/pwd$/])).toBe(true);
    expect(isSecretKey('db_pwd_hash', [/pwd$/])).toBe(false);
    const g = /tok|key/g;
    expect(isSecretKey('token', [g])).toBe(true);
    expect(isSecretKey('token', [g])).toBe(true);
  });
  it('secretKeys opt-in redacts custom names end to end', () => {
    const fake = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: (v: unknown) => ({ issues: [{ path: ['passphrase'], message: `refused ${(v as { passphrase: string }).passphrase}` }] }),
      },
    };
    const src = [{ map: { passphrase: 's3cr3t-value' } }];
    // Without opt-in the value leaks; with secretKeys it is scrubbed + tagged.
    try {
      settings({ schema: fake as never, sources: src as never, env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('s3cr3t-value');
    }
    try {
      settings({ schema: fake as never, sources: src as never, env: {}, expand: false, coerce: false, secretKeys: ['passphrase'] });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cr3t-value');
      expect((e as Error).message).toContain('(redacted)');
    }
  });
  it('non-string leaves redact; short values keep text but stay tagged', () => {
    const fakeFor = (path: string, msg: string) => ({
      '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ issues: [{ path: [path], message: msg }] }) },
    });
    // Number leaf 123456 is stringified for the equality scrub.
    try {
      settings({ schema: fakeFor('pin', 'bad 123456') as never, sources: [{ map: { pin: '123456' } }], env: {}, expand: false, secretKeys: [/pin/] });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('123456');
      expect((e as Error).message).toContain('(redacted)');
    }
    // Short values skip the scrub (no message corruption) but stay tagged.
    try {
      settings({ schema: fakeFor('pin', 'bad 12') as never, sources: [{ map: { pin: '12' } }], env: {}, expand: false, secretKeys: [/pin/] });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('(redacted)');
    }
  });
});

describe('hardening2: option validation', () => {
  const schema = z.object({ a: z.string().default('x') });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('maxBytes %s throws E_USAGE', (v) => {
    try {
      settings({ schema, sources: [{ map: {} }], env: {}, maxBytes: v });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_USAGE');
    }
  });
  it.each([0, -5, Number.NaN])('timeoutMs %s throws E_USAGE', (v) => {
    try {
      settings({ schema, sources: [{ map: {} }], env: {}, timeoutMs: v });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_USAGE');
    }
  });
  it('settingsAsync validates options too', async () => {
    await expect(
      settingsAsync({ schema, sources: [{ map: {} }], env: {}, timeoutMs: -1 }),
    ).rejects.toMatchObject({ code: 'E_USAGE' });
  });
});

describe('hardening2: fs injection + depth guard', () => {
  const schema = z.object({ a: z.string() });
  it('opts.fs takes precedence and statSync gates oversized files pre-read', () => {
    let read = false;
    const fs = {
      readFileSync: (p: string) => {
        read = true;
        if (p === 'c.json') return JSON.stringify({ a: '1' });
        return enoent(p);
      },
      statSync: (_p: string) => ({ size: 10 }),
    };
    expect((settings({ schema, sources: ['c.json'], env: {}, expand: false, coerce: false, fs } as never) as { a: string }).a).toBe('1');
    const bigFs = {
      readFileSync: (_p: string) => {
        read = true;
        return '{}';
      },
      statSync: (_p: string) => ({ size: 10 ** 12 }),
    };
    read = false;
    try {
      settings({ schema, sources: ['c.json'], env: {}, expand: false, coerce: false, fs: bigFs } as never);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_FILE_TOO_LARGE');
    }
    expect(read).toBe(false);
  });
  it('stat miss falls through to read', () => {
    const fs = {
      readFileSync: (p: string) => {
        if (p === 'c.json') return JSON.stringify({ a: '2' });
        return enoent(p);
      },
      statSync: (p: string): { size: number } => enoent(p),
    };
    expect((settings({ schema, sources: ['c.json'], env: {}, expand: false, coerce: false, fs } as never) as { a: string }).a).toBe('2');
  });
  it('hostile nesting depth fails closed as E_DEPTH, not RangeError', () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 100000; i++) v = { k: v };
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ map: { top: v } } as never], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_DEPTH');
    }
  });
  it('expansion chains past the depth cap fail closed', () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < 60; i++) map[`L${i}`] = `\${l${i + 1}}`;
    map['L60'] = '${leaf}';
    map['leaf'] = 'done';
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ map } as never], env: {}, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CIRCULAR');
      expect((e as Error).message).toContain('exceeded 50 links');
      // The error blames the referencing leaf (l0), not the deep variable.
      expect((e as ConfigError).issues[0]?.path).toBe('l0');
    }
  });
  it('expansion errors blame the referencing leaf', () => {
    try {
      settings({
        schema: z.object({ db: z.object({ url: z.string() }) }),
        sources: [{ map: { DB__URL: 'postgres://${missing_host}/app' } }],
        env: {},
        coerce: false,
      });
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.code).toBe('E_UNRESOLVED');
      expect(err.issues[0]?.path).toBe('db.url');
    }
  });
});

describe('hardening2: loadSecretsDir', () => {
  it('bad maxBytes throws E_USAGE', () => {
    expect(() => loadSecretsDir(tmp(), { maxBytes: 0 })).toThrow(/E_USAGE/);
  });
  it('preserveEmpty keeps empty files as empty strings', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'EMPTY'), '');
    expect(loadSecretsDir(dir)['EMPTY']).toBeUndefined();
    expect(loadSecretsDir(dir, { preserveEmpty: true })['EMPTY']).toBe('');
  });
  it('case collisions throw instead of depending on readdir order', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'Token'), 'a');
    // Case-insensitive filesystems (Windows/macOS) fold these to one file —
    // collision detection only applies where both entries can coexist.
    try {
      writeFileSync(join(dir, 'TOKEN'), 'b');
    } catch {
      return;
    }
    if (readdirSync(dir).length < 2) return; // folded: deterministic case in hardening-fs
    expect(() => loadSecretsDir(dir)).toThrow(/E_SHAPE/);
  });
  it('oversized secrets fail closed', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'BIG'), 'abcdef');
    expect(() => loadSecretsDir(dir, { maxBytes: 2 })).toThrow(/E_FILE_TOO_LARGE/);
  });
  it('in-dir symlinks resolve; escapes throw', () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(dir, 'real'), 'vv');
    writeFileSync(join(outside, 'o'), 'oo');
    try {
      symlinkSync(join(dir, 'real'), join(dir, 'link'));
      symlinkSync(join(outside, 'o'), join(dir, 'evil'));
    } catch (e) {
      // Windows without Developer Mode cannot create symlinks — skip.
      if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') return;
      throw e;
    }
    const clean = tmp();
    writeFileSync(join(clean, 'real'), 'vv');
    try {
      symlinkSync(join(clean, 'real'), join(clean, 'link'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') return;
      throw e;
    }
    expect(loadSecretsDir(clean)['LINK']).toBe('vv');
    expect(() => loadSecretsDir(dir)).toThrow(/E_SHAPE/);
  });
});

describe('hardening2: iteration-6/7 fixes', () => {
  it('vault payloads refuse proto keys instead of dropping them', async () => {
    const { normalizeSecretMap } = await import('../src/vault/shared.js');
    expect(() => normalizeSecretMap(JSON.parse('{"__proto__":{"polluted":1}}'), 't')).toThrow(/E_PROTO/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('empty secret ids never emit empty keys', async () => {
    const c = { getSecretValue: async () => 'v' };
    expect(await awsProvider({ secrets: [''], secretsClient: c as never }).load()).toEqual({});
  });
});
describe('hardening2: iteration-4/5 fixes', () => {
  it('nested self-named references expand instead of false E_CIRCULAR', () => {
    const schema = z.object({ port: z.string(), server: z.object({ port: z.string() }) });
    const out = settings({
      schema,
      sources: [{ map: { PORT: '8080', SERVER__PORT: '$port' } }],
      env: {},
      coerce: false,
    });
    expect(out.server.port).toBe('8080');
    // True cycles still throw.
    expect(() => settings({
      schema: z.object({ a: z.string() }).passthrough(),
      sources: [{ map: { A: '$a' } }],
      env: {},
      coerce: false,
    })).toThrow(/E_CIRCULAR/);
  });
  it('structured prefix stripping cannot smuggle proto keys', () => {
    const fs = { readFileSync: () => '{"APP__proto__":{"x":1}}' };
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ file: 'e.json' }], prefix: 'APP', env: {}, expand: false, coerce: false, fs } as never);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_PROTO');
    }
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
  it('lookup resolves mixed-case env and scalar types, never [object Object]', () => {
    const schema = z.object({}).passthrough();
    const out = settings({
      schema,
      sources: [{ map: { PORT: '8080', URL: 'http://${db_host}:${port}' } }],
      env: { Db_HoSt: 'db.internal' } as never,
      coerce: false,
    }) as Record<string, unknown>;
    expect(out['url']).toBe('http://db.internal:8080');
    // Numbers/booleans/bigints interpolate; objects stay unresolved (strict).
    const out2 = settings({
      schema,
      sources: [{ map: { PORT: 8080, ON: true, BIG: 10n, URL: 'http://x:${port}/${on}/${big}' } } as never],
      env: {},
      coerce: false,
    }) as Record<string, string>;
    expect(out2['url']).toBe('http://x:8080/true/10');
    expect(() => settings({
      schema,
      sources: [{ map: { OBJ: { a: 1 }, REF: '$obj' } } as never],
      env: {},
      coerce: false,
    })).toThrow(/E_UNRESOLVED/);
    // Nullish merged values defer to env.
    const out3 = settings({
      schema,
      sources: [{ map: { A: null, B: undefined, R: '$a/$b' } } as never],
      env: { A: 'ea', B: 'eb' },
      coerce: false,
    }) as Record<string, string>;
    expect(out3['r']).toBe('ea/eb');
  });
  it('array-indexed secret paths scrub in both notations', () => {
    for (const path of ['servers[0].password', 'servers.0.password']) {
      const fake = {
        '~standard': {
          version: 1,
          vendor: 't',
          validate: (v: unknown) => ({ issues: [{ path: [path], message: `refused ${(v as { servers: { password: string }[] }).servers[0]!.password}` }] }),
        },
      };
      try {
        settings({
          schema: fake as never,
          sources: [{ map: { SERVERS__0__PASSWORD: 's3cr3t-long-value' } }],
          env: {},
          expand: false,
          coerce: false,
        });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain('s3cr3t-long-value');
        expect((e as Error).message).toContain('(redacted)');
      }
    }
  });
  it('base64 scrub degrades through btoa failure to Buffer to null', () => {
    const g = globalThis as { btoa?: unknown; Buffer?: unknown };
    const savedBtoa = g.btoa;
    const savedBuffer = g.Buffer;
    const secret = 'päss✓word1234';
    const fakeFor = (msg: string) => ({
      '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ path: ['api_token'], message: msg }] }) },
    });
    try {
      // btoa throws on non-latin1: Buffer backstop still scrubs the base64 echo.
      const b64 = (savedBuffer as { from(s: string, e: string): { toString(e: string): string } }).from(secret, 'utf8').toString('base64');
      try {
        settings({ schema: fakeFor(`saw ${secret} / ${b64}`) as never, sources: [{ map: { api_token: secret } }], env: {}, expand: false, coerce: false });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain(secret);
        expect((e as Error).message).not.toContain(b64);
      }
      // No decoder at all: raw scrub + tag still apply, no throw.
      try {
        delete g.btoa;
        delete g.Buffer;
      } catch {
        return; // non-configurable globals: cannot simulate a decoder-less runtime
      }
      if (g.btoa !== undefined || g.Buffer !== undefined) return;
      try {
        settings({ schema: fakeFor(`saw ${secret}`) as never, sources: [{ map: { api_token: secret } }], env: {}, expand: false, coerce: false });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain(secret);
        expect((e as Error).message).toContain('(redacted)');
      }
      // Broken Buffer shim: also degrades to null, never throws out.
      g.Buffer = { from: () => { throw new Error('nope'); } };
      try {
        settings({ schema: fakeFor(`saw ${secret}`) as never, sources: [{ map: { api_token: secret } }], env: {}, expand: false, coerce: false });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain('(redacted)');
      }
    } finally {
      g.btoa = savedBtoa;
      g.Buffer = savedBuffer;
    }
  });
  it('withOverrides with an empty map is a passthrough', () => {
    expect(withOverrides({}, () => 7)).toBe(7);
  });
  it('init output composes with check (exported schema + node entry)', async () => {
    const { runInit } = await import('../src/cli/init.js');
    const dir = localTmp('ts-harden2-init');
    expect(await runInit({ lib: 'zod', format: 'env', dir })).toBe(0);
    expect(await loadSchema(join(dir, 'src', 'settings.ts'))).toBeDefined();
  });
  it('init hints that .env.example is never loaded', async () => {
    const { runInit } = await import('../src/cli/init.js');
    const dir = localTmp('ts-harden2-hint');
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => { lines.push(String(s)); };
    try {
      expect(await runInit({ lib: 'zod', format: 'env', dir })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines.some((l) => l.includes('.env.example') && l.includes('.env'))).toBe(true);
  });
});
describe('hardening2: iteration-3 safe fixes', () => {
  it('NaN leaves compare by value across reloads', async () => {
    const prov = { name: 'p', load: (): Record<string, unknown> => ({ N: Number.NaN }) };
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [{ provider: prov } as never], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual([]);
    await sub.dispose();
  });
  it('withOverrides without process.env runs fn bare', () => {
    const g = globalThis as { process?: unknown };
    const saved = g.process;
    delete g.process;
    try {
      expect(withOverrides({ A: '1' }, () => 'done')).toBe('done');
    } finally {
      g.process = saved;
    }
  });
  it('domain RangeErrors keep their identity (only stack exhaustion maps)', () => {
    // A throwing map getter is user code surfacing through collection:
    // depthGuarded must not mislabel it E_DEPTH.
    const map = {};
    Object.defineProperty(map, 'a', { enumerable: true, get: () => { throw new RangeError('port out of range'); } });
    try {
      settings({ schema: z.object({ a: z.string().default('x') }), sources: [{ map } as never], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      expect(e).not.toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('port out of range');
    }
  });
  it('async schemas and load failures classify exit 2 via check', async () => {
    const dir = localTmp('ts-harden2-exit');
    const asyncSchema = join(dir, 'async-schema.ts');
    writeFileSync(asyncSchema, `export const schema = { '~standard': { version: 1, vendor: 't', validate: async (v: unknown) => ({ value: v }) } };\n`);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ a: '1' }));
    const { runCheck } = await import('../src/cli/check.js');
    expect(await runCheck({ schema: asyncSchema, config: cfg })).toBe(2);
    // Circular references are value problems (exit 1), not load problems.
    const circ = join(dir, 'circ.env');
    writeFileSync(circ, 'A=${B}\nB=${A}\n');
    const strSchema = join(dir, 'str-schema.ts');
    writeFileSync(strSchema, `import { z } from 'zod';\nexport const schema = z.object({ a: z.string(), b: z.string() });\n`);
    expect(await runCheck({ schema: strSchema, config: circ })).toBe(1);
    // Malformed expansion syntax is a value problem too (E_EXPAND -> exit 1),
    // split out from file-document parse failures (E_PARSE -> exit 2). Pin the
    // code (not just the exit) so an E_INVALID_CONFIG fallthrough can't pass.
    const badExpand = join(dir, 'expand.env');
    writeFileSync(badExpand, 'A=${B\n');
    let logged = '';
    const origLog = console.log;
    console.log = (s: string) => { logged += String(s); };
    try {
      expect(await runCheck({ schema: strSchema, config: badExpand, format: 'json' })).toBe(1);
    } finally {
      console.log = origLog;
    }
    expect(logged).toContain('"code":"E_EXPAND"');
  });
  it('watch --once honors --format/--secret-keys like check', async () => {
    const dir = localTmp('ts-harden2-once');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, `import { z } from 'zod';\nexport const schema = z.object({ token_pin: z.number(), db_pass: z.string().default('x') });\n`);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ token_pin: 999, db_pass: 'hunter2' }));
    const { main } = await import('../src/cli/main.js');
    expect(await main(['watch', '-s', schema, '-c', cfg, '--format', 'bogus', '--once'])).toBe(2);
    let logged = '';
    const orig = console.log;
    console.log = (s: string) => { logged += String(s); };
    try {
      expect(await main(['watch', '-s', schema, '-c', cfg, '--once', '--format', 'json', '--secret-keys', 'db_pass'])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged).not.toContain('999');
    expect(logged).not.toContain('hunter2');
  });
  it('nested secrets redact by full path in check json', async () => {
    const dir = localTmp('ts-harden2-nested');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, `import { z } from 'zod';\nexport const schema = z.object({ mykey: z.object({ x: z.string() }) });\n`);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ mykey: { x: 'hunter2-long-value' } }));
    let logged = '';
    const orig = console.log;
    console.log = (s: string) => { logged += String(s); };
    try {
      const { runCheck } = await import('../src/cli/check.js');
      expect(await runCheck({ schema, config: cfg, expand: false, format: 'json' })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged).not.toContain('hunter2-long-value');
  });
});
describe('hardening2: iteration-2 safe fixes', () => {
  it('hanging fetch backends trip the fetch race (signal-ignoring fakes)', async () => {
    const hanging = () => new Promise<Response>(() => {});
    await expect(
      httpProvider({ url: 'https://x.test/s', timeoutMs: 30, fetchFn: hanging as never }).load(),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    const { hashicorpProvider } = await import('../src/vault/hashicorp.js');
    await expect(
      hashicorpProvider({ url: 'https://x.test', path: 'p', timeoutMs: 30, fetchFn: hanging as never }).load(),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });
  it('vault option validation rejects cap-disabling values', () => {
    expect(() => httpProvider({ url: 'https://x', timeoutMs: Number.NaN })).toThrow(/E_USAGE/);
    expect(() => httpProvider({ url: 'https://x', maxBytes: 0 })).toThrow(/E_USAGE/);
    expect(() => awsProvider({ secrets: ['a'], timeoutMs: -1 })).toThrow(/E_USAGE/);
    expect(() => awsProvider({ secrets: ['a'], maxBytesSecret: Number.POSITIVE_INFINITY })).toThrow(/E_USAGE/);
    expect(() => awsProvider({ params: ['/a'], maxBytesParam: 0 })).toThrow(/E_USAGE/);
  });
  it('vault URLs are sanitized before reaching error text', async () => {
    const { sanitizeUrl } = await import('../src/vault/shared.js');
    expect(sanitizeUrl('https://u:s3cr3t@vault.test/?token=abc&v=1')).toBe('https://vault.test/?v=1');
    expect(sanitizeUrl('::not a url::')).toBe('::not a url::');
    const fetchFn = async () => ({ ok: false, status: 404, headers: new Headers() }) as Response;
    const prov = httpProvider({ url: 'https://u:s3cr3t@vault.test/?token=abc', fetchFn: fetchFn as never });
    try {
      await prov.load();
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('s3cr3t');
      expect(msg).not.toContain('token=abc');
      expect(msg).toContain('vault.test');
    }
  });
  it('withPrefix refuses prototype keys on both branches', async () => {
    const { withPrefix } = await import('../src/adapters/zod.js');
    const inner = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const w = withPrefix(inner as never, 'APP_') as unknown as { '~standard': { validate: (v: unknown) => unknown } };
    expect(() => w['~standard'].validate({ 'APP___proto__': { polluted: 1 } })).toThrow(/E_PROTO/);
    // NOTE: {'__proto__': ...} as a JS literal sets the prototype, not an own
    // key — build it via JSON.parse so the key actually exists to be rejected.
    expect(() => w['~standard'].validate(JSON.parse('{"__proto__":{"polluted":1}}'))).toThrow(/E_PROTO/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('withOverrides assimilates foreign thenables lacking .finally', async () => {
    const out = await withOverrides({ HARD2_PROBE: '1' }, () => ({ then: (res: (v: number) => void) => res(42) }) as never);
    expect(out).toBe(42);
    expect(process.env['HARD2_PROBE']).toBeUndefined();
  });
  it('settingsAsync maps deep-input overflow to E_DEPTH and rethrows raw I/O', async () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 100000; i++) v = { k: v };
    const deep = v;
    await expect(
      settingsAsync({ schema: z.object({}).passthrough(), sources: [{ provider: { name: 'p', load: async () => ({ top: deep }) } } as never], env: {} }),
    ).rejects.toMatchObject({ code: 'E_DEPTH' });
    await expect(
      settingsAsync({ schema: z.object({ a: z.string().default('x') }), sources: ['bad\0path.json'], env: {} }),
    ).rejects.toThrow();
  });
  it('async validation timeout surfaces E_TIMEOUT', async () => {
    const hanging = { '~standard': { version: 1, vendor: 't', validate: () => new Promise(() => {}) } };
    await expect(
      settingsAsync({ schema: hanging as never, sources: [{ map: {} }], env: {}, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });
  it('isSecretKey accepts duck-typed regexes; instanceof spans copies', () => {
    expect(isSecretKey('tok-x', [{ test: (s: string) => s.includes('tok') } as unknown as RegExp])).toBe(true);
    expect(isSecretKey('abc', [null as never, 42 as never, {} as never, { test: () => false } as never])).toBe(false);
    const duck = { name: 'ConfigError', code: 'E_X', issues: [], message: 'x' };
    expect(duck instanceof ConfigError).toBe(true);
    expect((null as unknown) instanceof ConfigError).toBe(false);
    expect(('ConfigError' as unknown) instanceof ConfigError).toBe(false);
    expect({ name: 'ConfigError' } instanceof ConfigError).toBe(false);
    expect({ name: 'ConfigError', code: 42, issues: [] } instanceof ConfigError).toBe(false);
    expect({ name: 'ConfigError', code: 'E', issues: {} } instanceof ConfigError).toBe(false);
    // A foreign copy's ConfigError keeps its code through the provider path.
    const prov = { name: 'foreign', load: () => { throw { name: 'ConfigError', code: 'E_CUSTOM', issues: [{ path: 'a', from: 'f', message: 'm' }], message: 'm' }; } };
    try {
      settings({ schema: z.object({ a: z.string().default('x') }), sources: [{ provider: prov } as never], env: {} });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CUSTOM');
    }
  });
  it('check json redacts numeric secrets; --secret-keys reaches the CLI', async () => {
    const dir = localTmp('ts-harden2-json');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, `import { z } from 'zod';\nexport const schema = z.object({ token_pin: z.number(), db_pass: z.string(), nick: z.string() });\n`);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ token_pin: 123456, db_pass: 'hunter2', nick: 'x' }));
    let logged = '';
    const orig = console.log;
    console.log = (s: string) => { logged += String(s); };
    try {
      const { runCheck } = await import('../src/cli/check.js');
      expect(await runCheck({ schema, config: cfg, expand: false, format: 'json' })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged).not.toContain('123456');
    expect(logged).toContain('nick');
    expect(logged).toContain('hunter2'); // default regex misses db_pass: the --secret-keys flag exists for this
    // Custom matcher via CLI flag.
    logged = '';
    console.log = (s: string) => { logged += String(s); };
    try {
      const { main } = await import('../src/cli/main.js');
      expect(await main(['check', '-s', schema, '-c', cfg, '--format', 'json', '--secret-keys', 'db_pass'])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logged).not.toContain('hunter2');
  });
});
describe('hardening2: iteration-1 safe fixes', () => {
  it('coerceDeep refuses proto keys on direct calls (sinkhole guard)', async () => {
    const { coerceDeep } = await import('../src/coerce.js');
    expect(() => coerceDeep(JSON.parse('{"__proto__":{"x":1}}'))).toThrow(/E_PROTO/);
    expect(() => coerceDeep(JSON.parse('{"A":{"__PROTO__":1}}'))).toThrow(/E_PROTO/);
    // constructor/prototype are inert own-data keys and pass through untouched.
    expect(coerceDeep(JSON.parse('{"a":{"Constructor":1}}'))).toEqual({ a: { Constructor: 1 } });
  });
  it('class-instance payloads cannot smuggle proto keys past the merge gate', () => {
    const c = new (class {})();
    Object.defineProperty(c, '__proto__', { value: { x: 1 }, enumerable: true });
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ map: { a: c } } as never], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_PROTO');
    }
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
  it('sparse-array errors print the real max index', () => {
    try {
      settings({ schema: z.object({}).passthrough(), sources: [{ map: { A__999999: 'x' } }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('0..999999');
    }
  });
  it('E_BAD_OP names the actual operator text', async () => {
    const { expandValue } = await import('../src/expand.js');
    const look = () => undefined;
    expect(() => expandValue('${A:?x}', look)).toThrow(/:\?x/);
    expect(() => expandValue('${A:}', look)).toThrow(/got :/);
  });
  it('lexical default nesting is capped for standalone expandValue', async () => {
    const { expandValue } = await import('../src/expand.js');
    let s = 'z';
    for (let i = 60; i >= 0; i--) s = `\${L${i}:-${s}}`;
    // Over-nested ${} is a depth failure (E_DEPTH), not a value-syntax error.
    expect(() => expandValue(s, () => undefined)).toThrow(/E_DEPTH: .*too deep/);
    expect(() => expandValue(s, () => undefined, { from: 'test-layer' })).toThrow(/test-layer/);
    expect(expandValue('${A:-${B:-z}}', () => undefined)).toBe('z');
  });
  it('TOML __proto__ tables do not pollute prototypes', async () => {
    const { parseTomlText } = await import('../src/formats/toml.js');
    // smol-toml builds null-prototype tables, so the hostile key arrives as an
    // own property (no setter side effects, globals untouched) ...
    const parsed = parseTomlText('["__proto__"]\nx = 1\n', 't') as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    // ... and the pipeline still fails closed on it.
    const g = globalThis as unknown as { __typedSettingsFs?: unknown };
    const saved = g.__typedSettingsFs;
    g.__typedSettingsFs = { readFileSync: () => '["__proto__"]\nx = 1\n' };
    try {
      expect(() => settings({ schema: z.object({}).passthrough(), sources: ['e.toml'], env: {}, expand: false, coerce: false })).toThrow(/E_PROTO/);
    } finally {
      if (saved !== undefined) g.__typedSettingsFs = saved;
      else delete g.__typedSettingsFs;
    }
  });
});
describe('hardening2: coercion preserves instances', () => {
  it('Date and class instances survive coercion (TOML dates stay Dates)', () => {
    const when = new Date('2024-05-01T12:00:00.000Z');
    const schema = z.object({ when: z.date(), name: z.string() });
    const out = settings({
      schema,
      sources: [{ map: { WHEN: when, NAME: 'x' } } as never],
      env: {},
      expand: false,
    });
    expect(out.when).toBe(when);
    expect(out.when instanceof Date).toBe(true);
  });
});
describe('hardening2: watch exotic leaves', () => {
  it('Dates diff by value; unstringifiable instances never crash', async () => {
    let d = new Date('2024-01-01T00:00:00.000Z');
    const prov = { name: 'p', load: (): Record<string, unknown> => ({ D: d }) };
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [{ provider: prov } as never], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    d = new Date('2024-01-01T00:00:00.000Z'); // equal instant, new instance
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual([]);
    d = new Date('2025-06-01T00:00:00.000Z');
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(['d']);
    await sub.dispose();
  });
  it('BigInt-holding instances report changed instead of throwing', async () => {
    class Box {
      constructor(public v: bigint) {}
    }
    let box: unknown = new Box(1n);
    const prov = { name: 'p', load: (): Record<string, unknown> => ({ B: box }) };
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [{ provider: prov } as never], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    box = new Box(2n);
    await sub.reload(); // JSON.stringify would throw — must not escape reload()
    expect(changed[changed.length - 1]).toEqual(['b']);
    await sub.dispose();
  });
});
describe('hardening2: watch key-order equality', () => {
  it('reordered keys report no change', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ o: { a: 1, b: 2 }, t: ['x'] }));
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    writeFileSync(file, JSON.stringify({ o: { b: 2, a: 1 }, t: ['x'] }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual([]);
    writeFileSync(file, JSON.stringify({ o: { b: 2, a: 9 }, t: ['y'] }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(expect.arrayContaining(['o.a', 't[0]']));
    await sub.dispose();
  });
});

describe('hardening2: schema ambiguity', () => {
  it('multiple schema exports require --schema-export', async () => {
    const dir = localTmp('ts-harden2-schema');
    const p = join(dir, 'schema.ts');
    writeFileSync(p, `import { z } from 'zod';\nexport const alpha = z.object({});\nexport const beta = z.object({});\n`);
    await expect(loadSchema(p)).rejects.toThrow(/--schema-export/);
    expect(await loadSchema(p, 'alpha')).toBeDefined();
  });
});

describe('hardening2: vault transport', () => {
  it('408/504 map to E_TIMEOUT', () => {
    expect(statusToCode(408)).toBe('E_TIMEOUT');
    expect(statusToCode(504)).toBe('E_TIMEOUT');
    expect(statusToCode(500)).toBe('E_UPSTREAM');
  });
  it('timeoutSignal degrades without AbortSignal.timeout', () => {
    expect(timeoutSignal(10, {})).toBeUndefined();
    expect(timeoutSignal(10, { timeout: () => { throw new Error('bad ms'); } })).toBeUndefined();
    expect(timeoutSignal(10)).toBeDefined();
  });
  it('garbage provider URL + redirect fails closed (never leaks auth)', async () => {
    // An invalid base URL cannot resolve any redirect target, so the redirect
    // chain fails closed with E_REDIRECT instead of leaking auth headers.
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return { status: 302, headers: new Headers({ location: 'https://vault.test/elsewhere' }) } as Response;
    };
    const prov = httpProvider({ url: '::not a url::', headers: { Authorization: 'Bearer s3cr3t' }, fetchFn: fetchFn as never });
    await expect(
      settingsAsync({ schema: z.object({ a: z.string() }), sources: [{ provider: prov }], env: {}, expand: false, coerce: false }),
    ).rejects.toMatchObject({ code: 'E_REDIRECT' });
    expect(calls).toEqual(['::not a url::']);
  });
  it('hanging body trips the body budget', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise<string>(() => {}) }) as Response;
    const prov = httpProvider({ url: 'https://x.test/s', timeoutMs: 30, fetchFn: fetchFn as never });
    await expect(prov.load()).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });
  it('SecretBinary decodes via Buffer, atob, or fails closed', async () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    const cStr = { getSecretValue: async () => ({ SecretBinary: b64 }) };
    expect(await awsProvider({ secrets: ['app/prod'], secretsClient: cStr as never }).load()).toMatchObject({ PROD: 'hello' });
    const raw = new TextEncoder().encode('hi');
    const cBin = { getSecretValue: async () => ({ SecretBinary: raw }) };
    expect(await awsProvider({ secrets: ['app/prod'], secretsClient: cBin as never }).load()).toMatchObject({ PROD: 'hi' });
    const g = globalThis as { Buffer?: unknown; atob?: unknown };
    const savedBuffer = g.Buffer;
    const savedAtob = g.atob;
    try {
      delete g.Buffer;
      if (g.Buffer !== undefined) return; // non-configurable global — cannot simulate
      expect(await awsProvider({ secrets: ['app/prod'], secretsClient: cStr as never }).load()).toMatchObject({ PROD: 'hello' });
      const cBin2 = { getSecretValue: async () => ({ SecretBinary: raw }) };
      expect(await awsProvider({ secrets: ['app/prod'], secretsClient: cBin2 as never }).load()).toMatchObject({ PROD: 'hi' });
      const cBad = { getSecretValue: async () => ({ SecretBinary: new Uint8Array([0xff, 0xfe, 0x00]) }) };
      await expect(awsProvider({ secrets: ['app/prod'], secretsClient: cBad as never }).load()).rejects.toMatchObject({ code: 'E_SHAPE' });
      delete g.atob;
      if (g.atob !== undefined) return;
      await expect(awsProvider({ secrets: ['app/prod'], secretsClient: cStr as never }).load()).rejects.toMatchObject({ code: 'E_NO_SDK' });
    } finally {
      g.Buffer = savedBuffer;
      g.atob = savedAtob;
    }
  });
});
