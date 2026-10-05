import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema } from '../src/cli/load-schema.js';
import { runCheck } from '../src/cli/check.js';
import { withOverrides } from '../src/index.js';
import type { Flat } from '../src/index.js';
import '../src/node.js'; // real fs hook: file sources hit the filesystem here

const localTmp = (prefix: string): string => {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
};

const ZOD_OBJ = `import { z } from 'zod';\nexport const schema = z.object({ port: z.coerce.number().default(3000) });\n`;

describe('break: load-schema export resolution', () => {
  it('explicit --schema-export hits, typos fail loudly', async () => {
    const dir = localTmp('ts-ls');
    const f = join(dir, 's.ts');
    writeFileSync(f, `${ZOD_OBJ}export const other = 42;\n`);
    await expect(loadSchema(f, 'schema')).resolves.toBeDefined();
    await expect(loadSchema(f, 'typo')).rejects.toThrow(/--schema-export "typo"/);
    await expect(loadSchema(f, 'other')).rejects.toThrow(/--schema-export "other"/);
  });

  it('default-only and settingsSchema-only files resolve', async () => {
    const dir = localTmp('ts-ls');
    const d = join(dir, 'def.ts');
    writeFileSync(d, `import { z } from 'zod';\nexport default z.object({ port: z.coerce.number().default(1) });\n`);
    await expect(loadSchema(d)).resolves.toBeDefined();
    const s = join(dir, 's.ts');
    writeFileSync(s, `import { z } from 'zod';\nexport const settingsSchema = z.object({ port: z.coerce.number().default(1) });\n`);
    await expect(loadSchema(s)).resolves.toBeDefined();
  });

  it('CJS module.exports = schema resolves via the module object', async () => {
    const dir = localTmp('ts-ls');
    const f = join(dir, 'c.cjs');
    writeFileSync(f, `const { z } = require('zod');\nmodule.exports = z.object({ port: z.coerce.number().default(1) });\n`);
    await expect(loadSchema(f)).resolves.toBeDefined();
  });

  it('first-standard-export fallback and total absence', async () => {
    const dir = localTmp('ts-ls');
    const f = join(dir, 'o.ts');
    writeFileSync(f, `import { z } from 'zod';\nexport const whatever = z.object({ port: z.coerce.number().default(1) });\n`);
    await expect(loadSchema(f)).resolves.toBeDefined();
    const n = join(dir, 'n.ts');
    writeFileSync(n, `export const x = 1;\n`);
    await expect(loadSchema(n)).rejects.toThrow(/no Standard Schema export/);
  });
});

describe('break: check branches', () => {
  it('non-schema errors become E_LOAD (exit 2) in both formats', async () => {
    const dir = localTmp('ts-check');
    const schema = join(dir, 's.ts');
    writeFileSync(schema, ZOD_OBJ);
    // Null bytes make readFileSync throw a raw TypeError (not a ConfigError).
    expect(await runCheck({ schema, config: 'bad\0path.json' })).toBe(2);
    expect(await runCheck({ schema, config: 'bad\0path.json', format: 'json' })).toBe(2);
    // Load failures also report as JSON when asked.
    expect(await runCheck({ schema: join(dir, 'missing.ts'), format: 'json' })).toBe(2);
  });

  it('empty config string falls back to .env,env; expand:false direct', async () => {
    const dir = localTmp('ts-check');
    const schema = join(dir, 's.ts');
    writeFileSync(schema, ZOD_OBJ);
    // Isolate from the ambient environment: any $VAR in a process.env value
    // (e.g. Windows PROMPT=$P$G) would otherwise fail expansion here.
    const scrub: Flat = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v?.includes('$')) scrub[k] = undefined;
    }
    await withOverrides(scrub, async () => {
      expect(await runCheck({ schema, config: '' })).toBe(0);
      expect(await runCheck({ schema })).toBe(0); // config omitted -> same default
    });
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 7 }));
    expect(await runCheck({ schema, config: cfg, expand: false, strict: true })).toBe(0);
  });
});
