import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { loadEnvFiles, loadSecretsDir, parseEnvFile, watchSettings } from '../src/node.js';
import { withOverrides } from '../src/index.js';
import type { Flat } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ts-break-node-'));

describe('break: loadEnvFiles', () => {
  it('joins parts with newline and skips missing files', () => {
    const dir = tmp();
    const a = join(dir, 'a.env');
    writeFileSync(a, 'A=1');
    expect(loadEnvFiles([a, join(dir, 'missing.env')])).toEqual({ text: 'A=1' });
  });

  it('non-ENOENT read errors propagate raw (never swallowed)', () => {
    expect(() => loadEnvFiles(['bad\0path.env'])).toThrow(TypeError);
  });
});

describe('break: loadSecretsDir', () => {
  it('preserves significant whitespace, skips empties and .. entries', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'PW'), 's3cr3t \n');
    writeFileSync(join(dir, 'LEAD'), '  lead');
    writeFileSync(join(dir, 'EMPTY'), '\n');
    writeFileSync(join(dir, '..hidden'), 'x');
    mkdirSync(join(dir, 'subdir'));
    const out = loadSecretsDir(dir);
    expect(out['PW']).toBe('s3cr3t ');
    expect(out['LEAD']).toBe('  lead');
    expect(out['EMPTY']).toBeUndefined();
    expect(out['..HIDDEN']).toBeUndefined();
    expect(out['SUBDIR']).toBeUndefined();
  });

  it('missing dir is {}, file-as-dir and bad paths throw', () => {
    expect(loadSecretsDir(join(tmpdir(), `nope-${Date.now()}`))).toEqual({});
    const dir = tmp();
    const file = join(dir, 'f.env');
    writeFileSync(file, 'x');
    expect(() => loadSecretsDir(file)).toThrow(); // ENOTDIR, not ENOENT
    expect(() => loadSecretsDir('bad\0dir')).toThrow(TypeError);
  });
});

describe('break: parseEnvFile', () => {
  it('parses, returns {} when missing, rethrows raw errors', () => {
    const dir = tmp();
    const p = join(dir, 'a.env');
    writeFileSync(p, 'A=1');
    expect(parseEnvFile(p)).toEqual({ A: '1' });
    expect(parseEnvFile(join(dir, 'missing.env'))).toEqual({});
    expect(() => parseEnvFile('bad\0path')).toThrow(TypeError);
  });
});

describe('break: watch sources', () => {
  it('omitted sources default to .env,env with no watchers', async () => {
    const scrub: Flat = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v?.includes('$')) scrub[k] = undefined;
    }
    await withOverrides(scrub, async () => {
      const schema = z.object({ port: z.coerce.number().default(1) });
      const sub = watchSettings({ schema }, { debounceMs: 10000 });
      expect((sub.get() as { port: number }).port).toBe(1);
      await sub.dispose();
    });
  });

  it("'env' is not watched as a file", async () => {
    const schema = z.object({ port: z.coerce.number().default(1) });
    const sub = watchSettings({ schema, sources: ['env'], env: {}, expand: false }, { debounceMs: 10 });
    expect(sub.version).toBe(0);
    await sub.reload();
    expect(sub.version).toBe(1);
    await sub.dispose();
  });

  it('.env.local and bare shorthand paths are watched', async () => {
    const dir = tmp();
    const prev = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, '.env.local'), 'PORT=10');
      writeFileSync(join(dir, 'custom.cfg'), 'PORT=20');
      const schema = z.object({ port: z.coerce.number().default(0) });
      const seen: number[] = [];
      const sub = watchSettings(
        { schema, sources: ['.env.local', 'custom.cfg', { file: 'custom.cfg' }], env: {}, expand: false, coerce: false },
        // Large debounce: file writes must not schedule a competing reload that
        // drops this test's manual reload() via the generation counter.
        { debounceMs: 10000, onUpdate: (cfg) => void seen.push((cfg as { port: number }).port) },
      );
      // Last layer wins: custom.cfg (20) over .env.local (10).
      expect((sub.get() as { port: number }).port).toBe(20);
      writeFileSync(join(dir, '.env.local'), 'PORT=99');
      writeFileSync(join(dir, 'custom.cfg'), 'PORT=30');
      await sub.reload();
      expect((sub.get() as { port: number }).port).toBe(30);
      await sub.dispose();
    } finally {
      process.chdir(prev);
    }
  });

  it('missing files settle without hanging; diff reports nested changes', async () => {
    const dir = tmp();
    const file = join(dir, 'gone.json');
    const schema = z.object({
      db: z.object({ host: z.string(), port: z.coerce.number().optional() }).default({ host: 'h' }),
    });
    const changed: string[][] = [];
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    expect((sub.get() as { db: { host: string } }).db.host).toBe('h');
    writeFileSync(file, JSON.stringify({ db: { host: 'x', port: 2 } }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(expect.arrayContaining(['db.host', 'db.port']));
    // Removing a key reports it; reloading identical content reports nothing.
    writeFileSync(file, JSON.stringify({ db: { host: 'y' } }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(expect.arrayContaining(['db.port']));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual([]);
    await sub.dispose();
  });

  it('root-level arrays diff with bare indexes (custom array schema)', async () => {
    const dir = tmp();
    const file = join(dir, 'arr.json');
    writeFileSync(file, JSON.stringify(['a']));
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    writeFileSync(file, JSON.stringify(['a', 'b']));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(['[1]']);
    await sub.dispose();
  });

  it("'.env' by exact name is watched", async () => {
    const dir = tmp();
    const prev = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, '.env'), 'PORT=11');
      const schema = z.object({ port: z.coerce.number().default(0) });
      const sub = watchSettings({ schema, sources: ['.env'], env: {}, expand: false, coerce: false }, { debounceMs: 10000 });
      expect((sub.get() as { port: number }).port).toBe(11);
      await sub.dispose();
    } finally {
      process.chdir(prev);
    }
  });

  it('dispose from inside schema validation drops the reload', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    let sub: { dispose(): Promise<void>; reload(): Promise<void>; version: number } | undefined;
    let calls = 0;
    let updates = 0;
    const schema = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: (v: unknown) => {
          calls++;
          // Second validation runs inside doReload's settings(): disposing here
          // flips the flag between the two staleness checks.
          if (calls === 2) void sub?.dispose();
          return { value: v };
        },
      },
    };
    sub = watchSettings({ schema: schema as never, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: () => void updates++,
    });
    expect(calls).toBe(1);
    await sub.reload();
    expect(updates).toBe(0);
    expect(sub.version).toBe(0);
    await sub.dispose();
  });

  it('root shape changes report <root> (scalar vs object)', async () => {
    const dir = tmp();
    const file = join(dir, 'shape.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const fake = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };
    const changed: string[][] = [];
    const sub = watchSettings({ schema: fake as never, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    writeFileSync(file, '"justastring"');
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(['<root>']);
    await sub.dispose();
  });

  it('array grow/shrink shows indexed diff paths', async () => {
    const dir = tmp();
    const file = join(dir, 'arr.json');
    writeFileSync(file, JSON.stringify({ tags: ['a'] }));
    const schema = z.object({ tags: z.array(z.string()) });
    const changed: string[][] = [];
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (_cfg, c) => void changed.push(c),
    });
    writeFileSync(file, JSON.stringify({ tags: ['a', 'b'] }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(['tags[1]']);
    writeFileSync(file, JSON.stringify({ tags: [] }));
    await sub.reload();
    expect(changed[changed.length - 1]).toEqual(expect.arrayContaining(['tags[0]']));
    await sub.dispose();
  });
});
