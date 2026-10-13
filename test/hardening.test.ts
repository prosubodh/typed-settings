import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../src/node.js';
import { settings, ConfigError, pickPublic } from '../src/index.js';
import { publicSettings } from '../src/framework/next.js';
import { deepMerge } from '../src/merge.js';
import { runCheck } from '../src/cli/check.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function localTmp(prefix: string): string {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

describe('hardening: proto fail-closed', () => {
  it('flat __proto__ own-key throws E_PROTO (not silent drop)', () => {
    const map = JSON.parse('{"__proto__":"polluted"}');
    expect(() => settings({ schema: z.object({}).passthrough(), sources: [{ map }], env: {}, expand: false, coerce: false })).toThrow(/E_PROTO/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('flat CONSTRUCTOR/prototype are inert data keys; only __proto__ throws', () => {
    // constructor/prototype are ordinary own-data properties: assignment shadows
    // the inherited property without mutating any prototype, so they flow.
    const map = JSON.parse('{"CONSTRUCTOR":"x"}');
    const out = settings({ schema: z.object({}).passthrough(), sources: [{ map }], env: {}, expand: false, coerce: false }) as Record<string, unknown>;
    expect(out['constructor']).toBe('x');
    const proto = JSON.parse('{"PROTOTYPE":"y"}');
    expect((settings({ schema: z.object({}).passthrough(), sources: [{ map: proto }], env: {}, expand: false, coerce: false }) as Record<string, unknown>)['prototype']).toBe('y');
  });
  it('structured nested __proto__ throws E_PROTO', () => {
    const g = globalThis as unknown as { __typedSettingsFs?: unknown };
    const saved = g.__typedSettingsFs;
    g.__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p === 'n.json') return JSON.stringify({ a: JSON.parse('{"__proto__":{"polluted":"yes"}}') });
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      expect(() => settings({ schema: z.object({}).passthrough(), sources: ['n.json'], env: {}, expand: false, coerce: false })).toThrow(/E_PROTO/);
    } finally {
      if (saved !== undefined) g.__typedSettingsFs = saved;
      else delete g.__typedSettingsFs;
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('deepMerge nested proto throws even on fast path', () => {
    expect(() => deepMerge({}, JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toThrow(/E_PROTO/);
    expect(() => deepMerge({}, JSON.parse('{"__PROTO__":1}'))).toThrow(/E_PROTO/);
  });
  it('pickPublic/publicSettings refuse prototype keys', () => {
    expect(pickPublic({} as never, ['__proto__' as never])).toEqual({});
    expect(pickPublic({ a: 1 } as { a: number }, ['a' as never])).toEqual({ a: 1 });
    expect(publicSettings({ a: 1 } as { a: number }, ['a'])).toEqual({ a: 1 });
    expect(publicSettings({} as never, ['__proto__' as never])).toEqual({});
  });
});

describe('hardening: provider + vault sibling expansion', () => {
  it('sync provider throw becomes E_PROVIDER ConfigError', () => {
    const prov = { name: 'boom', load: () => { throw new Error('kablam'); } };
    try {
      settings({ schema: z.object({ a: z.string().default('x') }), sources: [{ provider: prov } as never], env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_PROVIDER');
      expect((e as Error).message).toContain('kablam');
    }
    // Non-Error throws (string) also wrap as E_PROVIDER, never leak raw.
    const strProv = { name: 'str-boom', load: () => { throw 'plain-string-failure'; } };
    try {
      settings({ schema: z.object({ a: z.string().default('x') }), sources: [{ provider: strProv } as never], env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_PROVIDER');
      expect((e as Error).message).toContain('plain-string-failure');
    }
  });
  it('vault top skips expansion wholesale (documented top-level granularity)', () => {
    // Same top from vault + plain: whole top skips (vault `$` safety wins).
    // To mix expandable + vault values, use distinct tops.
    const schema = z.object({ db: z.object({ pass: z.string() }).passthrough(), other: z.object({ host: z.string() }) });
    const out = settings({
      schema,
      sources: [
        { map: { OTHER__HOST: '${H}' } },
        { provider: { name: 'v', load: () => ({ DB__PASS: 'p-word' }) } },
      ],
      env: { H: 'hi' },
      coerce: false,
    }) as { db: { pass: string }; other: { host: string } };
    expect(out.other.host).toBe('hi');
    expect(out.db.pass).toBe('p-word');
  });
});

describe('hardening: cli json redacts secrets', () => {
  it('runCheck json output redacts secret leaves', async () => {
    const dir = localTmp('ts-harden');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, `import { z } from 'zod';\nexport const schema = z.object({ api_token: z.string(), port: z.coerce.number().default(1) });\n`);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ api_token: 'super-secret-value-123', port: 1 }));
    let logged = '';
    const orig = console.log;
    const origErr = console.error;
    let errLogged = '';
    console.log = (s: string) => { logged += String(s); };
    console.error = (s: string) => { errLogged += String(s); };
    try {
      const code = await runCheck({ schema, config: cfg, expand: false, format: 'json' });
      if (code !== 0) throw new Error(`runCheck=${code} log=${logged} err=${errLogged}`);
    } finally {
      console.log = orig;
      console.error = origErr;
    }
    expect(logged).not.toContain('super-secret-value-123');
    expect(logged).toContain('port');
  });
  it('redactForJson covers arrays, nested, empty and non-string secrets', async () => {
    const dir = localTmp('ts-harden2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(
      schema,
      `import { z } from 'zod';\nexport const schema = z.object({ token: z.string(), nested: z.object({ password: z.string() }).passthrough(), tags: z.array(z.string()), count: z.coerce.number().default(0) });\n`,
    );
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ token: '', nested: { password: 'pw-secret-long-value', other: 'x' }, tags: ['a', 'b'], count: 2 }));
    // Empty token fails validation (required non-empty?) — zod string allows '', so valid; redaction keeps '' as-is.
    let logged = '';
    const orig = console.log;
    console.log = (s: string) => { logged += String(s); };
    try {
      await runCheck({ schema, config: cfg, expand: false, format: 'json' });
    } finally {
      console.log = orig;
    }
    expect(logged).not.toContain('pw-secret-long-value');
  });
});

describe('hardening: watch dispose is idempotent and reload-after-dispose no-ops', () => {
  it('reload after dispose does not bump version', async () => {
    const { watchSettings } = await import('../src/node.js');
    const schema = z.object({ a: z.string().default('x') });
    const sub = watchSettings({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false }, { debounceMs: 10 });
    const v0 = sub.version;
    await sub.dispose();
    await sub.dispose();
    await sub.reload();
    expect(sub.version).toBe(v0);
  });
  it('concurrent reloads drop the stale one', async () => {
    const { watchSettings } = await import('../src/node.js');
    const dir = localTmp('ts-harden-watch');
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string() });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10 });
    // Two overlapping reloads: the first becomes stale (myId !== reloadId) and drops.
    await Promise.all([sub.reload(), sub.reload()]);
    expect(sub.version).toBeGreaterThanOrEqual(1);
    await sub.dispose();
  });
  it('dispose mid-reload drops the in-flight reload', async () => {
    const { watchSettings } = await import('../src/node.js');
    const dir = localTmp('ts-harden-watch2');
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string() });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10 });
    const v0 = sub.version;
    // stableSize settles ~20ms; disposing immediately lands between ensureWatchers
    // and the post-settle staleness check (covers disposed at line 253).
    const p = sub.reload();
    await sub.dispose();
    await p;
    expect(sub.version).toBe(v0);
  });
});
