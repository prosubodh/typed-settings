# Configuration

Every field of `SettingsOptions`, every source spelling, and the precedence rules. For the format/expansion/coercion rules that apply *within* a source, see [syntax.md](syntax.md).

## Options

```ts
settings({
  schema,               // required: Standard Schema (zod/valibot/arktype) or legacy bridge
  sources: ['.env', 'env'],
  prefix: 'APP_',
  envMap: { FOO: 'a__b' },
  env: process.env,     // override the env snapshot (tests, Edge)
  expand: true,
  allowUnresolved: false,
  expandSecrets: false,
  coerce: true,
  arrayStrategy: 'replace',
  unknownKeys: 'strip',
  freeze: true,
  timeoutMs: 5000,      // settingsAsync only
  maxBytes: 2 * 1024 * 1024,
});
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `schema` | `StandardSchemaV1` | — (required) | Object schemas expected. Async `validate()` forces `settingsAsync()` (`USE_ASYNC` otherwise). |
| `sources` | `SourceInput[]` | `['.env', 'env']` | Ordered layers; **later wins per leaf**. |
| `prefix` | `string` | — | Global prefix strip: case-insensitive, stripped **once**, remainder must be non-empty. A per-source `prefix` **replaces** the global one for that source. |
| `envMap` | `Record<string, string>` | — | Escaped keys: matched case-insensitively, used **literally** — no prefix strip, no `__` split. |
| `env` | `Flat` | `process.env` snapshot | Pass `{}` to isolate from the ambient environment, or a map in tests/Edge. |
| `expand` | `boolean` | `true` | `$VAR` expansion after merge. `false` keeps literals verbatim. |
| `allowUnresolved` | `boolean` | `false` | `true` keeps `${MISSING}` literally instead of throwing `E_UNRESOLVED`. |
| `expandSecrets` | `boolean` | `false` | `true` also expands `$VAR` inside vault-provided values (skipped by default). |
| `coerce` | `boolean` | `true` | Best-effort leaf coercion; never throws; schema decides. `false` passes strings through. |
| `arrayStrategy` | `'replace' \| 'concat' \| 'mergeIndex'` | `'replace'` | How arrays merge across layers. |
| `unknownKeys` | `'strip' \| 'preserve' \| 'reject'` | `'strip'` | `reject` throws `E_UNKNOWN_KEY` listing every extra leaf path. |
| `freeze` | `boolean` | `true` | Deep-freeze the result. `false` returns a live object. |
| `timeoutMs` | `number` | `5000` | `settingsAsync` only: provider loads and async validation race this (`E_TIMEOUT`). Sync `settings()` ignores it. |
| `maxBytes` | `number` | `2 MiB` | Per-file read cap, measured in UTF-8 **bytes** (`E_FILE_TOO_LARGE`). |

`separator` exists in the types (`'__'`) but is fixed — only `__` splits keys.

## Source spellings

```ts
sources: [
  'env',                       // process.env (or opts.env)
  '.env', '.env.local',        // dotenv files; missing = skip
  'config/base.yaml',          // file shorthand: .json/.yaml/.yml/.toml parsed structurally,
                               // anything else parsed as dotenv
  { text: 'PORT=1' },          // inline dotenv text
  { file: 'config/extra.toml' }, // explicit file
  { dir: '/run/secrets' },     // core no-op! resolve via loadSecretsDir(), pass back as { map }
  { map: { port: 1 }, prefix: 'X_' }, // inline values + optional per-source prefix
  { provider: vault, prefix: 'VAULT_' }, // vault provider + optional prefix
  vault,                       // bare provider (must expose .load())
  { PORT: 1 },                 // bare object = inline values
]
```

Notes:

- A plain object with a non-function `load` key (e.g. `{ load: 'foo' }`) is treated as **config data**, not a provider.
- `{ dir }` is intentionally inert in core (core never touches directories): `loadSecretsDir()` from `typed-settings/node` reads it; you pass the result back as `{ map }`.
- Missing files (`ENOENT`) are skipped silently. `EACCES` and other I/O errors always throw — a missing secret never reads as `{}`.
- Bad file syntax throws `E_PARSE` naming the file. `__proto__`/`constructor`/`prototype` keys (flat or JSON) throw `E_PROTO`. Cyclic in-memory values throw `E_CYCLE`.
- Under ESM without `typed-settings/node` imported, any file source throws `E_NO_FS` — loudly, never a silent skip.

## Precedence

Later sources deep-merge over earlier ones **per leaf**, across flat and file layers alike:

```ts
// 'c.json' wins over the map for shared keys:
sources: [{ map: { a: 'flat' } }, 'c.json']   // a === 'file'
// reversed: the map wins:
sources: ['c.json', { map: { a: 'flat' } }]   // a === 'flat'
```

Flat env keys and structured-file keys merge into one tree, so `{ map: { DB__HOST: 'x' } }` and `c.json`'s `{ "db": { "port": 1 } }` combine to `{ db: { host: 'x', port: 1 } }`.

Error attribution follows the winning layer: validation issues carry `from` set to the source label (`'env'`, filename, provider name, `'overrides'`, or `'defaults'`/`'schema'`).

## Prefix and envMap

```ts
settings({ schema, sources: [{ map: { APP_PORT: '1' } }], prefix: 'APP_' });
// APP_PORT -> port
```

Matching needs no segment boundary — only a non-empty remainder. With `prefix: 'APP'`, `APPLE` → `le`.

```ts
// FOO keeps its literal double-underscore key:
expandKeys({ FOO: 'v' }, { envMap: { FOO: 'a__b' } }); // { a__b: 'v' } (lowercased)
```

## Helpers

```ts
withOverrides({ PORT: '1' }, () => settings({ schema })); // patch process.env, restore after
pickPublic(cfg, ['port']);          // explicit subset, missing keys skipped
viteSettings({ schema }, import.meta.env); // map-only settings (see frameworks.md)
```
