import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';
import { describeSchema, toEnvExample, toMarkdownDocs } from '../src/cli/describe.js';

describe('break: describe kitchen sinks (real schemas)', () => {
  it('zod covers every z4 type label incl. nesting', () => {
    const s = z.object({
      s: z.string(),
      n: z.number(),
      b: z.boolean(),
      arr: z.array(z.string()),
      db: z.object({ host: z.string() }),
      e: z.enum(['a', 'b']),
      lit: z.literal('x'),
      u: z.union([z.string(), z.number()]),
      opt: z.string().optional(),
      dflt: z.string().default('d'),
      nul: z.string().nullable(),
      caught: z.string().catch('c'),
      ro: z.string().readonly(),
      described: z.string().describe('a port'),
    });
    const { fields, bestEffort } = describeSchema(s);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['db.host']?.type).toBe('string');
    expect(byPath['b']?.type).toBe('boolean');
    expect(byPath['arr']?.type).toBe('array');
    expect(byPath['e']?.type).toBe('enum(a|b)');
    expect(byPath['lit']?.type).toBe('literal');
    expect(byPath['u']?.type).toBe('union');
    expect(byPath['dflt']).toMatchObject({ required: false, default: 'd' });
    expect(byPath['described']?.description).toBe('a port');
  });

  it('valibot covers wrappers, defaults and nesting', () => {
    const s = v.object({
      s: v.string(),
      n: v.number(),
      b: v.boolean(),
      arr: v.array(v.string()),
      db: v.object({ h: v.string() }),
      opt: v.optional(v.string()),
      withDefault: v.optional(v.string(), 'dflt'),
      nul: v.nullable(v.string()),
      u: v.union([v.string(), v.number()]),
    });
    const { fields, bestEffort } = describeSchema(s);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['db.h']?.type).toBe('string');
    expect(byPath['withDefault']).toMatchObject({ required: false, default: 'dflt' });
    expect(byPath['nul']?.type).toBe('string');
    expect(byPath['u']?.type).toBe('union');
  });

  it('arktype optional entries walk both loops', () => {
    const t = type({ name: 'string', 'nick?': 'string' });
    const { fields, bestEffort } = describeSchema(t);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['name']?.required).toBe(true);
    expect(byPath['nick']?.required).toBe(false);
  });
});

describe('break: describe sparse z4 fakes', () => {
  it('bare wrappers fall back without crashing', () => {
    const schema = {
      shape: {
        o: { type: 'optional' },
        n: { type: 'nullable' },
        c: { type: 'catch' },
        d: { type: 'default', def: {} },
        r: { type: 'readonly' },
        b: { type: 'brand' },
        p: { type: 'pipe' },
        pf: { type: 'prefault' },
        no: { type: 'nonoptional' },
        su: { type: 'success' },
      },
    };
    const { fields, bestEffort } = describeSchema(schema);
    expect(bestEffort).toBe(false);
    expect(fields).toHaveLength(10);
  });

  it('type carried only in def, and self-referential catch', () => {
    const selfCatch: Record<string, unknown> = { type: 'catch' };
    selfCatch['def'] = { innerType: selfCatch };
    const schema = {
      shape: {
        a: { def: { type: 'optional', innerType: { type: 'string' } } },
        s: selfCatch,
        nt: { type: 'nullable', unwrap: () => ({ type: 'number' }) },
        ntThrow: {
          type: 'nullable',
          unwrap: () => {
            throw new Error('nope');
          },
        },
        // Unwrap-driven (no def): brand resolves via unwrap, default via unwrap.
        br: { type: 'brand', unwrap: () => ({ type: 'string' }) },
        du: { type: 'default', def: { defaultValue: 5 }, unwrap: () => ({ type: 'number' }) },
        bareEnum: { type: 'enum' },
      },
    };
    const { fields } = describeSchema(schema);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['a']).toMatchObject({ type: 'string', required: false });
    expect(byPath['nt']?.type).toBe('number');
    expect(byPath['ntThrow']).toBeDefined();
    expect(byPath['br']?.type).toBe('string');
    expect(byPath['du']).toMatchObject({ type: 'number', required: false, default: 5 });
    expect(byPath['bareEnum']?.type).toBe('enum()');
  });

  it('null fields degrade to unknown strings', () => {
    const { fields } = describeSchema({ shape: { x: null } });
    expect(fields).toEqual([
      { path: 'x', type: 'string', required: true, default: undefined, description: undefined },
    ]);
  });

  it('legacy ZodArray/ZodObject/ZodEnum leaves', () => {
    const schema = {
      _def: {
        typeName: 'ZodObject',
        shape: {
          a: { _def: { typeName: 'ZodArray' } },
          o: { _def: { typeName: 'ZodObject' } },
          e: { _def: { typeName: 'ZodEnum' } },
        },
      },
    };
    const { fields } = describeSchema(schema);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['a']?.type).toBe('array');
    expect(byPath['o']?.type).toBe('object');
    expect(byPath['e']?.type).toBe('enum()');
  });
});

describe('break: describe sparse valibot fakes', () => {
  it('every valibot type label and wrapper corner', () => {
    const schema = {
      type: 'object',
      entries: {
        bareNul: { type: 'nullable' },
        bareNonOpt: { type: 'non_optional' },
        bareNonNull: { type: 'non_nullable', wrapped: { type: 'string' } },
        leafDefault: { type: 'string', default: 'x' },
        b: { type: 'boolean' },
        arr: { type: 'array' },
        obj: { type: 'object', entries: { h: { type: 'string' } } },
        rec: { type: 'record' },
        tpl: { type: 'tuple' },
        m: { type: 'map' },
        e: { type: 'enum_' },
        pick: { type: 'picklist', options: ['a', 'b'] },
        lit: { type: 'literal', literal: 1 },
        u: { type: 'union' },
        vv: { type: 'variant' },
        i: { type: 'intersect' },
        nan: { type: 'nan' },
        nul: null,
      },
    };
    const { fields, bestEffort } = describeSchema(schema);
    expect(bestEffort).toBe(false);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['leafDefault']).toMatchObject({ required: false, default: 'x' });
    expect(byPath['obj.h']?.type).toBe('string');
    expect(byPath['m']?.type).toBe('object');
    expect(byPath['tpl']?.type).toBe('array');
    expect(byPath['e']?.type).toBe('enum()');
    expect(byPath['pick']?.type).toBe('enum("a"|"b")');
    expect(byPath['lit']?.type).toBe('literal(1)');
    expect(byPath['nul']?.type).toBe('string');
  });
});

describe('break: describe sparse arktype fakes', () => {
  it('single-sided required/optional nodes', () => {
    const reqOnly = { json: { domain: 'object', required: [{ key: 'a', value: 'string' }] } };
    expect(describeSchema(reqOnly).fields.map((f) => f.path)).toEqual(['a']);
    const optOnly = { json: { domain: 'object', optional: [{ key: 'b', value: 'number', default: 1 }] } };
    const out = describeSchema(optOnly);
    expect(out.fields[0]).toMatchObject({ path: 'b', required: false, default: 1 });
  });

  it('nested bare domain-object values and proto spellings', () => {
    const nested = {
      json: {
        domain: 'object',
        required: [
          { key: 'bare', value: { domain: 'object' } },
          { key: 'req', value: { domain: 'object', required: [{ key: 'x', value: 'string' }] } },
          { key: 'opt', value: { domain: 'object', optional: [{ key: 'y', value: 'number' }] } },
          { key: 'p', value: { proto: 'Date' } },
        ],
        optional: [],
      },
    };
    const { fields } = describeSchema(nested);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['bare']?.type).toBe('object');
    expect(byPath['req.x']?.type).toBe('string');
    expect(byPath['opt.y']?.type).toBe('number');
    expect(byPath['p']?.type).toBe('date');
  });
});

describe('break: describe emitter corners', () => {
  it('typeless enum defs and bare object leaves', () => {
    const schema = {
      shape: {
        legacy: { def: { type: 'string' } },
        obj: { type: 'object' },
        arr: { type: 'array' },
        ev: { type: 'enum', def: { values: ['x', 'y'] } },
      },
    };
    const { fields } = describeSchema(schema);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath['legacy']?.type).toBe('string');
    expect(byPath['obj']?.type).toBe('object');
    expect(byPath['ev']?.type).toBe('enum(x|y)');
  });

  it('empty-string keys surface as root placeholders', () => {
    const zEmpty = describeSchema({ shape: { '': { type: 'string' } } });
    expect(zEmpty.fields[0]?.path).toBe('<root>');
    const vv = describeSchema({ type: 'object', entries: { '': { type: 'string' } } });
    expect(vv.fields[0]?.path).toBe('<root>');
    const bareObj = describeSchema({ type: 'object', entries: { o: { type: 'object' } } });
    expect(bareObj.fields.find((f) => f.path === 'o')?.type).toBe('object');
  });

  it('object defaults, undescribed fields and bare roots', () => {
    const out = toEnvExample([
      { path: 'obj', type: 'object', required: false, default: { a: 1 } },
      { path: 'plain', type: 'string', required: false },
      { path: 'num', type: 'number', required: true },
      { path: 'flag', type: 'boolean', required: true },
      { path: 'desc', type: 'string', required: true, description: 'a thing' },
      { path: '<root>', type: 'string', required: false },
    ]);
    expect(out).toContain('OBJ= # object default: {"a":1}');
    expect(out).toContain('PLAIN= # string default: none');
    expect(out).toContain('NUM=0 # number required');
    expect(out).toContain('FLAG=false # boolean required');
    expect(out).toContain('# a thing');
    expect(out).toContain('# no fields discovered');
    const md = toMarkdownDocs([
      { path: 'obj', type: 'object', required: false, default: { a: 1 } },
    ]);
    expect(md).toContain('`{"a":1}`');
  });
});
