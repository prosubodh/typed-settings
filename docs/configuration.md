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
- **`prefix`**. Strips case-insensitively and exactly once; whatever's left must be non-empty. A per-source `prefix` replaces the global one for that source, it doesn't stack with it.
- **`envMap`**. Escape hatch for awkward keys. Matched case-insensitively, and the mapped value is used literally: no prefix stripping, no `__` splitting (then lowercased like everything else).
- **`env`**. The env snapshot, defaulting to `process.env`. Pass `{}` to isolate from ambient variables, or hand in a map in tests and on Edge.
- **`expand`** (default `true`). `$VAR` expansion after merging. `false` leaves every string exactly as written.
- **`allowUnresolved`** (default `false`). `true` keeps `${MISSING}` literally instead of throwing `E_UNRESOLVED`.
- **`expandSecrets`** (default `false`). Vault-provided values skip expansion unless you set this. Secrets containing `$` (passwords, connection strings) shouldn't be reinterpreted by default.
- **`coerce`** (default `true`). Best-effort leaf coercion before validation. It never throws; when nothing matches, the string passes through and the schema decides.
- **`arrayStrategy`** (default `'replace'`). How arrays merge across layers. `replace` takes the later array wholesale (so shrinking works), `concat` appends, `mergeIndex` unions per index.
- **`unknownKeys`** (default `'strip'`). `preserve` deep-merges undeclared input keys into the result; `reject` throws `E_UNKNOWN_KEY` listing every extra leaf path.
- **`freeze`** (default `true`). Deep-freezes the result. Set `false` if you need a live object.
- **`timeoutMs`** (default `5000`). Only meaningful for `settingsAsync`: provider loads and async validation race against it and surface `E_TIMEOUT`. Sync `settings()` ignores it.
- **`maxBytes`** (default 2 MiB). Per-file read cap, counted in UTF-8 bytes, not characters. Over it throws `E_FILE_TOO_LARGE`.

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
  { dir: '/run/secrets' },     // secrets dir (core skips it, see below)
  { map: { port: 1 }, prefix: 'X_' }, // inline values, optional per-source prefix
  { provider: vault, prefix: 'VAULT_' }, // vault provider, optional prefix
  vault,                       // bare provider (anything with a .load() function)
  { PORT: 1 },                 // bare object = inline values
]
```

A few things that bite people:

- An object with a *non-function* `load` key, like `{ load: 'foo' }`, is treated as plain config data. Only a callable `load` makes it a provider.
- `{ dir }` does nothing inside core, deliberately. Core never touches directories. Read the dir with `loadSecretsDir()` from `typed-settings/node` and feed the result back as `{ map }`.
- A missing file (`ENOENT`) is skipped without a word. `EACCES` and other I/O errors always throw. A secret you can't read must never look like an empty secret.
- Broken file syntax throws `E_PARSE` with the filename attached. `__proto__` / `constructor` / `prototype` keys, flat or from JSON, throw `E_PROTO`. Cyclic in-memory values throw `E_CYCLE`.
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

```ts
settings({ schema, sources: [{ map: { APP_PORT: '1' } }], prefix: 'APP_' });
// APP_PORT -> port
```

Matching doesn't need a segment boundary, just a non-empty remainder. With `prefix: 'APP'`, `APPLE` becomes `le`. Slightly surprising the first time, completely consistent after.

```ts
// FOO keeps its double underscore instead of nesting:
expandKeys({ FOO: 'v' }, { envMap: { FOO: 'a__b' } }); // { a__b: 'v' }
```

## Helpers

```ts
withOverrides({ PORT: '1' }, () => settings({ schema })); // patch process.env, then restore.
                                                          // Holds across awaits, restores on throw.
pickPublic(cfg, ['port']);          // explicit subset; missing keys are skipped, not set to undefined
viteSettings({ schema }, import.meta.env); // map-only settings, see frameworks.md
```
