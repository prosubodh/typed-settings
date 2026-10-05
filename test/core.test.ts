import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, ConfigError, withOverrides } from '../src/index.js';
import { parseEnvText } from '../src/formats/env.js';
import { expandValue } from '../src/expand.js';
import { tryParseEnvValue } from '../src/coerce.js';

describe('dotenv parser', () => {
  it('parses export, quotes, comments', () => {
    const m = parseEnvText('export A=1\nB="a # b" # c\nC=\'x\'\n# hi\nEMPTY=');
    expect(m).toMatchObject({ A: '1', B: 'a # b', C: 'x', EMPTY: '' });
  });
});

describe('expand', () => {
  it('expands $VAR, ${VAR:-def}, $$', () => {
    const lookup = (n: string) => ({ A: 'hi' })[n];
    expect(expandValue('$A!', lookup)).toBe('hi!');
    expect(expandValue('${MISSING:-d}', lookup)).toBe('d');
    expect(expandValue('$$A', lookup)).toBe('$A');
  });
});

describe('coerce', () => {
  it('coerces numbers, bools, lists', () => {
    expect(tryParseEnvValue('3000')).toBe(3000);
    expect(tryParseEnvValue('true')).toBe(true);
    expect(tryParseEnvValue('a,b')).toEqual(['a', 'b']);
  });
});

describe('settings with zod', () => {
  it('loads flat + nested via __ + defaults', () => {
    const schema = z.object({
      port: z.coerce.number().default(3000),
      db: z.object({ host: z.string().default('localhost') }),
    });
    const cfg = settings({
      schema,
      sources: [{ map: { PORT: '4000', DB__HOST: 'db.internal' } }],
      env: {},
      coerce: true,
      expand: false,
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.db.host).toBe('db.internal');
  });

  it('throws aggregated ConfigError on invalid', () => {
    const schema = z.object({ port: z.coerce.number() });
    try {
      settings({ schema, sources: [{ map: { PORT: 'abc' } }], env: {}, expand: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });

  it('withOverrides isolates env', () => {
    const schema = z.object({ port: z.coerce.number().default(3000) });
    const v = withOverrides({ PORT: '5000' }, () =>
      settings({ schema, sources: ['env'], expand: false }),
    );
    expect(v.port).toBe(5000);
  });

  it('prefix stripping', () => {
    const schema = z.object({ port: z.coerce.number().default(1) });
    const cfg = settings({
      schema,
      sources: [{ map: { APP_PORT: '9000' } }],
      prefix: 'APP_',
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(9000);
  });

  it('freezes output', () => {
    const schema = z.object({ port: z.coerce.number().default(1) });
    const cfg = settings({ schema, sources: [{ map: {} }], env: {}, expand: false });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
