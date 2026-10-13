import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';
import { settings, ConfigError, withOverrides } from '../src/index.js';
import { describeSchema, toEnvExample, toMarkdownDocs, envKey } from '../src/cli/describe.js';
import { loadSchema } from '../src/cli/load-schema.js';
import { runGen } from '../src/cli/gen.js';
import { runInit } from '../src/cli/init.js';
import { viteSettingsAsync } from '../src/framework/vite.js';
import { publicSettings } from '../src/framework/next.js';

function localTmp(prefix: string): string {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

const scrubAppEnv = async <T>(fn: () => T): Promise<T> => {
  const scrub: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith('APP_')) scrub[k] = undefined;
  }
  return withOverrides(scrub, fn);
};

describe('hardening3: approved breaking fixes', () => {
  it('env-layer cycles and bad ops throw like file layers (only unresolved degrades)', () => {
    const schema = z.object({ a: z.string(), b: z.string().optional() }).passthrough();
    // Cycles are fatal everywhere now.
    expect(() => settings({ schema: schema as never, sources: ['env'], env: { A: '$B', B: '$A' }, coerce: false })).toThrow(/E_CIRCULAR/);
    // Unresolved ambient names still degrade to literals (shell-prompt safety).
    const out = settings({ schema: schema as never, sources: ['env'], env: { A: 'cost $5 and $P' }, coerce: false }) as Record<string, string>;
    expect(out['a']).toBe('cost $5 and $P');
    // Ambient env keys outside the charset (OS vars like Windows `ProgramFiles(x86)`)
    // are skipped, not fatal. Asserted explicitly so the branch is covered on every
    // platform, not just where the host env happens to contain such keys.
    expect(() =>
      settings({ schema: schema as never, sources: ['env'], env: { A: 'ok', 'ProgramFiles(x86)': 'C:\\' }, coerce: false }),
    ).not.toThrow();
  });
  it('dotenv-quoted commas stay strings end to end', () => {
    const schema = z.object({ greeting: z.string() });
    const out = settings({ schema, sources: [{ text: 'GREETING="hello, world"' }], env: {}, expand: false });
    expect(out.greeting).toBe('hello, world');
  });
  it('unterminated ${ at the pipeline blames the leaf and throws E_EXPAND', () => {
    try {
      settings({ schema: z.object({ a: z.string() }), sources: [{ map: { A: '${B' } }], env: {}, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_EXPAND');
      expect((e as ConfigError).issues[0]?.message).toMatch(/unterminated/);
    }
  });
});
describe('hardening3: ConfigError envelope', () => {
  it('empty issues render a sane message, not a crash', () => {
    const e = new ConfigError();
    expect(e.code).toBe('E_INVALID_CONFIG');
    expect(e.message).toContain('unknown error');
    expect(e.issues).toEqual([]);
  });
});

describe('hardening3: legacy bridge async edges', () => {
  it('async Joi validate is failure, not a frozen Promise', async () => {
    const { joiAdapter } = await import('../src/adapters/joi.js');
    const out = joiAdapter({ validate: async () => ({ value: {} }) } as never)['~standard'].validate({});
    expect(out).toMatchObject({ issues: [{ message: expect.stringContaining('USE_ASYNC') }] });
  });
  it('throwing superstruct failures() falls back to the message', async () => {
    const { superstructAdapter } = await import('../src/adapters/superstruct.js');
    const bad = {
      create: () => {
        const e = new Error('ss') as Error & { failures: () => never[] };
        e.failures = () => { throw new Error('reporter boom'); };
        throw e;
      },
    };
    expect(superstructAdapter(bad as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'ss' }],
    });
  });
});

describe('hardening3: describe fidelity pins', () => {
  it('canonical coerce schema describes as number with default', () => {
    const { fields, bestEffort } = describeSchema(z.object({ port: z.coerce.number().default(3000) }));
    expect(bestEffort).toBe(false);
    expect(fields.find((f) => f.path === 'port')).toMatchObject({ type: 'number', required: false, default: 3000 });
  });
  it('optional parents make children optional (zod + valibot)', () => {
    const zf = describeSchema(z.object({ db: z.object({ host: z.string() }).optional() }));
    expect(zf.fields.find((f) => f.path === 'db.host')).toMatchObject({ required: false });
    const vf = describeSchema(v.object({ db: v.optional(v.object({ host: v.string() })) }));
    expect(vf.fields.find((f) => f.path === 'db.host')).toMatchObject({ required: false });
    // Required parents keep required children.
    const zr = describeSchema(z.object({ db: z.object({ host: z.string() }) }));
    expect(zr.fields.find((f) => f.path === 'db.host')).toMatchObject({ required: true });
  });
  it('legacy Zod3 date/bigint shapes render honestly', () => {
    const { fields } = describeSchema({
      shape: {
        d: { _def: { typeName: 'ZodDate' } },
        b: { _def: { typeName: 'ZodBigInt' } },
        n: { _def: { typeName: 'ZodNaN' } },
      },
    });
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['d']?.type).toBe('date');
    expect(byPath['b']?.type).toBe('bigint');
    expect(byPath['n']?.type).toBe('number');
  });
  it('envKey normalizes prefixes and sanitizes keys', () => {
    expect(envKey('APP', 'port')).toBe('APP_PORT');
    expect(envKey('APP_', 'port')).toBe('APP_PORT');
    expect(envKey('', 'db.host')).toBe('DB__HOST');
    expect(envKey('APP_', 'weird-key.x')).toBe('APP_WEIRD_KEY__X');
  });
});

describe('hardening3: init templates execute', () => {
  it.each(['zod', 'valibot', 'arktype'] as const)('%s template loads and validates', async (lib) => {
    const dir = localTmp(`ts-harden3-init-${lib}`);
    await scrubAppEnv(async () => {
      expect(await runInit({ lib, format: 'env', dir })).toBe(0);
      expect(await loadSchema(join(dir, 'src', 'settings.ts'))).toBeDefined();
    });
  });
  it('valibot template rejects garbage ports', () => {
    const schema = v.object({ port: v.optional(v.pipe(v.unknown(), v.transform(Number), v.number()), 3000) });
    expect(() => settings({ schema: schema as never, sources: [{ map: { APP_PORT: 'abc' } }], prefix: 'APP_', env: {}, expand: false })).toThrow();
    expect(
      (settings({ schema: schema as never, sources: [{ map: { APP_PORT: '5' } }], prefix: 'APP_', env: {}, expand: false }) as { port: number }).port,
    ).toBe(5);
  });
  it('arktype number idiom validates coerced env strings', () => {
    const schema = type({ port: 'number = 3000' });
    expect(
      (settings({ schema: schema as never, sources: [{ map: { APP_PORT: '3000' } }], prefix: 'APP_', env: {}, expand: false }) as { port: number }).port,
    ).toBe(3000);
  });
  it('prototype-named lib/format are usage errors, not crashes', async () => {
    expect(await runInit({ lib: 'constructor' as never, dir: localTmp('ts-h3-a') })).toBe(2);
    expect(await runInit({ format: 'constructor' as never, dir: localTmp('ts-h3-b') })).toBe(2);
  });
});

describe('hardening3: gen goldens beyond zod', () => {
  it('valibot and arktype schemas generate examples', async () => {
    for (const [name, body] of [
      ['v', `import * as v from 'valibot';\nexport const schema = v.object({ port: v.optional(v.number(), 3000) });\n`],
      ['a', `import { type } from 'arktype';\nexport const schema = type({ port: 'number = 3000' });\n`],
    ] as const) {
      const dir = localTmp(`ts-harden3-gen-${name}`);
      const schema = join(dir, 'schema.ts');
      writeFileSync(schema, body);
      const out = join(dir, '.env.example');
      const docs = join(dir, 'CONFIG.md');
      expect(await runGen({ schema, out, docs })).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain('PORT');
      expect(readFileSync(docs, 'utf8')).toContain('port');
    }
  });
});

describe('hardening3: framework bindings', () => {
  it('viteSettingsAsync awaits async schemas', async () => {
    const schema = { '~standard': { version: 1, vendor: 't', validate: async (v: unknown) => ({ value: v }) } };
    const out = (await viteSettingsAsync({ schema } as never, { PORT: '1' })) as Record<string, unknown>;
    expect(out['port']).toBe(1);
  });
  it('publicSettings omits missing keys (Partial, not Pick)', () => {
    const pub = publicSettings({ a: 1 } as { a: number; b: number }, ['a', 'b'] as const);
    expect(pub).toEqual({ a: 1 });
    expect('b' in pub).toBe(false);
  });
});
