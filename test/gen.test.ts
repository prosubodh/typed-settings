import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { type } from 'arktype';
import { describeSchema } from '../src/cli/describe.js';
import { runGen } from '../src/cli/gen.js';

function localTmp(prefix: string): string {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

describe('describeSchema: valibot', () => {
  it('walks entries with defaults + required', () => {
    const schema = v.object({
      port: v.optional(v.pipe(v.unknown(), v.transform(Number)), 3000),
      name: v.string(),
      mode: v.picklist(['a', 'b']),
    });
    const { fields, bestEffort } = describeSchema(schema);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['port']?.default).toBe(3000);
    expect(byPath['port']?.required).toBe(false);
    expect(byPath['name']?.required).toBe(true);
    expect(byPath['name']?.type).toBe('string');
    expect(byPath['mode']?.type).toContain('enum');
  });

  it('recurses nested objects', () => {
    const schema = v.object({ db: v.object({ host: v.string() }) });
    const { fields } = describeSchema(schema);
    expect(fields.map((f) => f.path)).toContain('db.host');
  });
});

describe('describeSchema: arktype', () => {
  it('walks json required/optional + defaults', () => {
    const schema = type({ port: 'number = 3000', name: 'string', 'opt?': 'string' });
    const { fields, bestEffort } = describeSchema(schema);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['port']?.default).toBe(3000);
    expect(byPath['port']?.required).toBe(false);
    expect(byPath['name']?.required).toBe(true);
    expect(byPath['opt']?.required).toBe(false);
  });

  it('recurses nested + arrays', () => {
    const schema = type({ db: { host: 'string' }, tags: 'string[]' });
    const { fields } = describeSchema(schema);
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('db.host');
    expect(fields.find((f) => f.path === 'tags')?.type).toBe('array');
  });
});

describe('describeSchema: unknown (Effect stand-in)', () => {
  it('returns GEN_BEST_EFFORT placeholder', () => {
    const { fields, bestEffort } = describeSchema({ kind: 'effect-like' });
    expect(bestEffort).toBe(true);
    expect(fields[0]?.description).toContain('GEN_BEST_EFFORT');
  });
});

describe('gen end-to-end: valibot + arktype', () => {
  it('valibot schema file generates PORT', async () => {
    const dir = localTmp('ts-gen');
    const schema = join(dir, 'schema.ts');
    writeFileSync(
      schema,
      `import * as v from 'valibot';\nexport const schema = v.object({ port: v.optional(v.number(), 3000) });\n`,
    );
    const out = join(dir, '.env.example');
    expect(await runGen({ schema, out })).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('PORT');
  });

  it('arktype schema file generates PORT', async () => {
    const dir = localTmp('ts-gen');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, `import { type } from 'arktype';\nexport const schema = type({ port: 'number = 3000' });\n`);
    const out = join(dir, '.env.example');
    expect(await runGen({ schema, out })).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('PORT');
  });
});
