import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// gen must refuse to write *through* a symlink even with --force. Creating a
// real file symlink needs privileges on Windows (Developer Mode / admin), so
// report one deterministically via a scoped lstat mock instead of skipping.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (p: unknown) => {
      if (String(p).endsWith('.env.example')) return { isSymbolicLink: () => true } as never;
      return actual.lstatSync(p as never);
    },
  };
});

vi.mock('../src/cli/load-schema.js', () => ({
  loadSchema: async () => z.object({ port: z.coerce.number().default(3000) }),
}));

import { runGen } from '../src/cli/gen.js';

describe('break: gen symlink guard', () => {
  it('refuses a symlinked --out even with --force (E_SYMLINK)', async () => {
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a);
    try {
      expect(await runGen({ schema: 's.ts', out: 'x/.env.example', force: true })).toBe(2);
      expect(errs.some((a) => String(a[0]).includes('E_SYMLINK'))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});
