# typed-settings

![npm version](https://img.shields.io/npm/v/typed-settings)
![build](https://github.com/prosubodh/typed-settings/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/npm/l/typed-settings)
![node](https://img.shields.io/node/v/typed-settings)

One function call turns env, `.env` files, YAML/TOML/JSON, secrets dirs, and vault secrets into a **typed, validated, frozen** config object. Fail at boot with a readable error — never at 3 AM with `undefined`.

```sh
npm install typed-settings zod
```

```ts
// src/settings.ts
import { z } from 'zod';
import { settings } from 'typed-settings';

export const cfg = settings({
  schema: z.object({
    port: z.coerce.number().default(3000),
    db: z.object({ url: z.string().url() }),
  }),
  sources: ['.env', 'env'], // defaults; later source wins
  prefix: 'APP_',           // APP_PORT, APP_DB__URL
});

console.log(cfg.port); // number — typed, validated, frozen
```

```sh
APP_PORT=4000 APP_DB__URL=postgres://db/app node app.js
```

If a variable is missing or invalid, the app throws before anything else runs:

```
Invalid config (1 issue):
- db.url (from env): Invalid input: expected string, received undefined
```

- [Why](#why)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Sources & precedence](#sources--precedence)
- [Options](#options)
- [Validation libraries](#validation-libraries)
- [Secrets & redaction](#secrets--redaction)
- [CLI](#cli)
- [Framework bindings](#framework-bindings)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Why

| Instead of … | You get … |
|---|---|
| `dotenv` + hand-rolled `z.coerce.number().parse(process.env)` in every repo | One call: load + merge + expand + coerce + validate + freeze |
| `envalid` flat-only validation | Nested objects via `APP_DB__URL`, indexed arrays via `ARR__0`, YAML/TOML/JSON files |
| Typo in `DB_URL` failing at query time | Boot-time `ConfigError` naming the key and the source it came from |
| Secrets printed in error logs | Automatic redaction of secret values (raw + base64) in every error message |
| Vault/AWS glue code per service | `hashicorp` / `http` / `aws` providers with timeouts, size caps, and fail-closed errors |

## Quick start

**1. Install** (Node 20+):

```sh
npm install typed-settings zod
```

Use your validator of choice — `zod`, `valibot`, or `arktype` are peer dependencies (all optional). Legacy `yup` / `joi` / `superstruct` work via `typed-settings/yup` etc.

**2. Write a schema** with lowercase keys (env keys are lowercased during load):

```ts
// src/settings.ts
import { z } from 'zod';
import { settings } from 'typed-settings';

const schema = z.object({
  port: z.coerce.number().default(3000),
  db: z.object({
    host: z.string().default('localhost'),
    url: z.string().url().optional(),
  }),
});

export const cfg = settings({ schema, prefix: 'APP_' });
```

**3. Provide values** — any mix works:

```sh
# .env
APP_PORT=4000
APP_DB__HOST=db.internal
```

```sh
APP_PORT=5000 node app.js   # process.env wins over .env
```

`cfg` is `{ port: 5000, db: { host: 'db.internal' } }`, deeply frozen. That's the whole API for most apps. The rest of this README is reference.

## How it works

Every call runs one pipeline:

1. **Collect** — each source becomes an ordered layer (missing files are skipped).
2. **Merge** — later sources deep-merge over earlier ones, per leaf.
3. **Expand** — `$VAR` / `${VAR}` / `${VAR:-default}` references resolve (vault values skip this unless `expandSecrets: true`).
4. **Coerce** — best-effort leaf coercion (`"4000"` → `4000`, `"true"` → `true`, `"a,b"` → `["a","b"]`); the schema has the final word.
5. **Validate** — via [Standard Schema](https://standardschema.dev) (zod/valibot/arktype natively, yup/joi/superstruct via bridges).
6. **Freeze** — deep-frozen unless `freeze: false`.

Details: [docs/syntax.md](docs/syntax.md) (env format, expansion, coercion, arrays), [docs/configuration.md](docs/configuration.md) (every option), [docs/errors.md](docs/errors.md) (every error code).

## Sources & precedence

Listed order wins — put the highest-priority source **last**:

```ts
settings({
  schema,
  sources: [
    'base.yaml',          // file shorthand (json/yaml/toml/env by extension)
    '.env',               // .env / .env.local
    'env',                // process.env
    { map: { port: 1 } }, // inline overrides (highest here)
  ],
});
```

| Spelling | Meaning |
|---|---|
| `'env'` | `process.env` (or `opts.env` in tests/Edge) |
| `'.env'`, `'.env.local'` | dotenv files; missing file = skip |
| `'config.yaml'` (any path) | structured file by extension (`.json` `.yaml` `.yml` `.toml`), otherwise dotenv format |
| `{ text: 'PORT=1' }` | inline dotenv text |
| `{ file: 'path/to/x.yaml' }` | explicit file source |
| `{ dir: '/run/secrets' }` | secrets dir — resolve with `loadSecretsDir()` from `typed-settings/node`, pass back as `{ map }` |
| `{ map: {...}, prefix?: 'X_' }` | inline values, optional per-source prefix |
| `{ provider, prefix? }` / provider | vault provider — **async providers need `settingsAsync()`** |
| `{ PORT: 1 }` (bare object) | inline values |

`prefix` strips case-insensitively, once: `APP_PORT` → `port` with `prefix: 'APP_'`. `DB__URL` nests to `db.url`. `ARR__0`, `ARR__1` fold to arrays. Full rules: [docs/syntax.md](docs/syntax.md), [docs/configuration.md](docs/configuration.md).

Node helpers (`typed-settings/node`):

```ts
import { loadEnvFiles, loadSecretsDir, parseEnvFile, watchSettings } from 'typed-settings/node';

const secrets = loadSecretsDir('/run/secrets'); // { DB_PASSWORD: '…' }
const cfg = settings({ schema, sources: [{ map: secrets }, '.env', 'env'] });
```

> Under ESM without `typed-settings/node` imported, file sources fail loudly (`E_NO_FS`) instead of silently skipping. Edge runtimes should pass `{ text }` / `{ map }` and never touch files.

Async (vault, async schemas):

```ts
import { settingsAsync } from 'typed-settings';
import { hashicorpProvider } from 'typed-settings/vault-hashicorp';

const cfg = await settingsAsync({
  schema,
  sources: [{ provider: hashicorpProvider({ url: 'https://vault:8200', path: 'app/prod' }) }, 'env'],
  timeoutMs: 5000,
});
```

Providers: [docs/vault.md](docs/vault.md).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `schema` | Standard Schema | — (required) | zod / valibot / arktype object, or a legacy bridge |
| `sources` | `SourceInput[]` | `['.env', 'env']` | ordered layers, later wins |
| `prefix` | `string` | — | global prefix strip (case-insensitive, once) |
| `envMap` | `Record<string,string>` | — | escape keys: value is used literally (no split/strip) |
| `env` | `Flat` | `process.env` | env snapshot (tests, Edge, Vite) |
| `expand` | `boolean` | `true` | `$VAR` expansion post-merge |
| `allowUnresolved` | `boolean` | `false` | keep `${MISSING}` literally instead of throwing `E_UNRESOLVED` |
| `expandSecrets` | `boolean` | `false` | also expand `$VAR` inside vault-provided values |
| `coerce` | `boolean` | `true` | best-effort leaf coercion before validation |
| `arrayStrategy` | `replace \| concat \| mergeIndex` | `'replace'` | cross-layer array merge |
| `unknownKeys` | `strip \| preserve \| reject` | `'strip'` | `reject` throws `E_UNKNOWN_KEY` |
| `freeze` | `boolean` | `true` | deep-freeze the result (`false` returns it live) |
| `timeoutMs` | `number` | `5000` | async provider + async validation timeout (`E_TIMEOUT`) |
| `maxBytes` | `number` | `2 MiB` | per-file read cap (`E_FILE_TOO_LARGE`) |

All options, defaults, and edge semantics: [docs/configuration.md](docs/configuration.md).

## Validation libraries

```ts
import { z } from 'zod';            // native (v3 + v4)
import * as v from 'valibot';       // native (v1)
import { type } from 'arktype';     // native (v2, incl. function schemas)
```

```ts
import { yupAdapter } from 'typed-settings/yup';
import { joiAdapter } from 'typed-settings/joi';
import { superstructAdapter } from 'typed-settings/superstruct';

settings({ schema: yupAdapter(userSchema), sources: ['env'] });
```

`gen` describes Zod 3/4, Valibot, and ArkType schemas fully; anything else emits a best-effort placeholder with a `GEN_BEST_EFFORT` warning.

## Secrets & redaction

Any key matching `/key|secret|token|password|private/i` is treated as secret: error messages never contain its value (raw or base64) — they show `(redacted)` instead. Short values collapse to `(redacted)`; longer ones show a `abc-*** (N chars)` shape. See [docs/errors.md](docs/errors.md).

## CLI

```sh
npx typed-settings check -s src/settings.ts -c base.yaml,.env
npx typed-settings init --lib zod --format env
npx typed-settings gen --schema src/settings.ts --out .env.example --docs CONFIG.md
npx typed-settings watch -s src/settings.ts -c base.yaml -- node server.js
```

| Command | Purpose | Exit codes |
|---|---|---|
| `check` | validate config against schema (`--strict`, `--no-expand`, `--array`, `--format human\|json`) | 0 ok · 1 invalid · 2 load/usage |
| `init` | scaffold `src/settings.ts` + example file (`--force`, `--dry-run`, `--check`) | 0 ok · 2 error/drift |
| `gen` | generate `.env.example` + `CONFIG.md` from a schema (`--force`) | 0 ok · 2 load/exists |
| `watch` | validate once (`--once`) or supervise + restart `-- cmd` | 0 ok · 1 invalid · 2 load/usage |

Full flags and schema-export resolution: [docs/cli.md](docs/cli.md).

## Framework bindings

**Next.js** (`typed-settings/next`) — explicit public subset, no spread leaks:

```ts
import 'server-only';
import { settings, publicSettings } from 'typed-settings/next';

const cfg = settings({ schema, sources: ['.env', 'env'], prefix: 'APP_' });
export const publicCfg = publicSettings(cfg, ['port'] as const);
```

**Vite** (`typed-settings/vite`) — `import.meta.env` as a map, no filesystem:

```ts
import { viteSettings } from 'typed-settings/vite';
const cfg = viteSettings({ schema }, import.meta.env);
```

**Watch** — reload on file change, keep serving the old config on errors:

```ts
import { watchSettings } from 'typed-settings/node';
const sub = watchSettings({ schema, sources: ['config.yaml'] }, {
  onUpdate: (cfg, changed) => console.log('reloaded', changed),
  onError: (e) => console.error('kept old config:', e.message),
});
// sub.get() / await sub.reload() / await sub.dispose() / sub.version
```

More recipes (tests, Edge, secrets-dir): [docs/frameworks.md](docs/frameworks.md).

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `USE_ASYNC: provider is async` | A provider (or schema) is async → use `settingsAsync()` |
| `E_UNRESOLVED: FOO missing` | A `$FOO` reference has no value → set it, add `${FOO:-default}`, or pass `allowUnresolved: true` |
| `E_NO_FS` under ESM | Core can't see `node:fs` → `import 'typed-settings/node'` once, or use `{ text }` / `{ map }` sources |
| Schema rejects everything | Keys are lowercased on load → use lowercase keys in schemas |
| `E_UNKNOWN_KEY` | Extra keys with `unknownKeys: 'reject'` (or `--strict`) → remove them or switch to `strip`/`preserve` |
| `SCHEMA_LOAD_ERROR` | CLI can't find the schema → export it as `schema` (or pass `--schema-export NAME`) |
| `E_CIRCULAR` | `A=${B}`, `B=${A}` → break the reference cycle |

All error codes: [docs/errors.md](docs/errors.md).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (309 tests, 100% lines/branches/functions/statements enforced)
npm run build       # tsup (ESM + CJS + DTS)
npm run size        # bundle budgets (tracking)
```

Layout: `src/index.ts` (pipeline) · `src/{expand,coerce,merge,adapter,errors}.ts` · `src/formats/` · `src/node.ts` · `src/vault/` · `src/adapters/` · `src/cli/` · `src/framework/` · `test/` · `docs/` · `examples/`.

## License

MIT — see [LICENSE](LICENSE).
