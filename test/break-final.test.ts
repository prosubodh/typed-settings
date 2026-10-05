import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandValue } from '../src/expand.js';
import { parseYamlText } from '../src/formats/yaml.js';
import { byteLengthUtf8 } from '../src/errors.js';
import { parseEnvText } from '../src/formats/env.js';
import { expandKeys } from '../src/merge.js';
import { settings } from '../src/index.js';
import { z } from 'zod';
import { runInit } from '../src/cli/init.js';
import { runGen } from '../src/cli/gen.js';

const localTmp = (prefix: string): string => {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
};

describe('break: expand literal-fallthrough and yaml aliases', () => {
  it('${ without a valid name stays literal', () => {
    expect(expandValue('${}x', () => undefined, { allowUnresolved: true })).toBe('${}x');
    expect(expandValue('${9lives}', () => undefined, { allowUnresolved: true })).toBe('${9lives}');
  });

  it('unresolvable yaml aliases are ParseError, not raw throws', () => {
    expect(() => parseYamlText('a: *missing', 'myfile')).toThrow(/ParseError \(myfile\)/);
  });

  it('circular yaml anchors fail closed with E_CYCLE at load', () => {
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p === 'c.yaml') return 'a: &x [*x]';
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      expect(() =>
        settings({ schema: z.object({}).passthrough(), sources: ['c.yaml'], env: {}, expand: false, coerce: false }),
      ).toThrow(/E_CYCLE/);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });

  it('envMap present but unmatched falls through normally', () => {
    expect(expandKeys({ OTHER: 'v' }, { envMap: { FOO: 'a__b' }, prefix: 'APP_' })).toEqual({});
    expect(expandKeys({ APP_X: 'v' }, { envMap: { FOO: 'a__b' }, prefix: 'APP_' })).toEqual({ x: 'v' });
  });

  it('.env double-quote \\r \\t and escaped quotes', () => {
    expect(parseEnvText('A="a\\rb\\tc\\"d"')).toEqual({ A: 'a\rb\tc"d' });
  });
});

describe('break: byteLengthUtf8 fallbacks', () => {
  it('uses Buffer when TextEncoder is hidden, length when both are gone', () => {
    expect(byteLengthUtf8('é')).toBe(2);
    const g = globalThis as Record<string, unknown>;
    const savedTE = g['TextEncoder'];
    const savedBuf = g['Buffer'];
    g['TextEncoder'] = undefined;
    try {
      expect(byteLengthUtf8('é')).toBe(2); // Buffer path
    } finally {
      g['TextEncoder'] = savedTE;
    }
    g['TextEncoder'] = undefined;
    g['Buffer'] = undefined;
    try {
      expect(byteLengthUtf8('é')).toBe('é'.length); // last-resort fallback
    } finally {
      g['TextEncoder'] = savedTE;
      g['Buffer'] = savedBuf;
    }
    g['TextEncoder'] = () => {
      throw new Error('nope');
    };
    try {
      expect(byteLengthUtf8('é')).toBe('é'.length); // constructor throw -> catch
    } finally {
      g['TextEncoder'] = savedTE;
      g['Buffer'] = savedBuf;
    }
  });
});

describe('break: init drift and force', () => {
  it('bare defaults scaffold zod+env into cwd', async () => {
    const dir = localTmp('ts-final');
    const prev = process.cwd();
    process.chdir(dir);
    try {
      expect(await runInit({})).toBe(0);
      expect(readFileSync(join(dir, '.env.example'), 'utf8')).toContain('APP_PORT');
    } finally {
      process.chdir(prev);
    }
  });

  it('--check flags content drift, not just missing files', async () => {
    const dir = localTmp('ts-final');
    expect(await runInit({ lib: 'zod', format: 'env', dir })).toBe(0);
    expect(await runInit({ lib: 'zod', format: 'env', dir, check: true })).toBe(0);
    expect(await runInit({ lib: 'zod', format: 'env', dir, check: true })).toBe(0);
    writeFileSync(join(dir, '.env.example'), 'tampered\n');
    expect(await runInit({ lib: 'zod', format: 'env', dir, check: true })).toBe(2);
    expect(await runInit({ lib: 'zod', format: 'env', dir, dryRun: true })).toBe(0);
  });

  it('--force refreshes content in place', async () => {
    const dir = localTmp('ts-final');
    expect(await runInit({ lib: 'valibot', format: 'yaml', dir })).toBe(0);
    const p = join(dir, 'config.yaml');
    writeFileSync(p, 'tampered\n');
    expect(await runInit({ lib: 'valibot', format: 'yaml', dir })).toBe(0); // skipped, no force
    expect(readFileSync(p, 'utf8')).toBe('tampered\n');
    expect(await runInit({ lib: 'valibot', format: 'yaml', dir, force: true })).toBe(0);
    expect(readFileSync(p, 'utf8')).toContain('port: 3000');
  });
});

describe('break: gen destinations', () => {
  const SCHEMA = `import { z } from 'zod';\nexport const schema = z.object({ port: z.coerce.number().default(3000) });\n`;
  it('unknown schemas warn GEN_BEST_EFFORT and still emit placeholders', async () => {
    const dir = localTmp('ts-final');
    const schema = join(dir, 'custom.ts');
    writeFileSync(
      schema,
      `export const schema = { '~standard': { version: 1, vendor: 'custom', validate: (v) => ({ value: v }) } };\n`,
    );
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a);
    try {
      const out = join(dir, '.env.example');
      expect(await runGen({ schema, out })).toBe(0);
      expect(errs.some((a) => String(a[0]).includes('GEN_BEST_EFFORT'))).toBe(true);
      expect(readFileSync(out, 'utf8')).toContain('GEN_BEST_EFFORT');
    } finally {
      console.error = orig;
    }
  });

  it('stdout mode prints both artifacts; docs guard matches out guard', async () => {
    const dir = localTmp('ts-final');
    const schema = join(dir, 's.ts');
    writeFileSync(schema, SCHEMA);
    const logged: unknown[][] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logged.push(a);
    try {
      expect(await runGen({ schema })).toBe(0);
    } finally {
      console.log = orig;
    }
    const all = logged.map((a) => String(a[0])).join('\n');
    expect(all).toContain('PORT');
    expect(all).toContain('# Configuration');
    // docs-only mode still writes the file; existing docs are guarded too.
    const docs = join(dir, 'CONFIG.md');
    expect(await runGen({ schema, docs })).toBe(0);
    expect(await runGen({ schema, docs })).toBe(2);
    expect(await runGen({ schema, docs, force: true })).toBe(0);
  });
});

describe('break: error message shapes', () => {
  it('singular vs plural issue counts render correctly', async () => {
    const { ConfigError } = await import('../src/errors.js');
    const one = new ConfigError([{ path: 'a', from: 'env', message: 'bad' }]);
    expect(one.message).toContain('(1 issue)');
    expect(one.message).not.toContain('issues');
    const two = new ConfigError(
      [
        { path: 'a', from: 'env', message: 'bad' },
        { path: 'b', from: 'env', message: 'worse' },
      ],
      'E_TWO',
    );
    expect(two.message).toContain('(2 issues)');
    expect(two.code).toBe('E_TWO');
  });
});
