import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, ConfigError } from '../src/index.js';
import { normalizeIndexedObjects, deepMerge } from '../src/merge.js';

describe('indexed env keys (__0)', () => {
  const schema = z.object({ hosts: z.array(z.string()) });

  it('dense indexes fold to array', () => {
    const cfg = settings({
      schema,
      sources: [{ map: { HOSTS__0: 'a', HOSTS__1: 'b' } }],
      env: {},
      expand: false,
      coerce: false,
    });
    expect(cfg.hosts).toEqual(['a', 'b']);
  });

  it('sparse indexes throw E_SPARSE_ARRAY', () => {
    expect(() =>
      settings({
        schema,
        sources: [{ map: { HOSTS__0: 'a', HOSTS__2: 'c' } }],
        env: {},
        expand: false,
        coerce: false,
      }),
    ).toThrowError(/E_SPARSE_ARRAY/);
  });

  it('scalar + indexed mix in same layer throws E_ARRAY_MIX', () => {
    expect(() =>
      settings({
        schema,
        sources: [{ map: { HOSTS: 'a,b', HOSTS__0: 'x' } }],
        env: {},
        expand: false,
        coerce: false,
      }),
    ).toThrowError(/E_ARRAY_MIX/);
  });

  it('non-index numeric-looking parent stays object', () => {
    expect(normalizeIndexedObjects({ port: '1', host: 'x' })).toEqual({ port: '1', host: 'x' });
  });

  it('cap >1024 throws E_ARRAY_CAP', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 1025; i++) big[String(i)] = 'x';
    expect(() => normalizeIndexedObjects({ arr: big })).toThrowError(/E_ARRAY_CAP/);
    try {
      normalizeIndexedObjects({ arr: big });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_ARRAY_CAP');
    }
  });
});

describe('mergeIndex across layers', () => {
  it('union per-index deep-merges objects', () => {
    const base = [{ name: 'a', port: 1 }];
    const over = [{ port: 2 }];
    expect(deepMerge(base, over, 'mergeIndex')).toEqual([{ name: 'a', port: 2 }]);
  });

  it('tail preserved (shrink requires replace)', () => {
    expect(deepMerge(['a', 'b'], ['c'], 'mergeIndex')).toEqual(['c', 'b']);
    expect(deepMerge(['a', 'b'], ['c'], 'replace')).toEqual(['c']);
  });

  it('holes in both sides throw E_SPARSE_ARRAY', () => {
    const base: unknown[] = [];
    base[2] = 'x';
    const over: unknown[] = [];
    over[0] = 'y';
    // merged len 3, index 1 hole in both
    expect(() => deepMerge(base, over, 'mergeIndex')).toThrowError(/E_SPARSE_ARRAY/);
  });

  it('settings-level mergeIndex merges yaml layers', async () => {
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        const files: Record<string, string> = {
          './base.json': JSON.stringify({ items: [{ a: 1, b: 1 }] }),
          './prod.json': JSON.stringify({ items: [{ b: 2 }] }),
        };
        if (p in files) return files[p];
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const schema = z.object({ items: z.array(z.object({ a: z.number().optional(), b: z.number() })) });
      const cfg = settings({
        schema,
        sources: ['./base.json', './prod.json'],
        env: {},
        expand: false,
        coerce: false,
        arrayStrategy: 'mergeIndex',
      });
      expect(cfg.items).toEqual([{ a: 1, b: 2 }]);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
      const { readFileSync } = await import('node:fs');
      (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
        readFileSync: (p: string, e: string) => readFileSync(p, e as BufferEncoding),
      };
    }
  });
});
