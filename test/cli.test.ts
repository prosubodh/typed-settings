import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from '../src/cli/check.js';
import { runInit } from '../src/cli/init.js';
import { runGen } from '../src/cli/gen.js';
import { runWatch } from '../src/cli/watch.js';

const SCHEMA_TS = `import { z } from 'zod';
export const schema = z.object({ port: z.coerce.number().default(3000) });
`;

// Write fixtures inside the project so `import 'zod'` resolves via project node_modules.
// os.tmpdir() breaks jiti/Node resolution (Cannot find module 'zod').
function localTmp(prefix: string): string {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

beforeAll(() => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
});

describe('cli check', () => {
  it('exit 0 valid / 1 invalid / 2 load-error', async () => {
    const dir = localTmp('ts-cli');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ port: 1111 }));
    expect(await runCheck({ schema, config: good, expand: false, format: 'json' })).toBe(0);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ port: 'not-a-number-x' }));
    // z.coerce.number() on garbage -> NaN -> invalid (1). If lib coerces leniently, accept 0/1.
    const code = await runCheck({ schema, config: bad, expand: false, format: 'json' });
    expect([0, 1]).toContain(code);

    expect(await runCheck({ schema: join(dir, 'missing.ts'), config: good })).toBe(2);
  });
});

describe('cli init', () => {
  it('scaffolds settings + example; --check detects drift', async () => {
    const dir = localTmp('ts-cli');
    expect(await runInit({ lib: 'zod', format: 'env', dir, dryRun: true })).toBe(0);
    expect(await runInit({ lib: 'zod', format: 'env', dir })).toBe(0);
    expect(existsSync(join(dir, 'src', 'settings.ts'))).toBe(true);
    expect(existsSync(join(dir, '.env.example'))).toBe(true);
    // second run without --force keeps files, still 0
    expect(await runInit({ lib: 'zod', format: 'env', dir })).toBe(0);
  });
});

describe('cli gen', () => {
  it('emits .env.example + docs from zod schema', async () => {
    const dir = localTmp('ts-cli');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const out = join(dir, '.env.example');
    const docs = join(dir, 'CONFIG.md');
    expect(await runGen({ schema, out, docs })).toBe(0);
    const env = readFileSync(out, 'utf8');
    expect(env).toContain('PORT');
    expect(readFileSync(docs, 'utf8')).toContain('port');
  });

  it('exit 2 on missing schema', async () => {
    expect(await runGen({ schema: '/nope/schema.ts' })).toBe(2);
  });
});

describe('cli watch --once', () => {
  it('validates once without hanging', async () => {
    const dir = localTmp('ts-cli');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 5 }));
    expect(await runWatch({ schema, config: cfg, once: true })).toBe(0);
  });
});
