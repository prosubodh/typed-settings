import { describe, expect, it } from 'vitest';
import { expandKeys, stripPrefix, deepMerge, normalizeIndexedObjects, isPlainObject } from '../src/merge.js';
import { tryParseEnvValue, coerceDeep } from '../src/coerce.js';
import { expandValue } from '../src/expand.js';
import { parseEnvText } from '../src/formats/env.js';
import { parseJsonText } from '../src/formats/json.js';
import { parseTomlText } from '../src/formats/toml.js';
import { parseYamlText } from '../src/formats/yaml.js';
import { ConfigError } from '../src/errors.js';

describe('break: expandKeys', () => {
  it('forbidden segments match case-insensitively (no __PROTO__ bypass)', () => {
    for (const key of ['A__CONSTRUCTOR__B', '__PROTO__', 'X__Prototype__Y']) {
      expect(() => expandKeys({ [key]: '1' }), key).toThrow(ConfigError);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('messy separators degrade to literal keys (Next.js `__NEXT_*` safe)', () => {
    // Interior empty segment, leading, trailing — none of these crash the load;
    // they become literal top-level keys ( Next injects vars shaped like these).
    expect(expandKeys({ A____B: '1' })).toEqual({ a____b: '1' });
    expect(expandKeys({ __NEXT_FOO: '1' })).toEqual({ __next_foo: '1' });
    expect(expandKeys({ TRAIL__: '1' })).toEqual({ trail__: '1' });
    // ...and the literal fallback can never smuggle a forbidden key into a split path:
    expect(expandKeys({ A____PROTO____B: '1' })).toEqual({ a____proto____b: '1' });
  });

  it('indexed + named siblings in one layer throw E_ARRAY_MIX both orders', () => {
    expect(() => expandKeys({ ARR__0: 'x', ARR__FOO: 'y' })).toThrow(/E_ARRAY_MIX/);
    expect(() => expandKeys({ ARR__FOO: 'y', ARR__0: 'x' })).toThrow(/E_ARRAY_MIX/);
  });

  it('scalar + indexed mixing throws both orders', () => {
    expect(() => expandKeys({ ARR: 'a,b', ARR__0: 'x' })).toThrow(/E_ARRAY_MIX/);
    expect(() => expandKeys({ ARR__0: 'x', ARR: 'a,b' })).toThrow(/E_ARRAY_MIX/);
  });

  it('index-like keys under different tops do not interfere', () => {
    expect(expandKeys({ A__0: 'x', B__NAME: 'y' })).toEqual({ a: { 0: 'x' }, b: { name: 'y' } });
  });

  it('envMap matches case-insensitively and stays literal', () => {
    expect(expandKeys({ FOO: 'v' }, { envMap: { foo: 'a__b' } })).toEqual({ a__b: 'v' });
    expect(expandKeys({ foo: 'v' }, { envMap: { FOO: 'a__b' } })).toEqual({ a__b: 'v' });
    // Escaped keys skip prefix stripping and __ splitting (lowercased like all keys).
    expect(expandKeys({ FOO: 'v' }, { prefix: 'F', envMap: { FOO: 'X__Y' } })).toEqual({ x__y: 'v' });
    // ...but escaping never smuggles forbidden keys past the guard.
    expect(() => expandKeys({ FOO: 'v' }, { envMap: { FOO: '__proto__' } })).toThrow(/E_PROTO/);
  });

  it('empty segments and invalid keys', () => {
    // No more E_EMPTY_SEGMENT crash: messy separators degrade to literal keys.
    expect(expandKeys({ A____B: '1' })).toEqual({ a____b: '1' });
    expect(expandKeys({ 'HAS-DASH': '1', HAS_SPACE: '1' })).toEqual({ has_space: '1' });
    expect(() => expandKeys({ CONSTRUCTOR: '1' })).toThrow(/E_PROTO/);
    // NOTE: `{__proto__: '1'}` as a JS literal sets the prototype, not an own key —
    // the realistic attack arrives via JSON.parse, which preserves it as data.
    expect(() => expandKeys(JSON.parse('{"__proto__":"1"}'))).toThrow(/E_PROTO/);
  });

  it('isPlainObject rejects class instances and arrays', () => {
    expect(isPlainObject([1])).toBe(false);
    expect(isPlainObject(new (class {})())).toBe(false);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});

describe('break: deepMerge', () => {
  it('cap boundary: 1024 merges, 1025 throws', () => {
    const a = new Array(1024).fill(0);
    const b = new Array(1024).fill(1);
    expect((deepMerge(a, b, 'mergeIndex') as unknown[]).length).toBe(1024);
    expect(() => deepMerge(a, [...b, 1], 'mergeIndex')).toThrow(/E_ARRAY_CAP/);
  });

  it('null wins, undefined is ignored', () => {
    expect(deepMerge({ a: 1 }, null)).toBeNull();
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('only plain objects merge; class instances replace', () => {
    class C {
      x = 1;
    }
    expect(deepMerge({ a: 1 }, new C())).toBeInstanceOf(C);
    expect(deepMerge(new C(), { a: 1 })).toEqual({ a: 1 });
    // __proto__ own-keys (e.g. from JSON.parse) fail closed instead of polluting.
    expect(() => deepMerge({}, JSON.parse('{"__proto__":{"x":1}}'), 'replace')).toThrow(/E_PROTO/);
  });

  it('normalizeIndexedObjects: non-index parents keep literal keys', () => {
    expect(normalizeIndexedObjects({ port: '1' })).toEqual({ port: '1' });
    expect(normalizeIndexedObjects({ 0: 'a', 1: 'b' })).toEqual(['a', 'b']);
    expect(normalizeIndexedObjects([[['x']]])).toEqual([[['x']]]);
    expect(normalizeIndexedObjects('s')).toBe('s');
    expect(normalizeIndexedObjects(5)).toBe(5);
  });
});

describe('break: coerce', () => {
  it('numbers: boundaries and rejects', () => {
    expect(tryParseEnvValue('3000')).toBe(3000);
    expect(tryParseEnvValue('-12')).toBe(-12);
    expect(tryParseEnvValue('1e3')).toBe(1000);
    expect(tryParseEnvValue('1.5')).toBe(1.5);
    expect(tryParseEnvValue('0x10')).toBe('0x10');
    expect(tryParseEnvValue('1_0')).toBe('1_0');
    expect(tryParseEnvValue('NaN')).toBe('NaN');
    expect(tryParseEnvValue('Infinity')).toBe('Infinity');
    expect(tryParseEnvValue('+5')).toBe('+5');
    expect(tryParseEnvValue('9007199254740993')).toBe('9007199254740993'); // unsafe stays string
    expect(tryParseEnvValue('1.0')).toBe(1); // float-shaped parses (schema decides int-ness)
  });

  it('booleans and nulls', () => {
    expect(tryParseEnvValue('YES')).toBe(true);
    expect(tryParseEnvValue('Off')).toBe(false);
    expect(tryParseEnvValue('NULL')).toBe(null);
    expect(tryParseEnvValue('UNDEFINED')).toBe(undefined);
    expect(tryParseEnvValue('maybe')).toBe('maybe');
  });

  it('csv: escapes, quotes, unterminated', () => {
    expect(tryParseEnvValue('a\\,b,c')).toEqual(['a,b', 'c']);
    expect(tryParseEnvValue('a,"b,c')).toBe('a,"b,c'); // unterminated stays string, never throws
    expect(tryParseEnvValue('a, " b " ,c')).toEqual(['a', ' b ', 'c']);
    expect(tryParseEnvValue("'a,b',c")).toEqual(['a,b', 'c']);
    expect(tryParseEnvValue("'a\\b',c")).toEqual(['a\\b', 'c']); // backslash inside quotes kept
    expect(tryParseEnvValue("'a,b\\'")).toBe("'a,b\\'"); // trailing backslash: unterminated, stays whole
    expect(tryParseEnvValue("'a,b'")).toEqual(['a,b']); // fully-quoted single value unwraps (still a 1-list)
    expect(tryParseEnvValue('1e999')).toBe('1e999'); // overflow stays a string
  });

  it('json try-parse and passthrough', () => {
    expect(tryParseEnvValue('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseEnvValue('[1,2]')).toEqual([1, 2]);
    expect(tryParseEnvValue('{bad}')).toBe('{bad}');
    expect(tryParseEnvValue(5)).toBe(5);
    expect(tryParseEnvValue(null)).toBe(null);
    expect(tryParseEnvValue('')).toBe('');
  });

  it('coerceDeep recurses arrays and objects', () => {
    expect(coerceDeep({ a: ['1', 'x'], b: { c: 'true' } })).toEqual({ a: [1, 'x'], b: { c: true } });
  });
});

describe('break: expandValue', () => {
  const look = (m: Record<string, string | undefined>) => (n: string) => m[n];
  it('$$ escape and backslash-dollar are literal (pinned)', () => {
    expect(expandValue('$$A', look({ A: 'x' }))).toBe('$A');
    expect(expandValue('\\$FOO', look({ FOO: 'x' }), { allowUnresolved: true })).toBe('$FOO');
  });

  it('$ with invalid name is literal', () => {
    expect(expandValue('$-x $ $9', look({}), { allowUnresolved: true })).toBe('$-x $ $9');
  });

  it(':- vs - on empty and unset', () => {
    const l = look({ E: '' });
    expect(expandValue('${E:-d}', l)).toBe('d');
    expect(expandValue('${E-d}', l)).toBe('');
    expect(expandValue('${U:-d}', l)).toBe('d');
    expect(expandValue('${U-d}', l)).toBe('d');
  });

  it('recursive defaults and escaped braces', () => {
    expect(expandValue('${A:-${B:-z}}', look({}))).toBe('z');
    expect(expandValue('${A:-a\\}b}', look({}))).toBe('a}b');
  });

  it(':= and :? rejected; unterminated throws ParseError', () => {
    expect(() => expandValue('${A:=x}', look({}))).toThrow(/E_BAD_OP/);
    expect(() => expandValue('${A:?x}', look({}))).toThrow(/E_BAD_OP/);
    expect(() => expandValue('${A:-x', look({}))).toThrow(/ParseError/);
  });

  it('${ with trailing junk after the name stays literal', () => {
    expect(expandValue('${A?x}', look({ A: 'v' }), { allowUnresolved: true })).toBe('${A?x}');
    expect(expandValue('${A x}', look({ A: 'v' }), { allowUnresolved: true })).toBe('${A x}');
  });

  it('unresolved without default throws unless allowed', () => {
    expect(() => expandValue('$NOPE_XYZ', look({}))).toThrow(/E_UNRESOLVED/);
    expect(expandValue('$NOPE_XYZ', look({}), { allowUnresolved: true })).toBe('$NOPE_XYZ');
    expect(expandValue('${NOPE_XYZ}', look({}), { allowUnresolved: true })).toBe('${NOPE_XYZ}');
    // Braced form without opts: default from-label is used.
    expect(() => expandValue('${NOPE_BRACED}', look({}))).toThrow(/E_UNRESOLVED/);
    // A trailing colon with nothing after it cannot form an operator.
    expect(() => expandValue('${A:', look({}))).toThrow(/E_BAD_OP/);
  });
});

describe('break: .env parser', () => {
  it('comments need preceding whitespace', () => {
    expect(parseEnvText('A=a#b')).toEqual({ A: 'a#b' });
    expect(parseEnvText('A=a #b')).toEqual({ A: 'a' });
    expect(parseEnvText('# full')).toEqual({});
  });

  it('quotes: single literal, double expands \\n and spans lines', () => {
    expect(parseEnvText("A='a # b'")).toEqual({ A: 'a # b' });
    expect(parseEnvText('A="a\\nB"')).toEqual({ A: 'a\nB' });
    expect(parseEnvText('A="x\ny"')).toEqual({ A: 'x\ny' });
    expect(parseEnvText('A="a # b" # c')).toEqual({ A: 'a # b' });
    // Trailing lone backslash consumes the closing quote -> unterminated.
    expect(() => parseEnvText('A="a\\"')).toThrow(/unterminated/);
  });

  it('backticks, unterminated quotes, bare and empty keys', () => {
    expect(() => parseEnvText('A=`x`')).toThrow(/backtick/);
    expect(() => parseEnvText("A='x")).toThrow(/unterminated/);
    expect(() => parseEnvText('A="x')).toThrow(/unterminated/);
    expect(() => parseEnvText('JUSTAKEY')).toThrow(/bare key/);
    expect(() => parseEnvText('"abc')).toThrow(/bare key/); // odd quote, no '=' at all
    expect(() => parseEnvText('=x')).toThrow(/empty key/);
    expect(parseEnvText('EMPTY=')).toEqual({ EMPTY: '' });
  });

  it('export prefix, first-equals split, dup last-wins, BOM', () => {
    expect(parseEnvText('export A=1')).toEqual({ A: '1' });
    expect(parseEnvText('A=a=b')).toEqual({ A: 'a=b' });
    expect(parseEnvText('A=1\nA=2')).toEqual({ A: '2' });
    expect(parseEnvText('﻿A=1')).toEqual({ A: '1' });
    expect(parseEnvText('  A  =  1  ')).toEqual({ A: '1' });
  });
});

describe('break: json/toml/yaml', () => {
  it('json: BOM, empty, strict', () => {
    expect(parseJsonText('﻿{"a":1}', 'f')).toEqual({ a: 1 });
    expect(parseJsonText('  ', 'f')).toEqual({});
    expect(() => parseJsonText('{bad}', 'myfile')).toThrow(/myfile/);
  });

  it('toml: empty, invalid, dup keys', () => {
    expect(parseTomlText('', 'f')).toEqual({});
    expect(parseTomlText('﻿a = 1', 'f')).toEqual({ a: 1 });
    expect(() => parseTomlText('a = ', 'myfile')).toThrow(/myfile/);
    expect(() => parseTomlText('a = 1\na = 2', 'f')).toThrow(/ParseError/);
  });

  it('yaml: empty, multi-doc, trailing separator, bad indent, explicit null', () => {
    expect(parseYamlText('  \n', 'f')).toEqual({});
    expect(parseYamlText('﻿a: 1', 'f')).toEqual({ a: 1 }); // BOM-tolerant like the other formats
    expect(() => parseYamlText('a: 1\n---\nb: 2', 'myfile')).toThrow(/multi-doc/);
    expect(parseYamlText('a: 1\n---\n', 'f')).toEqual({ a: 1 });
    expect(() => parseYamlText('a: [1, 2', 'myfile')).toThrow(/myfile/);
    // Explicit `null` normalizes to {} (a null config file means "no overrides").
    expect(parseYamlText('null', 'f')).toEqual({});
  });
});
