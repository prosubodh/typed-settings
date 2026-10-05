# typed-settings

![npm version](https://img.shields.io/npm/v/typed-settings)
![build](https://github.com/prosubodh/typed-settings/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/npm/l/typed-settings)
![node](https://img.shields.io/node/v/typed-settings)

Typed config for TypeScript in one function call. It reads env, `.env` files, YAML/TOML/JSON, secrets dirs, and vault secrets, validates them against your schema, and hands you a frozen object. If something's wrong you'll hear about it at boot, with the key name and where it came from, instead of getting `undefined` three layers deep at runtime.

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

console.log(cfg.port); // number. Typed, validated, frozen.
```

```sh
APP_PORT=4000 APP_DB__URL=postgres://db/app node app.js
```

Missing or invalid values throw before anything else runs:

```
Invalid config (1 issue):
- db.url (from defaults): Invalid input: expected string, received undefined
```

- [Why this exists](#why-this-exists)
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

## Why this exists

Every project ends up with the same hand-rolled `src/lib/env.ts`: dotenv plus thirty lines of `z.coerce.number().parse(process.env)` plus a prefix stripper nobody remembers writing. It works until it doesn't. Usually what breaks:

- A typo'd variable that only fails when that code path runs in production.
- Flat-only validation, so nesting gets encoded as string parsing somewhere else.
- Secrets showing up in error logs because someone logged the whole config object.
- A fresh Vault/AWS integration copy-pasted (badly) into every service.

This package is that file, written once and tested properly. It doesn't try to be a platform. It loads config from wherever you keep it, checks it against a schema you already know how to write, and freezes the result.

## Quick start

Needs Node 20+.

**1. Install.** Pick your validator. All three are optional peers, so install the one you use:

```sh
npm install typed-settings zod
```

(Or `valibot`, or `arktype`. Old `yup` / `joi` / `superstruct` schemas work too, through small bridges.)

**2. Write a schema.** One thing to know up front: env keys get lowercased on load, so keep schema keys lowercase and everything lines up.

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

**3. Provide values however you like.** Mix and match; the example below uses a `.env` file plus a process override:

```sh
# .env
APP_PORT=4000
APP_DB__HOST=db.internal
```

```sh
APP_PORT=5000 node app.js   # process.env beats .env
```

`cfg` is `{ port: 5000, db: { host: 'db.internal' } }`, deeply frozen. For most apps that's the entire API. Everything below is reference material for when you need more.

## How it works

Each call runs the same six steps:

1. **Collect.** Every source becomes a layer, in the order you listed them. Files that don't exist are skipped quietly.
2. **Merge.** Later layers win, leaf by leaf. Flat env keys and file trees merge into one object.
3. **Expand.** `${VAR}` references in strings get resolved. Vault values sit this one out unless you opt in.
4. **Coerce.** `"4000"` becomes `4000`, `"true"` becomes `true`. Best effort only; your schema gets the last word.
5. **Validate.** Through [Standard Schema](https://standardschema.dev), so zod, valibot, and arktype all plug in directly.
6. **Freeze.** The result is deep-frozen. Pass `freeze: false` if you really want a live object.

The details live in [docs/syntax.md](docs/syntax.md) (env format, expansion, coercion, arrays), [docs/configuration.md](docs/configuration.md) (every option), and [docs/errors.md](docs/errors.md) (every error code).

## Sources & precedence

Order matters: later sources override earlier ones. Put your highest-priority source last.

```ts
settings({
  schema,
  sources: [
    'base.yaml',          // file shorthand (json/yaml/toml/env guessed by extension)
    '.env',               // .env / .env.local
    'env',                // process.env
    { map: { port: 1 } }, // inline overrides win here
  ],
});
```

The full list of spellings:

| Spelling | What it does |
|---|---|
| `'env'` | `process.env` (or `opts.env` in tests and on Edge) |
| `'.env'`, `'.env.local'` | dotenv files; a missing file is skipped |
| `'config.yaml'` (any path) | structured file if the extension is `.json`/`.yaml`/`.yml`/`.toml`, dotenv format otherwise |
| `{ text: 'PORT=1' }` | dotenv text, inline |
| `{ file: 'path/to/x.yaml' }` | explicit file source |
| `{ dir: '/run/secrets' }` | secrets dir. Core ignores this on purpose (it never touches directories); read it with `loadSecretsDir()` from `typed-settings/node` and pass the result back as `{ map }` |
| `{ map: {...}, prefix?: 'X_' }` | inline values, with an optional per-source prefix |
| `{ provider, prefix? }` or bare provider | vault provider. Async ones require `settingsAsync()` |
| `{ PORT: 1 }` (plain object) | inline values. (An object with a non-function `load` key counts as data, not a provider) |

`prefix` strips case-insensitively and exactly once, so `APP_PORT` becomes `port` with `prefix: 'APP_'`. Double underscores nest (`APP_DB__URL` → `db.url`) and `ARR__0`, `ARR__1` fold into arrays. The edge cases are in [docs/syntax.md](docs/syntax.md); all the options in [docs/configuration.md](docs/configuration.md).

Node helpers (`typed-settings/node`):

```ts
import { loadEnvFiles, loadSecretsDir, parseEnvFile, watchSettings } from 'typed-settings/node';

const secrets = loadSecretsDir('/run/secrets'); // { DB_PASSWORD: '…' }
const cfg = settings({ schema, sources: [{ map: secrets }, '.env', 'env'] });
```

One gotcha worth knowing: under ESM, file reading goes through an injection that `typed-settings/node` sets up. If you use file sources without importing it, you get a loud `E_NO_FS` error instead of silently empty config. On Edge runtimes, skip files entirely and pass `{ text }` / `{ map }`.

Async, for vault and async schemas:

```ts
import { settingsAsync } from 'typed-settings';
import { hashicorpProvider } from 'typed-settings/vault-hashicorp';

const cfg = await settingsAsync({
  schema,
  sources: [{ provider: hashicorpProvider({ url: 'https://vault:8200', path: 'app/prod' }) }, 'env'],
  timeoutMs: 5000,
});
```

Provider details: [docs/vault.md](docs/vault.md).

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `schema` | Standard Schema | required | zod / valibot / arktype object, or a legacy bridge. An async `validate()` forces `settingsAsync()` |
| `sources` | array | `['.env', 'env']` | layers in priority order, later wins |
| `prefix` | `string` | - | global prefix strip, case-insensitive, once |
| `envMap` | object | - | keys used literally: no prefix strip, no `__` splitting |
| `env` | object | `process.env` | the env snapshot. Pass `{}` to isolate, or a map in tests/on Edge |
| `expand` | `boolean` | `true` | `$VAR` expansion after merging. `false` leaves literals alone |
| `allowUnresolved` | `boolean` | `false` | `true` keeps `${MISSING}` as-is instead of throwing |
| `expandSecrets` | `boolean` | `false` | also expand `$VAR` inside vault-provided values |
| `coerce` | `boolean` | `true` | best-effort type coercion before validation; never throws |
| `arrayStrategy` | `replace \| concat \| mergeIndex` | `'replace'` | how arrays merge across layers |
| `unknownKeys` | `strip \| preserve \| reject` | `'strip'` | `reject` throws `E_UNKNOWN_KEY` |
| `freeze` | `boolean` | `true` | deep-freeze the result |
| `timeoutMs` | `number` | `5000` | async only: provider loads and async validation race this |
| `maxBytes` | `number` | `2 MiB` | per-file read cap, counted in UTF-8 bytes |

Full semantics for each: [docs/configuration.md](docs/configuration.md).

## Validation libraries

```ts
import { z } from 'zod';            // native, v3 and v4
import * as v from 'valibot';       // native, v1
import { type } from 'arktype';     // native, v2, function schemas included
```

```ts
import { yupAdapter } from 'typed-settings/yup';
import { joiAdapter } from 'typed-settings/joi';
import { superstructAdapter } from 'typed-settings/superstruct';

settings({ schema: yupAdapter(userSchema), sources: ['env'] });
```

`gen` fully describes Zod 3/4, Valibot, and ArkType schemas. Anything else gets a commented placeholder plus a `GEN_BEST_EFFORT` warning on stderr, meaning: good starting point, check the types by hand.

## Secrets & redaction

Keys looking like secrets (`key`, `secret`, `token`, `password`, `private`, case-insensitive) get special treatment in errors: the value never appears, neither raw nor base64'd. You see `(redacted)` instead. More in [docs/errors.md](docs/errors.md).

## CLI

```sh
npx typed-settings check -s src/settings.ts -c base.yaml,.env
npx typed-settings init --lib zod --format env
npx typed-settings gen --schema src/settings.ts --out .env.example --docs CONFIG.md
npx typed-settings watch -s src/settings.ts -c base.yaml -- node server.js
```

| Command | What it's for | Exit codes |
|---|---|---|
| `check` | validate config against a schema (`--strict`, `--no-expand`, `--array`, `--format human\|json`) | 0 valid · 1 invalid · 2 load/usage problem |
| `init` | scaffold `src/settings.ts` plus an example file (`--force`, `--dry-run`, `--check`) | 0 ok · 2 error or drift |
| `gen` | generate `.env.example` + `CONFIG.md` from a schema (`--force`) | 0 ok · 2 load problem or file exists |
| `watch` | validate once (`--once`) or supervise and restart `-- cmd` | 0 ok · 1 invalid · 2 load/usage problem |

Flags and schema-export resolution: [docs/cli.md](docs/cli.md).

## Framework bindings

**Next.js** (`typed-settings/next`). Take an explicit public subset so secrets can't leak through a spread:

```ts
import 'server-only';
import { settings, publicSettings } from 'typed-settings/next';

const cfg = settings({ schema, sources: ['.env', 'env'], prefix: 'APP_' });
export const publicCfg = publicSettings(cfg, ['port'] as const);
```

The `server-only` import is yours to add; the package stays dependency-free on purpose.

**Vite** (`typed-settings/vite`). Hand it `import.meta.env` as a plain map; no filesystem involved:

```ts
import { viteSettings } from 'typed-settings/vite';
const cfg = viteSettings({ schema }, import.meta.env);
```

**Watch.** Reload on file change, keep serving the old config when the new one is broken:

```ts
import { watchSettings } from 'typed-settings/node';
const sub = watchSettings({ schema, sources: ['config.yaml'] }, {
  onUpdate: (cfg, changed) => console.log('reloaded', changed),
  onError: (e) => console.error('kept old config:', e.message),
});
// sub.get() / await sub.reload() / await sub.dispose() / sub.version
```

Recipes for tests, Edge, and secrets dirs: [docs/frameworks.md](docs/frameworks.md).

## Troubleshooting

Things people actually hit, in rough order of frequency:

- **`USE_ASYNC: provider is async`.** One of your providers (or the schema itself) is async. Switch to `settingsAsync()`.
- **`E_UNRESOLVED: FOO missing`.** A `$FOO` reference points at nothing. Set the variable, give it a default (`${FOO:-fallback}`), or pass `allowUnresolved: true` to leave it literal.
- **Schema rejects everything.** Keys are lowercased during load, so schemas need lowercase keys. `port`, not `PORT`.
- **`E_NO_FS` under ESM.** Core can't reach `node:fs` on its own. Import `typed-settings/node` once, or stick to `{ text }` / `{ map }` sources.
- **`E_UNKNOWN_KEY`.** Extra keys with `unknownKeys: 'reject'` (the CLI calls this `--strict`). Either drop the keys or switch to `strip` / `preserve`.
- **`SCHEMA_LOAD_ERROR`.** The CLI can't find your schema. Export it under the name `schema`, or point at it with `--schema-export NAME`.
- **`E_CIRCULAR`.** Two variables reference each other (`A=${B}`, `B=${A}`). Unwind the cycle.

Every code is listed with a fix in [docs/errors.md](docs/errors.md).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest - 309 tests, 100% lines/branches/functions/statements enforced
npm run build       # tsup (ESM + CJS + DTS)
npm run size        # bundle budgets (tracking only)
```

The source is laid out by job: `src/index.ts` is the pipeline, `src/{expand,coerce,merge,adapter,errors}.ts` are the stages, then `src/formats/`, `src/node.ts`, `src/vault/`, `src/adapters/`, `src/cli/`, `src/framework/`. Tests live in `test/`, reference docs in `docs/`, runnable samples in `examples/`.

## License

MIT, see [LICENSE](LICENSE).
