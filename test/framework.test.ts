import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { publicSettings } from '../src/framework/next.js';
import { viteSettings, viteSettingsAsync } from '../src/framework/vite.js';
import { settings, viteSettingsAsync as viteSettingsAsyncRoot } from '../src/index.js';

describe('next binding', () => {
  it('publicSettings exposes only explicit keys (no spread leak)', () => {
    const schema = z.object({
      dbUrl: z.string().default('postgres://localhost'),
      NEXT_PUBLIC_API: z.string().default('https://api.example'),
    });
    const cfg = settings({ schema, sources: [{ map: {} }], env: {}, expand: false, coerce: false });
    const pub = publicSettings(cfg, ['NEXT_PUBLIC_API'] as const);
    expect(pub).toEqual({ NEXT_PUBLIC_API: 'https://api.example' });
    expect('dbUrl' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('postgres');
  });
});

describe('vite binding', () => {
  it('validates import.meta.env-style map without fs', () => {
    const schema = z.object({ port: z.coerce.number().default(3000) });
    const cfg = viteSettings({ schema }, { PORT: '4000' });
    expect(cfg.port).toBe(4000);
  });

  it('viteSettingsAsync validates with async schema from framework entry and root', async () => {
    const schema = z.object({
      port: z.coerce.number().refine(async (val) => val > 1024, 'port must be > 1024'),
    });
    const cfg = await viteSettingsAsync({ schema }, { PORT: '8080' });
    expect(cfg.port).toBe(8080);
    const cfgRoot = await viteSettingsAsyncRoot({ schema }, { PORT: '9090' });
    expect(cfgRoot.port).toBe(9090);
  });

  it('publicSettings omits missing keys (Partial, statically honest)', () => {
    const pub = publicSettings({ a: 1 } as { a: number; b: number }, ['a', 'b'] as const);
    expect(pub).toEqual({ a: 1 });
    expect('b' in pub).toBe(false);
  });
});
