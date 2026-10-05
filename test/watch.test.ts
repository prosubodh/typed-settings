import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { settings } from '../src/index.js';
import { watchSettings } from '../src/node.js';

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('watchSettings', () => {
  it('reloads on file change with changed keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-watch-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: 1000 }));
    const schema = z.object({ port: z.coerce.number().default(3000) });
    let updated: unknown = null;
    let changed: string[] = [];
    const sub = watchSettings(
      { schema, sources: [file], env: {}, expand: false, coerce: false },
      {
        debounceMs: 30,
        onUpdate: (cfg, c) => {
          updated = cfg;
          changed = c;
        },
      },
    );
    expect((sub.get() as { port: number }).port).toBe(1000);
    writeFileSync(file, JSON.stringify({ port: 2000 }));
    await waitFor(() => updated !== null);
    expect((updated as { port: number }).port).toBe(2000);
    expect((sub.get() as { port: number }).port).toBe(2000);
    expect(changed.join(',')).toContain('port');
    await sub.dispose();
    await sub.dispose(); // idempotent
  });

  it('keeps old on invalid + onError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-watch-'));
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ port: 1000 }));
    const schema = z.object({ port: z.coerce.number() });
    let errors = 0;
    let updates = 0;
    const sub = watchSettings(
      { schema, sources: [file], env: {}, expand: false, coerce: false },
      {
        debounceMs: 30,
        onUpdate: () => {
          updates++;
        },
        onError: () => {
          errors++;
        },
      },
    );
    expect((sub.get() as { port: number }).port).toBe(1000);
    writeFileSync(file, JSON.stringify({ port: 'not-a-number' }));
    // coerce:false leaves string; z.coerce.number would coerce, so use strict number here:
    await waitFor(() => errors > 0);
    expect((sub.get() as { port: number }).port).toBe(1000);
    expect(updates).toBe(0);
    await sub.dispose();
  });

  it('manual reload() works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-watch-'));
    const file = join(dir, 'm.json');
    writeFileSync(file, JSON.stringify({ port: 1 }));
    const schema = z.object({ port: z.coerce.number().default(0) });
    const sub = watchSettings({ schema, sources: [file], env: {}, expand: false, coerce: false }, { debounceMs: 1000 });
    writeFileSync(file, JSON.stringify({ port: 2 }));
    await sub.reload();
    await waitFor(() => (sub.get() as { port: number }).port === 2);
    expect((sub.get() as { port: number }).port).toBe(2);
    await sub.dispose();
  });

  it('initial settings still throws sync on invalid', () => {
    expect(() =>
      settings({ schema: z.object({ port: z.number() }), sources: [{ map: {} }], env: {}, expand: false }),
    ).toThrow();
  });
});
