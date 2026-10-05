import { describe, expect, it } from 'vitest';
import { withPrefix, coerceEnv } from '../src/adapters/zod.js';
import { yupAdapter } from '../src/adapters/yup.js';
import { joiAdapter } from '../src/adapters/joi.js';
import { superstructAdapter } from '../src/adapters/superstruct.js';
import { validateStandard } from '../src/adapter.js';

const fakeStandard = (fn: (input: unknown) => unknown) => ({
  '~standard': { version: 1, vendor: 'fake', validate: fn },
});

describe('break: withPrefix', () => {
  it('empty prefix is the identity (no lowercasing)', () => {
    const seen: unknown[] = [];
    const inner = fakeStandard((i) => {
      seen.push(i);
      return { value: i };
    });
    const out = withPrefix(inner as never, '');
    expect(out).toBe(inner);
    void seen;
  });

  it('strips case-insensitively and keeps exact-prefix keys verbatim', () => {
    const seen: unknown[] = [];
    const inner = fakeStandard((i) => {
      seen.push(i);
      return { value: i };
    });
    (withPrefix(inner as never, 'APP_') as unknown as { '~standard': { validate: (i: unknown) => unknown } })['~standard'].validate({
      APP_DbPass: 'x',
      APP_: 'kept',
      plain: 1,
    });
    expect(seen[0]).toEqual({ dbpass: 'x', APP_: 'kept', plain: 1 });
  });

  it('prefixed keys win over explicit collisions, non-objects pass through', () => {
    const seen: unknown[] = [];
    const inner = fakeStandard((i) => {
      seen.push(i);
      return { value: i };
    });
    const v = (withPrefix(inner as never, 'APP_') as unknown as { '~standard': { validate: (i: unknown) => unknown } })['~standard'].validate;
    v({ APP_FOO: 1, foo: 2 });
    expect(seen[0]).toEqual({ foo: 1 });
    v('just-a-string');
    expect(seen[1]).toBe('just-a-string');
    v(['an', 'array']);
    expect(seen[2]).toEqual(['an', 'array']);
  });

  it('coerceEnv is the identity helper', () => {
    expect(coerceEnv('x')).toBe('x');
    expect(coerceEnv(5)).toBe(5);
  });
});

describe('break: adapter core', () => {
  it('normalizePath handles {key} segments and missing paths', () => {
    const r = validateStandard(
      { '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ path: [{ key: 'a' }, 0], message: 'bad' }] }) } } as never,
      {},
    );
    expect(r).toEqual({ issues: [{ path: 'a.0', message: 'bad' }], async: false });
    // Issues without (or with empty) paths attribute to the root.
    for (const issues of [[{ message: 'x' }], [{ path: [], message: 'y' }]]) {
      const out = validateStandard(
        { '~standard': { version: 1, vendor: 't', validate: () => ({ issues }) } } as never,
        {},
      );
      expect(out).toMatchObject({ async: false });
      if ('issues' in out) expect(out.issues[0]?.path).toBe('<root>');
    }
  });

  it('validate() throwing synchronously becomes issues, and promises are detected by thenable', () => {
    const throwing = { '~standard': { version: 1, vendor: 't', validate: () => { throw new Error('sync boom'); } } };
    expect(validateStandard(throwing as never, {})).toEqual({
      issues: [{ path: '<root>', message: 'sync boom' }],
      async: false,
    });
    const throwingNonError = { '~standard': { version: 1, vendor: 't', validate: () => { throw 'str boom'; } } };
    expect(validateStandard(throwingNonError as never, {})).toEqual({
      issues: [{ path: '<root>', message: 'str boom' }],
      async: false,
    });
    // Thenable that is not a real Promise still routes to the async path.
    const thenable = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: () => ({ then: (ok: (v: unknown) => void) => ok({ value: 1 }) }),
      },
    };
    const out = validateStandard(thenable as never, {});
    expect('promise' in out).toBe(true);
  });

  it('async rejection maps to issues', async () => {
    const failing = {
      '~standard': { version: 1, vendor: 't', validate: async () => { throw new Error('async boom'); } },
    };
    const out = validateStandard(failing as never, {});
    expect('promise' in out).toBe(true);
    if ('promise' in out) {
      expect(await out.promise).toEqual({ ok: false, issues: [{ path: '<root>', message: 'async boom' }] });
    }
    // Non-Error rejections stringify.
    const failingStr = {
      '~standard': { version: 1, vendor: 't', validate: () => Promise.reject('async str') },
    };
    const out2 = validateStandard(failingStr as never, {});
    if ('promise' in out2) {
      expect(await out2.promise).toEqual({ ok: false, issues: [{ path: '<root>', message: 'async str' }] });
    } else {
      expect.unreachable();
    }
  });
});

describe('break: yup bridge (fake lib)', () => {
  it('passes values through and maps inner[] errors', () => {
    const yup = { validateSync: (v: unknown) => v };
    expect(yupAdapter(yup)['~standard'].validate({ a: 1 })).toEqual({ value: { a: 1 } });

    const bad = {
      validateSync: () => {
        const e = new Error('bad') as Error & { inner: { path?: string; message?: string }[] };
        e.inner = [{ path: 'a.b', message: 'req' }];
        throw e;
      },
    };
    expect(yupAdapter(bad)['~standard'].validate({})).toEqual({
      issues: [{ message: 'req', path: ['a.b'] }],
    });
  });

  it('no-inner errors fall back to a root issue', () => {
    const bad = {
      validateSync: () => {
        throw new Error('plain boom');
      },
    };
    expect(yupAdapter(bad)['~standard'].validate({})).toEqual({
      issues: [{ message: 'plain boom', path: ['<root>'] }],
    });
    // Inner entries without paths map to undefined paths.
    const pathless = {
      validateSync: () => {
        const e = new Error('x') as Error & { inner: { message?: string }[] };
        e.inner = [{ message: 'm' }];
        throw e;
      },
    };
    expect(yupAdapter(pathless)['~standard'].validate({})).toEqual({
      issues: [{ message: 'm', path: undefined }],
    });
    // Non-Error throws and messageless inners stringify safely.
    const strThrow = { validateSync: () => { throw 'yup str'; } };
    expect(yupAdapter(strThrow)['~standard'].validate({})).toEqual({
      issues: [{ message: 'yup str', path: ['<root>'] }],
    });
    const bare = {
      validateSync: () => {
        const e = new Error() as Error & { inner: Record<string, never>[] };
        e.inner = [{}];
        throw e;
      },
    };
    expect(yupAdapter(bare)['~standard'].validate({})).toMatchObject({ issues: [{}] });
  });
});

describe('break: joi bridge (fake lib)', () => {
  it('maps details and passes values', () => {
    const ok = { validate: () => ({ value: { a: 1 } }) };
    expect(joiAdapter(ok as never)['~standard'].validate({})).toEqual({ value: { a: 1 } });
    const bad = {
      validate: () => ({ error: { details: [{ path: ['a', 0], message: 'bad' }] }, value: null }),
    };
    expect(joiAdapter(bad as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'bad', path: ['a', '0'] }],
    });
  });

  it('throwing validate() becomes issues instead of leaking', () => {
    const throwing = {
      validate: () => {
        throw new Error('joi boom');
      },
    };
    expect(joiAdapter(throwing as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'joi boom' }],
    });
    // Non-Error throws stringify instead of crashing on .message access.
    const throwingStr = {
      validate: () => {
        throw 'str boom';
      },
    };
    expect(joiAdapter(throwingStr as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'str boom' }],
    });
  });

  it('empty details still yields a non-empty issues array', () => {
    const empty = { validate: () => ({ error: { details: [] }, value: 1 }) };
    expect(joiAdapter(empty as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'Invalid input' }],
    });
    const named = { validate: () => ({ error: { message: 'named failure', details: [] }, value: 1 }) };
    expect(joiAdapter(named as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'named failure' }],
    });
    // No details key at all falls back to an empty list first.
    const noDetails = { validate: () => ({ error: { message: 'm' }, value: 1 }) };
    expect(joiAdapter(noDetails as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'm' }],
    });
  });
});

describe('break: superstruct bridge (fake lib)', () => {
  it('maps failures() with stringified segments', () => {
    const ss = {
      create: (v: unknown) => v,
    };
    expect(superstructAdapter(ss as never)['~standard'].validate({ a: 1 })).toEqual({ value: { a: 1 } });
    const bad = {
      create: () => {
        const e = new Error('ss') as Error & { failures: () => { path: (string | number)[]; message: string }[] };
        e.failures = () => [{ path: ['a', 0], message: 'bad' }];
        throw e;
      },
    };
    expect(superstructAdapter(bad as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'bad', path: ['a', '0'] }],
    });
  });

  it('empty failures() and non-failure throws fall back to the message', () => {
    const empty = {
      create: () => {
        const e = new Error('ss-empty') as Error & { failures: () => never[] };
        e.failures = () => [];
        throw e;
      },
    };
    expect(superstructAdapter(empty as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'ss-empty' }],
    });
    const plain = {
      create: () => {
        throw new Error('ss-plain');
      },
    };
    expect(superstructAdapter(plain as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'ss-plain' }],
    });
    const strThrow = {
      create: () => {
        throw 'ss-str';
      },
    };
    expect(superstructAdapter(strThrow as never)['~standard'].validate({})).toEqual({
      issues: [{ message: 'ss-str' }],
    });
  });
});
