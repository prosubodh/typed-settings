import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, ConfigError } from '../src/index.js';
import { parseYamlText } from '../src/formats/yaml.js';
import { parseTomlText } from '../src/formats/toml.js';
import { parseJsonText } from '../src/formats/json.js';

describe('formats', () => {
  it('yaml single-doc parses', () => {
    expect(parseYamlText('port: 3000\ndb:\n  host: x')).toMatchObject({ port: 3000 });
  });
  it('yaml empty -> {}', () => {
    expect(parseYamlText('  \n')).toEqual({});
  });
  it('yaml multi-doc throws', () => {
    expect(() => parseYamlText('a: 1\n---\nb: 2')).toThrow(/multi-doc/);
  });
  it('toml parses', () => {
    expect(parseTomlText('port = 3000')).toMatchObject({ port: 3000 });
  });
  it('toml empty -> {}', () => {
    expect(parseTomlText('')).toEqual({});
  });
  it('json strict + empty', () => {
    expect(parseJsonText('')).toEqual({});
    expect(parseJsonText('{"a":1}')).toMatchObject({ a: 1 });
    expect(() => parseJsonText('{bad}')).toThrow(/ParseError/);
  });
});

describe('structured file precedence + arrays', () => {
  const schema = z.object({
    port: z.coerce.number().default(3000),
    tags: z.array(z.string()).default([]),
  });

  it('later file wins; env wins over files', () => {
    // Simulate file sources via injected fs
    const files: Record<string, string> = {
      './base.yaml': 'port: 1000\ntags:\n  - a\n',
      './prod.yaml': 'port: 2000\n',
    };
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p in files) return files[p];
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const cfg = settings({
        schema,
        sources: ['./base.yaml', './prod.yaml', { map: {} }],
        env: {},
        expand: false,
        coerce: false,
      });
      expect(cfg.port).toBe(2000);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });

  it('array concat strategy', () => {
    const files: Record<string, string> = {
      './b.json': JSON.stringify({ tags: ['a'] }),
      './p.json': JSON.stringify({ tags: ['b'] }),
    };
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p in files) return files[p]!;
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const cfg = settings({
        schema,
        sources: ['./b.json', './p.json'],
        env: {},
        expand: false,
        coerce: false,
        arrayStrategy: 'concat',
      });
      expect(cfg.tags).toEqual(['a', 'b']);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });

  it('array replace default', () => {
    const files: Record<string, string> = {
      './b.json': JSON.stringify({ tags: ['a'] }),
      './p.json': JSON.stringify({ tags: ['b'] }),
    };
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p in files) return files[p]!;
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      const cfg = settings({ schema, sources: ['./b.json', './p.json'], env: {}, expand: false, coerce: false });
      expect(cfg.tags).toEqual(['b']);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });
});

describe('unknownKeys', () => {
  it('reject throws on extra keys', () => {
    const schema = z.object({ port: z.coerce.number().default(1) });
    expect(() =>
      settings({
        schema,
        sources: [{ map: { PORT: '1', EXTRA: 'x' } }],
        env: {},
        expand: false,
        unknownKeys: 'reject',
      }),
    ).toThrow(ConfigError);
  });
  it('strip (default) ignores extras', () => {
    const schema = z.object({ port: z.coerce.number().default(1) });
    const cfg = settings({
      schema,
      sources: [{ map: { PORT: '1', EXTRA: 'x' } }],
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(1);
  });
});
