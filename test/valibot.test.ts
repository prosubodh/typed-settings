import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { settings } from '../src/index.js';

describe('valibot adapter (Standard Schema native)', () => {
  it('validates + coerces', () => {
    const schema = v.object({
      port: v.optional(v.pipe(v.unknown(), v.transform(Number)), 3000),
    });
    const cfg = settings({
      schema,
      sources: [{ map: { PORT: '4000' } }],
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(4000);
  });
});
