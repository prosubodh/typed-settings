# typed-settings

One-call typed config for TS. M1 core is implemented per spec v0.1.1 (patched).

```ts
import { z } from 'zod';
import { settings } from 'typed-settings';

export const cfg = settings({
  schema: z.object({
    port: z.coerce.number().default(3000),
    db: z.object({ url: z.string().url() }),
  }),
  sources: ['.env', 'env'],
  prefix: 'APP_', // APP_PORT, APP_DB__URL
});
// cfg.port: number, cfg.db.url: string — frozen, throws ConfigError on boot if invalid
```

## Status (M1 core + formats done)

- `src/index.ts`: `settings`, `settingsAsync`, `withOverrides`, `pickPublic`, `viteSettings`
- `src/formats/env|json|yaml|toml.ts`: POSIX .env, strict JSON, single-doc YAML, TOML via smol-toml
- `src/expand.ts`: `$VAR` / `${VAR}` / `${VAR:-def}` / `$$` escape, single pass
- `src/coerce.ts`: best-effort leaf coerce (bool/number/null/JSON/csv); schema has final authority
- `src/merge.ts`: `__` nesting, prefix strip (ci, once), deep merge + `replace|concat|mergeIndex`
- `src/index.ts`: file precedence fixed (later files win, flat env/overrides on top), `maxBytes` guard, `unknownKeys: strip|preserve|reject`
- `src/adapter.ts`: Standard Schema v1 (`thenable` check, path normalize, no `vendor` branching)
- `src/node.ts`: `loadEnvFiles`, `loadSecretsDir` (missing file = skip), `watchSettings` (parent-dir watch, debounce, stable-size, atomic swap, `get/reload/dispose`, `refreshMs/pollMs`)
- `src/cli/*`: `check` (0 ok / 1 invalid / 2 load-usage, human|json), `init` (5 libs × 3 formats, 0600, `--force/--dry-run/--check`), `gen` (`describeSchema`: Zod3/4 + Valibot v1 + ArkType v2 full, Effect/others `GEN_BEST_EFFORT`), `watch` (`--once`, child `-- cmd` restart), `jiti` schema load (function schemas incl. ArkType supported)
- `src/framework/*`: `next` (server pattern + explicit `publicSettings`, userland `import 'server-only'`), `vite` (`import.meta.env` map, no-spread rule)
- `test/edge.test.ts` (13 asserts: no `node:` imports in core/vite/framework, fs owners fenced, dist chunk scan)
- `scripts/check-size.mjs` (`npm run size`: core 6.20kb/8kb, cli 12.67kb/25kb OK), `jsr.json` (JSR-first exports)
- Tests: 74 green (`core:8`, `valibot:1`, `formats:11`, `arrays:9`, `watch:4`, `vault:9`, `cli:5`, `gen:7`, `framework:3`, `edge:13`, `security:4`)

## Array semantics (hardened)

- `ARR__0..N` dense indexes fold to arrays; gaps → `E_SPARSE_ARRAY`; >1024 → `E_ARRAY_CAP`.
- Same-layer scalar/list + indexed mix (`ARR=a,b` with `ARR__0=x`) → `E_ARRAY_MIX`.
- Cross-layer: `replace` wins (shrink allowed), `concat` appends, `mergeIndex` per-index deep-union (tail preserved; shrink via `replace`).

## Release

- `npm run size` green (core 7.24kb/8kb, cli 14.47kb/25kb). `npm pack --dry-run` + `npm publish --dry-run` clean, no warnings (83 files, LICENSE included, bin intact).
- Value-equality secret redaction (raw + base64) covered by `test/security.test.ts`.
- CI: `.github/workflows/ci.yml` (Node 20/22/24 × typecheck/test/build/size).
- Publish: `npm publish --provenance` (2FA required). JSR: `jsr publish --dry-run` then `jsr publish` (`jsr.json` present).

## Next (M2 per spec)

1. Done: core, formats, `unknownKeys`, indexed arrays + `mergeIndex` hardening, `watchSettings`, `vault/*`, `cli/*`, framework bindings, Edge assert, size CI, `LICENSE`, `jsr.json`, pack validation
2. Remaining: npm RC + JSR publish (`npm pack --dry-run` clean, `npm run size` green)

## Known M1 limitations

- Keys are lowercased; schemas should use lowercase keys (case-insensitive remap to schema keys lands in M2 via `describeSchema`).
- `.env`/file reads in core use a `require("node:fs")` fallback; Edge must pass `{ text }` / `{ map }`. Full `core`/`node` split assert lands in M2.
- YAML/TOML/JSON file sources, vault providers, watch, CLI not yet wired.
