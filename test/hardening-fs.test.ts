import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';

// Fully fake secrets dirs: no real symlinks needed (Windows blocks them).
const fake = vi.hoisted(() => ({
  readdir: new Map<string, string[]>(),
  lstat: new Map<string, { file: boolean; link: boolean; size: number; err?: string }>(),
  realpath: new Map<string, { target: string; err?: string }>(),
  stat: new Map<string, { file: boolean; size: number; err?: string }>(),
  read: new Map<string, { content: string; err?: string }>(),
}));

const errWith = (code?: string): NodeJS.ErrnoException => {
  const e = new Error('mock fault') as NodeJS.ErrnoException;
  if (code) e.code = code;
  return e;
};

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    readdirSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && fake.readdir.has(p)) return [...fake.readdir.get(p)!];
      return (orig.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && fake.lstat.has(p)) {
        const s = fake.lstat.get(p)!;
        if (s.err) throw errWith(s.err);
        return { isFile: () => s.file, isSymbolicLink: () => s.link, size: s.size };
      }
      return (orig.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    realpathSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && fake.realpath.has(p)) {
        const r = fake.realpath.get(p)!;
        if (r.err) throw errWith(r.err);
        return r.target;
      }
      return (orig.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    statSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && fake.stat.has(p)) {
        const s = fake.stat.get(p)!;
        if (s.err) throw errWith(s.err);
        return { isFile: () => s.file, size: s.size, mtimeMs: 1 };
      }
      return (orig.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && fake.read.has(p)) {
        const r = fake.read.get(p)!;
        if (r.err) throw errWith(r.err);
        return r.content;
      }
      return (orig.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

import { loadSecretsDir } from '../src/node.js';

beforeEach(() => {
  fake.readdir.clear();
  fake.lstat.clear();
  fake.realpath.clear();
  fake.stat.clear();
  fake.read.clear();
});

const D = resolve('/vsecrets-fake');
const f = (n: string): string => join(D, n);

describe('hardening-fs: symlink confinement', () => {
  it('in-dir symlink (K8s ..data style) resolves', () => {
    fake.readdir.set(D, ['link']);
    fake.lstat.set(f('link'), { file: false, link: true, size: 0 });
    fake.realpath.set(f('link'), { target: join(D, '..data', 'x') });
    fake.stat.set(join(D, '..data', 'x'), { file: true, size: 3 });
    fake.read.set(f('link'), { content: 'vv\n' });
    expect(loadSecretsDir(D)).toEqual({ LINK: 'vv' });
  });
  it('escape to parent and sibling dirs throws', () => {
    for (const target of [dirname(D), join(dirname(D), 'other', 'o')]) {
      fake.readdir.set(D, ['evil']);
      fake.lstat.set(f('evil'), { file: false, link: true, size: 0 });
      fake.realpath.set(f('evil'), { target });
      expect(() => loadSecretsDir(D)).toThrow(/E_SHAPE/);
    }
  });
  it('self-target and cross-drive targets throw', () => {
    fake.readdir.set(D, ['evil']);
    fake.lstat.set(f('evil'), { file: false, link: true, size: 0 });
    fake.realpath.set(f('evil'), { target: D });
    expect(() => loadSecretsDir(D)).toThrow(/E_SHAPE/);
    fake.realpath.set(f('evil'), { target: 'E:\\definitely\\not\\here' });
    expect(() => loadSecretsDir(D)).toThrow(/E_SHAPE/);
  });
  it('dangling and dir targets skip; backend errors rethrow', () => {
    fake.readdir.set(D, ['dangle']);
    fake.lstat.set(f('dangle'), { file: false, link: true, size: 0 });
    fake.realpath.set(f('dangle'), { target: '', err: 'ENOENT' });
    expect(loadSecretsDir(D)).toEqual({});
    fake.realpath.set(f('dangle'), { target: '', err: 'EACCES' });
    expect(() => loadSecretsDir(D)).toThrow();
    fake.realpath.set(f('dangle'), { target: join(D, 'sub') });
    fake.stat.set(join(D, 'sub'), { file: false, size: 0 });
    expect(loadSecretsDir(D)).toEqual({});
    fake.stat.set(join(D, 'sub'), { file: true, size: 0, err: 'ENOENT' });
    expect(loadSecretsDir(D)).toEqual({});
    fake.stat.set(join(D, 'sub'), { file: true, size: 0, err: 'EACCES' });
    expect(() => loadSecretsDir(D)).toThrow();
  });
  it('lstat misses skip; lstat errors rethrow', () => {
    fake.readdir.set(D, ['ghost']);
    fake.lstat.set(f('ghost'), { file: false, link: false, size: 0, err: 'ENOENT' });
    expect(loadSecretsDir(D)).toEqual({});
    fake.lstat.set(f('ghost'), { file: false, link: false, size: 0, err: 'EPERM' });
    expect(() => loadSecretsDir(D)).toThrow();
  });
});

describe('hardening-fs: caps and collisions', () => {
  it('stat size gates apply to regular files and link targets', () => {
    fake.readdir.set(D, ['BIG']);
    fake.lstat.set(f('BIG'), { file: true, link: false, size: 10 ** 9 });
    expect(() => loadSecretsDir(D)).toThrow(/E_FILE_TOO_LARGE/);
    fake.lstat.set(f('BIG'), { file: false, link: true, size: 0 });
    fake.realpath.set(f('BIG'), { target: join(D, 't') });
    fake.stat.set(join(D, 't'), { file: true, size: 10 ** 9 });
    expect(() => loadSecretsDir(D)).toThrow(/E_FILE_TOO_LARGE/);
  });
  it('case collisions throw deterministically', () => {
    fake.readdir.set(D, ['Token', 'TOKEN']);
    for (const n of ['Token', 'TOKEN']) {
      fake.lstat.set(f(n), { file: true, link: false, size: 1 });
      fake.read.set(f(n), { content: n });
    }
    expect(() => loadSecretsDir(D)).toThrow(/E_SHAPE/);
  });
});
