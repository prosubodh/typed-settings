# CLI

The `typed-settings` binary does four jobs: check a config, scaffold a project, generate artifacts from a schema, and supervise a process. Exit codes are contractual so CI can depend on them.

## `check`: validate a config

```sh
typed-settings check -s src/settings.ts -c base.yaml,.env [--strict] [--no-expand] \
  [--array replace|concat|mergeIndex] [--format human|json] [--schema-export NAME] [--prefix APP_]
```

`-s` is required; `-c` defaults to `.env,env` using the same source spellings as the library. `--strict` turns on `unknownKeys: 'reject'`, `--no-expand` skips `$VAR` expansion, `--format json` prints `{ok, config}` or `{ok:false, issues|error}` for machines. Secret-looking leaves (`key|secret|token|password|private`) are redacted in the json `config` output since CI logs capture stdout — the human format never prints values either, only error messages (also redacted).

Exit codes: `0` for valid, `1` for invalid config, `2` when the schema can't be loaded or the flags are wrong.

## `init`: scaffold a project

```sh
typed-settings init --lib zod --format env [--dir .] [--force|--dry-run|--check]
```

`--lib` picks the validator flavor (`zod`, `valibot`, `arktype`, `yup`, `joi`; default `zod`) and `--format` the example file (`env`, `yaml`, `toml`; default `env`). It writes `src/settings.ts` plus `.env.example` (or `config.yaml` / `config.toml`) with mode `0600`, since these files tend to collect real secrets eventually.

`--dry-run` and `--check` print `create`, `exists`, or `overwrite` per file without writing anything. `--check` exits `2` when content drifted, so it works as a CI gate. Existing files are only overwritten with `--force`.

## `gen`: generate artifacts from a schema

```sh
typed-settings gen --schema src/settings.ts --out .env.example --docs CONFIG.md [--prefix APP_] [--force]
```

Writes `KEY=value # type required|default: …` lines plus a markdown table (`| Env | Path | Type | Required | Default |`). Zod 3/4, Valibot, and ArkType schemas describe fully (including Zod 4 enums, whose members live in `def.entries` rather than `def.values`). Anything else produces a commented placeholder and a `GEN_BEST_EFFORT` warning on stderr: a starting point, not gospel. Check the types by hand.

Leave off `--out`/`--docs` and the artifacts print to stdout instead. Existing files are never clobbered without `--force` (`E_EXISTS`, exit 2) — and `--force` still refuses to write *through* a symlink (`E_SYMLINK`, exit 2), since a hostile or accidental link could point `out`/`docs` at something like `~/.bashrc` or an SSH key. The check runs before any write, so a guarded `docs` file never leaves a half-applied run.

## `watch`: validate and supervise

```sh
typed-settings watch -s src/settings.ts -c base.yaml --once
typed-settings watch -s src/settings.ts -c base.yaml -- node server.js
```

`--once` validates a single snapshot and exits: `0` valid, `1` invalid, `2` load error. A trailing `-- cmd` with `--once` makes no sense (there's nothing to supervise), so it's ignored with a warning rather than failing.

Without `--once`, it watches and revalidates on change: `reload: ok changed=[port]` on success, `reload: invalid, kept old` plus the error on failure, and the old config stays live either way. A child command is spawned at startup and restarted only when a reload actually changes a value — a touch that bumps mtime without changing content (`changed=[]`) revalidates but does **not** churn the supervised process. `--exit-on-error` exits `1` on the first bad reload instead. SIGINT/SIGTERM dispose cleanly with exit `0`. Takes the same `--strict`/`--no-expand`/`--array`/`--schema-export`/`--prefix` options as `check`.

## Schema resolution

Schemas load through `jiti`, so plain `.ts` files work directly. Only load schemas you trust: `jiti.import()` executes the file with full `node:` powers, so `check`/`watch` on a hostile schema file is remote code execution. Resolution order: an explicit `--schema-export NAME` first, then `schema`, `settingsSchema`, `default`, then the first export that implements `~standard` (ArkType's function schemas count). A file with two or more schema exports and no priority winner is `SCHEMA_LOAD_ERROR` — pass `--schema-export` to pick one. Anything else is `SCHEMA_LOAD_ERROR`, exit 2.

One deliberate strictness: if you pass `--schema-export` and it doesn't resolve to a schema, that's a hard error, not a cue to keep guessing. Validating the wrong schema quietly would be worse than refusing loudly.

A note for the curious: `jiti` has to run with `interopDefault: false` here. With it on, a Zod schema's `.default()` *method* gets mistaken for a nested ESM default export, and you get back a bound function instead of your schema. The loader resolves exports explicitly instead.
