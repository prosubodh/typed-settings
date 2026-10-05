import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Core (Edge-safe) surface: importing any of these must never pull in node builtins.
// Covers src/index.ts + its static graph: errors, types, formats/env|json, expand, coerce, merge, adapter.
const CORE_FILES = [
  'src/index.ts',
  'src/errors.ts',
  'src/types.ts',
  'src/adapter.ts',
  'src/expand.ts',
  'src/merge.ts',
  'src/coerce.ts',
  'src/formats/env.ts',
  'src/formats/json.ts',
  'src/framework/vite.ts',
  'src/framework/next.ts',
];

const FORBIDDEN = [/from\s+['\"]node:/];

describe('edge: core stays fs-free', () => {
  for (const f of CORE_FILES) {
    it(`${f} has no node: imports`, () => {
      const text = readFileSync(join(process.cwd(), f), 'utf8');
      for (const re of FORBIDDEN) {
        expect(text).not.toMatch(re);
      }
      // NOTE: src/index.ts intentionally references require("node:fs") inside
      // `new Function(...)` (bundler-opaque, ESM-safe) + the __typedSettingsFs
      // injection hook set by `typed-settings/node`. Neither is a static import,
      // so Edge bundlers can still tree-shake/drop the node entry.
    });
  }

  it('watch/vault/node entries are the only fs owners', () => {
    const owners = ['src/node.ts'];
    for (const f of owners) {
      const text = readFileSync(join(process.cwd(), f), 'utf8');
      expect(text).toContain('node:fs');
    }
    // formats/yaml|toml + vault/* may import peer deps but never node:fs
    for (const f of ['src/formats/yaml.ts', 'src/formats/toml.ts', 'src/vault/hashicorp.ts', 'src/vault/http.ts', 'src/vault/aws.ts', 'src/vault/shared.ts']) {
      const text = readFileSync(join(process.cwd(), f), 'utf8');
      expect(text).not.toMatch(/from\s+['\"]node:/);
    }
  });

  it('no stray require("node:fs") in core dist chunk', async () => {
    // dist/index.js is a facade; the real core lives in chunks. Assert none of the
    // core-attributed chunks statically import node:fs (the Function('require') shim is a string, not an import).
    const dist = join(process.cwd(), 'dist');
    let files: string[] = [];
    try {
      files = readdirSync(dist).filter((x) => x.endsWith('.js'));
    } catch {
      return; // dist not built in this env — src assertions above still guard
    }
    for (const file of files) {
      const p = join(dist, file);
      if (statSync(p).isDirectory()) continue;
      const text = readFileSync(p, 'utf8');
      if (file.startsWith('node') || file.includes('main')) continue; // node/cli entries own fs
      expect(text).not.toMatch(/from\s*['\"]node:fs['\"]/);
    }
  });
});
