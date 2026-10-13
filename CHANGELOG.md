# Changelog

## Unreleased

## 0.2.1

- **Smaller published package.** Bundles are minified. The packed tarball drops
  from ~120 KB to ~82 KB (−32%) and unpacked from ~465 KB to ~278 KB (−40%).
  No API or behavior change.
- CI: build before test so the `init`-template integration tests resolve the
  built package, and pin the ambient bad-key skip so 100% branch coverage holds
  on Linux as well as Windows.

## 0.2.0

Security hardening and correctness release. New options are additive
(`secretKeys`, `opts.fs`, `LoadSecretsDirOptions`, `--secret-keys`,
`--exit-on-child-error`, `viteSettingsAsync`); several hostile inputs that
used to load silently, corrupt data, or crash now fail closed with a
`ConfigError`, and exit codes distinguish bad values (1) from load/usage
failures (2).

Breaking changes (0.x — review before upgrading):

- **Error codes split and renamed.** `E_CYCLE` is now `E_CIRCULAR`. `E_PARSE`
  is reserved for a *document* that won't parse (a config file, or a vault
  response body); a malformed `${}` in a *value* is now `E_EXPAND` (a value
  error, so `check` exits 1), and `${}` nested past the cap is `E_DEPTH`.
- **Stricter ingestion, loudly.** Authored keys outside `[A-Za-z0-9_]` throw
  `E_BAD_KEY` (the ambient `'env'` layer stays tolerant of OS keys); only an
  exact `__proto__` is `E_PROTO`, so `constructor`/`prototype` are ordinary
  data keys again; an empty `__` segment degrades to a literal key instead of
  throwing `E_EMPTY_SEGMENT`.
- **`{ dir }` sources throw `E_USAGE` in core** (sync and async) instead of
  silently contributing nothing — use `loadSecretsDir()`.
- **`prefix` strips only at a segment boundary**: `prefix: 'APP'` no longer
  cuts `APPLE` down to `le` (the key is dropped instead).
- **Redaction is total.** Error text no longer leaks a three-character prefix
  of a secret; it reports `(redacted: N chars)`.
- **AWS collisions fail closed.** Two secrets/params mapping to one key throw
  `E_COLLISION` instead of silently keeping the last one.
- **`gen --force` refuses symlinked `--out`/`--docs`** (`E_SYMLINK`);
  **`watch` restarts its child only on a real value change**;
  **`loadEnvFiles` caps total size** (`maxBytes`, default 2 MiB).

- Prototype-pollution gates on every ingestion path (flat keys, structured
  files at any depth, `deepMerge`, `coerceDeep`, `withPrefix`,
  `normalizeSecretMap`), including class instances and cross-realm objects.
- `check --format json` redacts secret-looking leaves (strings, numbers,
  booleans), matched by full dotted path; error scrubbing covers non-string
  leaves and no longer corrupts messages on short values.
- `loadSecretsDir` confines symlinks to the directory, throws on case
  collisions, caps file sizes, and adds `preserveEmpty`/`maxBytes` options.
- Vault transports race the whole fetch and the body read against `timeoutMs`,
  share one deadline across providers, map `408`/`504` to `E_TIMEOUT`, and
  strip credentials from URLs before they reach error text. AWS uses a
  whole-load budget and decodes base64 without `node:buffer`.
- Deep-input stack exhaustion surfaces as `E_DEPTH`, never `RangeError`;
  expansion chains and lexical nesting are capped; `coerceDeep` preserves
  class instances (TOML dates stay Dates).
- `settingsAsync` and watch paths clear timeouts, suppress late rejections,
  and hold the enforced 100% line/branch/function coverage.
- CLI: exit codes distinguish bad values (1) from load/usage failures (2);
  `watch --once` delegates to `check`; ambiguous schema files require
  `--schema-export`; `gen` writes atomically and repairs `0600` like `init`;
  `init` scaffolds an exported schema with the node entry.
- `gen` describes optional-nested fields honestly, normalizes prefixes, and
  sanitizes generated keys; `toMarkdownDocs` drops the `<root>` placeholder.
