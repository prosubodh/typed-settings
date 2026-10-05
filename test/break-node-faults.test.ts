import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const faults = vi.hoisted(() => ({
  map: new Map<string, { code?: string; fns?: string[] }>(),
  fakeWatch: false,
  watchers: [] as { dir: string; onChange: (...a: unknown[]) => void; handlers: Record<string, ((...a: never[]) => void)[]> }[],
  // Scripted statSync outcomes, consumed in order: 'ok' passthrough, 'enoent' throws
  // ENOENT, or { size, mtimeMs } to fake an (un)stable file.
  statScript: [] as ({ size: number; mtimeMs: number } | 'ok' | 'enoent')[],
  statCalls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  const faultFor = (fn: string, p: unknown): { code?: string } | null => {
    if (typeof p !== 'string') return null;
    for (const [key, spec] of faults.map) {
      if (p.includes(key) && (!spec.fns || spec.fns.includes(fn))) return spec;
    }
    return null;
  };
  const wrap = <A extends unknown[], R>(fn: (...a: A) => R, name: string) =>
    (...args: A): R => {
      const f = faultFor(name, args[0]);
      if (f) {
        const e = new Error(`${name} fault`) as NodeJS.ErrnoException;
        if (f.code) e.code = f.code;
        throw e;
      }
      return (fn as (...a: A) => R)(...args);
    };
  return {
    ...orig,
    readFileSync: wrap(orig.readFileSync, 'readFileSync'),
    statSync: (...args: unknown[]) => {
      if (faults.statScript.length > 0) {
        faults.statCalls++;
        const next = faults.statScript.shift()!;
        if (next === 'enoent') {
          const e = new Error('stat fault') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        }
        if (next !== 'ok') return { ...next, isFile: () => true, isDirectory: () => false };
      }
      const f = faultFor('statSync', args[0]);
      if (f) {
        const e = new Error('statSync fault') as NodeJS.ErrnoException;
        if (f.code) e.code = f.code;
        throw e;
      }
      return (orig.statSync as (...a: unknown[]) => unknown)(...args);
    },
    readdirSync: wrap(orig.readdirSync, 'readdirSync'),
    watch: (...args: unknown[]) => {
      if (!faults.fakeWatch) return (orig.watch as (...a: never[]) => unknown)(...(args as never[]));
      const dir = String(args[0]);
      const onChange = args[1] as (...a: unknown[]) => void;
      const handlers: Record<string, ((...a: never[]) => void)[]> = {};
      faults.watchers.push({ dir, onChange, handlers });
      return {
        close: () => {
          throw new Error('close boom');
        },
        on: (ev: string, fn: (...a: never[]) => void) => {
          (handlers[ev] ??= []).push(fn);
        },
      };
    },
  };
});

import { loadEnvFiles, loadSecretsDir, parseEnvFile, watchSettings } from '../src/node.js';

beforeEach(() => {
  faults.map.clear();
  faults.fakeWatch = false;
  faults.watchers.length = 0;
  faults.statScript.length = 0;
  faults.statCalls = 0;
});

const tmp = () => mkdtempSync(join(tmpdir(), 'ts-break-faults-'));

describe('break: fs fault mapping', () => {
  it('stat ENOENT mid-iteration skips the entry', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'A'), 'v');
    writeFileSync(join(dir, 'B'), 'w');
    faults.map.set(join(dir, 'A'), { code: 'ENOENT' });
    // statSync is also used by tmpdir helpers? No — only our code paths fault on match.
    const out = loadSecretsDir(dir);
    expect(out['B']).toBe('w');
    expect(out['A']).toBeUndefined();
  });

  it('first stat missing settles immediately', async () => {
    const dir = tmp();
    const file = join(dir, 'never.json');
    const schema = z.object({ a: z.string().default('x') });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10000 });
    faults.statScript.push('enoent');
    await sub.reload();
    expect((sub.get() as { a: string }).a).toBe('x');
    await sub.dispose();
  });

  it('stat non-ENOENT rethrows', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'A'), 'v');
    faults.map.set(join(dir, 'A'), { code: 'EPERM' });
    expect(() => loadSecretsDir(dir)).toThrow(/statSync fault/);
  });

  it('read EACCES fails closed (missing secret never reads as {})', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'A'), 'v');
    // Target readFileSync only: stat must still pass so the read fault is reached.
    faults.map.set(join(dir, 'A'), { code: 'EACCES', fns: ['readFileSync'] });
    expect(() => loadSecretsDir(dir)).toThrow(/readFileSync fault/);
    expect(() => parseEnvFile(join(dir, 'A'))).toThrow(/readFileSync fault/);
    expect(() => loadEnvFiles([join(dir, 'A')])).toThrow(/readFileSync fault/);
  });

  it('read ENOENT mid-iteration skips the entry (torn read)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'A'), 'v');
    writeFileSync(join(dir, 'B'), 'w');
    faults.map.set(join(dir, 'A'), { code: 'ENOENT', fns: ['readFileSync'] });
    const out = loadSecretsDir(dir);
    expect(out['B']).toBe('w');
    expect(out['A']).toBeUndefined();
  });

  it('readdir non-ENOENT rethrows', () => {
    const dir = tmp();
    faults.map.set(dir, { code: 'EPERM' });
    expect(() => loadSecretsDir(dir)).toThrow(/readdirSync fault/);
  });
});

describe('break: watcher faults', () => {
  it('dispose swallows close() throws and stays idempotent', async () => {
    faults.fakeWatch = true;
    const schema = z.object({ a: z.string().default('x') });
    const sub = watchSettings({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false });
    await sub.dispose();
    await sub.dispose();
  });

  it('watch callback filters by basename and tolerates null filenames', async () => {
    faults.fakeWatch = true;
    const dir = tmp();
    const file = join(dir, 'watched.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string().default('x') });
    let updates = 0;
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10,
      onUpdate: () => void updates++,
    });
    expect(faults.watchers.length).toBe(1);
    const fire = (filename: unknown) => {
      for (const w of faults.watchers) w.onChange('rename', filename);
    };
    fire('other.txt'); // filtered: different basename schedules nothing
    await new Promise((r) => setTimeout(r, 40));
    expect(updates).toBe(0);
    fire(null); // null filename always schedules
    await new Promise((r) => setTimeout(r, 80));
    expect(updates).toBeGreaterThanOrEqual(1);
    // Watcher 'error' events are swallowed (poll fallback owns recovery).
    for (const w of faults.watchers) {
      for (const fn of w.handlers['error'] ?? []) (fn as (...a: unknown[]) => void)(new Error('watch blew up'));
    }
    await sub.dispose();
    // Events after dispose schedule nothing (scheduleReload early-returns).
    const frozen = updates;
    for (const w of faults.watchers) w.onChange('rename', null);
    await new Promise((r) => setTimeout(r, 40));
    expect(updates).toBe(frozen);
  });
});

describe('break: stableSize races', () => {
  it('file deleted between stats settles instead of hanging', async () => {
    const dir = tmp();
    const file = join(dir, 'gone.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string().default('x') });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10000 });
    // First stat ok, second ENOENT (deleted mid-reload) -> settle, keep config.
    faults.statScript.push('ok', 'enoent');
    await sub.reload();
    expect((sub.get() as { a: string }).a).toBe('1');
    await sub.dispose();
  });

  it('constantly-changing file gives up after retries and reloads anyway', async () => {
    const dir = tmp();
    const file = join(dir, 'churn.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string().default('x') });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10000 });
    // Sizes never stabilize across the 3 retries -> loop exits, reload proceeds.
    const t = Date.now();
    faults.statScript.push(
      { size: 1, mtimeMs: t }, { size: 2, mtimeMs: t + 1 },
      { size: 3, mtimeMs: t + 2 }, { size: 4, mtimeMs: t + 3 },
      { size: 5, mtimeMs: t + 4 }, { size: 6, mtimeMs: t + 5 },
    );
    await sub.reload();
    expect(faults.statCalls).toBe(6);
    expect((sub.get() as { a: string }).a).toBe('1');
    await sub.dispose();
  });
});

describe('break: watcher callback armor', () => {
  it('throwing onError/onUpdate never escape the watcher', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string() });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: () => { throw new Error('update boom'); },
      onError: () => { throw new Error('error boom'); },
    });
    await sub.reload(); // onUpdate throws -> swallowed
    writeFileSync(file, JSON.stringify({ a: 5 })); // invalid next time
    await sub.reload(); // onError throws -> swallowed, old kept
    expect((sub.get() as { a: string }).a).toBe('1');
    await sub.dispose();
  });

  it('overlapping reloads drop the stale one; dispose wins the race', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string() });
    const seen: string[] = [];
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10000,
      onUpdate: (cfg) => void seen.push((cfg as { a: string }).a),
    });
    const p1 = sub.reload();
    const p2 = sub.reload(); // bumps the generation; p1 is dropped after settling
    await Promise.all([p1, p2]);
    expect(seen.length).toBe(1);
    const p3 = sub.reload();
    await sub.dispose(); // dispose wins: p3 applies nothing
    await p3;
    await sub.dispose();
  });

  it('Buffer filenames are stringified before matching', async () => {
    faults.fakeWatch = true;
    const dir = tmp();
    const file = join(dir, 'buf.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string().default('x') });
    let updates = 0;
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10,
      onUpdate: () => void updates++,
    });
    for (const w of faults.watchers) w.onChange('rename', Buffer.from('buf.json'));
    await new Promise((r) => setTimeout(r, 80));
    expect(updates).toBeGreaterThanOrEqual(1);
    await sub.dispose();
  });
});

describe('break: poll sources', () => {
  it('pollMs fires reloads; refreshMs defaults on for providers/dirs', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ a: '1' }));
    const schema = z.object({ a: z.string() });
    let updates = 0;
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, {
      debounceMs: 10,
      pollMs: 20,
      onUpdate: () => void updates++,
    });
    await new Promise((r) => setTimeout(r, 120));
    // NOTE: wall-clock waits flake under parallel load; poll until the interval fires.
    const start = Date.now();
    while (updates < 1 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(updates).toBeGreaterThanOrEqual(1);
    await sub.dispose();
    // hasPollSources: {dir} and bare-{load} providers select the 60s default.
    // (Sync loads only — watchSettings is sync; async providers need settingsAsync.)
    const s2 = watchSettings(
      { schema: z.object({ a: z.string().default('x') }), sources: [{ dir: '/x' } as never, { load: () => ({}), name: 'p' }], env: {}, expand: false, coerce: false },
      { debounceMs: 10000 },
    );
    await s2.dispose();
  });
});
describe('break: watch re-arm', () => {
  it('files created after startup are picked up on reload', async () => {
    const dir = join(tmpdir(), `ts-break-rearm-${Date.now()}`);
    const file = join(dir, 'late.yaml');
    const schema = z.object({ port: z.coerce.number().default(1) });
    const { mkdirSync, writeFileSync: wfs } = await import('node:fs');
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 10000 });
    expect((sub.get() as { port: number }).port).toBe(1);
    mkdirSync(dir, { recursive: true });
    wfs(file, 'port: 4321\n');
    await sub.reload();
    expect((sub.get() as { port: number }).port).toBe(4321);
    await sub.dispose();
  });
});
