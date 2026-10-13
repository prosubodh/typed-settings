# Configuration

Everything `SettingsOptions` accepts, every source spelling, and how precedence actually plays out. For what happens *inside* a source (env grammar, expansion, coercion), see [syntax.md](syntax.md).

## Options

```ts
settings({
  schema,               // required: Standard Schema (zod/valibot/arktype) or a legacy bridge
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

Going field by field:

- **`schema`** (required). A Standard Schema object. If its `validate()` returns a promise, sync `settings()` throws `USE_ASYNC` and you need `settingsAsync()`.
- **`sources`** (default `['.env', 'env']`). Ordered layers, later wins per leaf. Details below.
- **`prefix`**. Strips case-insensitively and exactly once; whatever's left must be non-empty. A per-source `prefix` replaces the global one for that source, it doesn't stack with it. **Sharp edge:** matching happens for every source, so a key that doesn't start with the prefix is silently dropped — including lowercase YAML keys (`port: 3000` dies under `prefix: 'APP_'`), secrets-dir files, and `{ map }` entries. If only your env vars carry the prefix, skip the global option and bridge names with `envMap` instead (`{ APP_PORT: 'port' }`).
- **`envMap`**. Escape hatch for awkward keys. Maps an env key to the literal key that variable should occupy: `{ DB_URL: 'db_url' }` makes the `DB_URL` variable land on the literal key `db_url`. Despite the name it is not a key→value map. The destination is used as-is: no prefix stripping and no `__` splitting (it is lowercased like everything else).
- **`env`**. The env snapshot, defaulting to `process.env`. Pass `{}` to isolate from ambient variables, or hand in a map in tests and on Edge.
- **`secretKeys`**. Extra secret matchers beyond the default (`key|secret|token|password|private` substring, case-insensitive). Strings match as case-insensitive substrings, RegExps test as given — e.g. `secretKeys: ['passphrase', /pwd$/]` redacts `auth.passphrase` and `db_pwd` in errors (and in `check --format json`). Needed because the default misses names like `pwd`/`passphrase`, and matches substrings like `monkey` — scope precisely when that matters.
- **`fs`**. Injectable filesystem for file sources: `{ readFileSync(path, encoding), statSync?(path) }`. Takes precedence over the `typed-settings/node` global hook and the `require('node:fs')` fallback — useful in tests, bundlers, and Edge shims. `statSync` enables the pre-read `maxBytes` gate.
- **`expand`** (default `true`). `$VAR` expansion after merging. `false` leaves every string exactly as written.
- **`allowUnresolved`** (default `false`). `true` keeps `${MISSING}` literally instead of throwing `E_UNRESOLVED`.
- **`expandSecrets`** (default `false`). Vault-provided values skip expansion unless you set this. Secrets containing `$` (passwords, connection strings) shouldn't be reinterpreted by default.
- **`coerce`** (default `true`). Best-effort leaf coercion before validation. It never throws; when nothing matches, the string passes through and the schema decides.
- **`arrayStrategy`** (default `'replace'`). How arrays merge across layers. `replace` takes the later array wholesale (so shrinking works), `concat` appends, `mergeIndex` unions per index: later source wins at each overlapping position and the longer tail survives, so `[1,2]` merged over `[3]` yields `[3,2]`.
- **`unknownKeys`** (default `'strip'`). `preserve` deep-merges undeclared input keys into the result; `reject` throws `E_UNKNOWN_KEY` listing every extra leaf path.
- **`freeze`** (default `true`). Deep-freezes the result. Set `false` if you need a live object.
- **`timeoutMs`** (default `5000`). Only meaningful for `settingsAsync`: provider loads share one deadline of `timeoutMs` total (not per provider) and async validation races against it, surfacing `E_TIMEOUT`. Sync `settings()` ignores it. Must be positive finite (`E_USAGE` otherwise).
- **`maxBytes`** (default 2 MiB). Per-file read cap, counted in UTF-8 bytes, not characters. Over it throws `E_FILE_TOO_LARGE`. When a `statSync` is available (the `typed-settings/node` hook or `opts.fs`), oversized files are rejected before reading; otherwise the cap is enforced after the read. Must be positive finite (`E_USAGE` otherwise).

There's a `separator` in the types fixed to `'__'`. Only double underscores split keys; that's not configurable.

## Source spellings

```ts
sources: [
  'env',                       // process.env (or opts.env)
  '.env', '.env.local',        // dotenv files; missing files are skipped
  'config/base.yaml',          // file shorthand: .json/.yaml/.yml/.toml parse
                               // structurally, anything else parses as dotenv
  { text: 'PORT=1' },          // dotenv text, inline
  { file: 'config/extra.toml' }, // explicit file
  { dir: '/run/secrets' },     // secrets dir — core rejects it (E_USAGE); see below
  { map: { port: 1 }, prefix: 'X_' }, // inline values, optional per-source prefix
  { provider: vault, prefix: 'VAULT_' }, // vault provider, optional prefix
  vault,                       // bare provider (anything with a .load() function)
  { PORT: 1 },                 // bare object = inline values
]
```

A few things that bite people:

- An object with a *non-function* `load` key, like `{ load: 'foo' }`, is treated as plain config data. Only a callable `load` makes it a provider.
- `{ dir }` throws `E_USAGE` inside core, deliberately. Core never touches directories, so a `{ dir }` source is almost always a mistake — silently contributing nothing is worse than refusing loudly. Both `settings()` and `settingsAsync()` reject it. Read the dir with `loadSecretsDir()` from `typed-settings/node` and feed the result back as `{ map }`.
- A missing file (`ENOENT`) is skipped without a word. `EACCES` and other I/O errors always throw. A secret you can't read must never look like an empty secret.
- Broken file syntax throws `E_PARSE` with the filename attached (a vault response body that isn't JSON is the same code). A malformed `${}` in a value is `E_EXPAND`, not `E_PARSE` — it's a value problem, so the CLI exits `1` on it. Exact `__proto__` keys (flat or from JSON) throw `E_PROTO`; `constructor`/`prototype` are inert and flow through as ordinary keys. Authored keys outside `[A-Za-z0-9_]` throw `E_BAD_KEY` (the ambient `env` layer skips them instead). Cyclic in-memory values (a map, or YAML anchors) throw `E_CIRCULAR`.
- Under ESM without `typed-settings/node` imported, any file source throws `E_NO_FS`. Loudly. Silently skipping your config file would be much worse.

## Precedence

Later sources deep-merge over earlier ones, leaf by leaf, and flat keys merge with file trees into one object:

```ts
// 'c.json' wins for shared keys:
sources: [{ map: { a: 'flat' } }, 'c.json']   // a === 'file'
// flip the order, flip the winner:
sources: ['c.json', { map: { a: 'flat' } }]   // a === 'flat'
```

So `{ map: { DB__HOST: 'x' } }` combined with a `c.json` holding `{ "db": { "port": 1 } }` gives `{ db: { host: 'x', port: 1 } }`. No layer type gets special treatment; position in the list is the whole rule.

When validation fails, each issue names the winning layer in `from`: `'env'`, the filename, the provider name, `'overrides'`, or `'defaults'`/`'schema'` when nothing provided the key. That's usually enough to find the offending file.

## Prefix and envMap

`prefix` runs first and drops non-matching keys on *every* source — which is why `envMap` is the gentler tool when only env vars carry the prefix. Destinations of `envMap` skip prefix-stripping (and the `__` split) entirely, so they survive regardless.

```ts
settings({ schema, sources: [{ map: { APP_PORT: '1' } }], prefix: 'APP_' });
// APP_PORT -> port
```

Matching requires a segment boundary: a prefix ending in a word character only strips when the remainder starts with a non-word character. So `prefix: 'APP'` strips `APP_FOO` (leaving `_FOO`) but leaves `APPLE` untouched — the key is dropped, never silently cut down to `le`. A prefix that already ends at a boundary (like `APP_`) always qualifies.

```ts
// FOO's value lands on the literal key `a__b` verbatim (no `__` nesting):
expandKeys({ FOO: 'v' }, { envMap: { FOO: 'a__b' } }); // { a__b: 'v' }
```

## Helpers

```ts
withOverrides({ PORT: '1' }, () => settings({ schema })); // patch process.env, then restore.
                                                          // Holds across awaits, restores on throw.
pickPublic(cfg, ['port']);          // explicit subset; missing keys are skipped, not set to undefined
viteSettings({ schema }, import.meta.env); // map-only settings, see frameworks.md
```

File helpers from `typed-settings/node` (note the shapes — they differ more than their names suggest):

| Helper | Takes | Returns |
|---|---|---|
| `loadEnvFiles(paths, { maxBytes? })` | file paths (+ optional total cap, default 2 MiB) | `{ text }` (contents joined with `\n`; missing files skipped) — pass to `{ text }` |
| `parseEnvFile(path)` | one file **path** (not contents) | a parsed flat map; missing file reads as `{}` |
| `loadSecretsDir(dir)` | a directory path | a flat map, one key per file |
| `watchSettings(opts, cb)` | options + callbacks | a handle: `get()`, `reload()`, `dispose()`, `version` |
