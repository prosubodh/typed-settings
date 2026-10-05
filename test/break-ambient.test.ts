import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings } from '../src/index.js';

describe('ambient process.env: $ never crashes config load', () => {
  it('unresolved ${...} in env values passes through literally', () => {
    const schema = z.object({ prompt: z.string(), host: z.string().default('h') });
    const cfg = settings({ schema, sources: ['env'], env: { PROMPT: '$P$G' } });
    expect(cfg.prompt).toBe('$P$G');
  });

  it('self-referencing env values pass through literally', () => {
    const schema = z.object({ a: z.string() });
    const cfg = settings({ schema, sources: ['env'], env: { A: '${A}' }, expand: true });
    expect(cfg.a).toBe('${A}');
  });

  it('bash := keeps a literal instead of E_BAD_OP on env-layer values', () => {
    const schema = z.object({ weird: z.string() });
    const cfg = settings({ schema, sources: ['env'], env: { WEIRD: '${P:=x}' } });
    expect(cfg.weird).toBe('${P:=x}');
  });

  it('env-layer values still expand when references do resolve', () => {
    const schema = z.object({ url: z.string() });
    const cfg = settings({
      schema,
      sources: ['env'],
      env: { HOST: 'db.internal', URL: 'postgres://${HOST}/app' },
    });
    expect(cfg.url).toBe('postgres://db.internal/app');
  });

  it('file-sourced values keep the strict contract (E_UNRESOLVED / E_CIRCULAR)', () => {
    (globalThis as unknown as { __typedSettingsFs: unknown }).__typedSettingsFs = {
      readFileSync: (p: string) => {
        if (p === 'c.env') return 'URL=postgres://${HOST}/app';
        if (p === 'cyc.env') return 'A=${B}\nB=${A}';
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
    };
    try {
      expect(() =>
        settings({ schema: z.object({ url: z.string() }), sources: ['c.env'], env: {}, expand: true }),
      ).toThrow(/E_UNRESOLVED/);
      expect(() =>
        settings({ schema: z.object({ a: z.string(), b: z.string() }), sources: ['cyc.env'], env: {}, expand: true }),
      ).toThrow(/E_CIRCULAR/);
    } finally {
      delete (globalThis as unknown as { __typedSettingsFs?: unknown }).__typedSettingsFs;
    }
  });
});
