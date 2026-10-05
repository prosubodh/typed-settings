# CLI

The `typed-settings` binary validates, scaffolds, generates, and supervises config. Exit codes are part of the contract so CI can rely on them.

## `check` — validate a config

```sh
typed-settings check -s src/settings.ts -c base.yaml,.env [--strict] [--no-expand] \
  [--array replace|concat|mergeIndex] [--format human|json] [--schema-export NAME] [--prefix APP_]
```

| Flag | Default | Meaning |
|---|---|---|
| `-s, --schema` | — (required) | schema file to load |
| `-c, --config` | `.env,env` | comma-separated sources, same spellings as `sources` |
| `--strict` | `false` | `unknownKeys: 'reject'` (exit 1 on extras) |
| `--no-expand` | expand on | skip `$VAR` expansion |
| `--array` | `replace` | cross-layer array strategy |
| `--format` | `human` | `json` prints `{ok, config}` / `{ok:false, issues\|error}` |
| `--schema-export` | auto | which export holds the schema (must be a Standard Schema; typos fail loudly) |
| `--prefix` | — | global prefix strip |

Exit codes: `0` valid · `1` invalid config · `2` schema-load failure or bad flags.

## `init` — scaffold a project

```sh
typed-settings init --lib zod --format env [--dir .] [--force|--dry-run|--check]
```

- `--lib zod|valibot|arktype|yup|joi` (default `zod`), `--format env|yaml|toml` (default `env`).
- Writes `src/settings.ts` + `.env.example` (or `config.yaml` / `config.toml`) with mode `0600`.
- `--dry-run` / `--check` print `create|exists|overwrite` per file without writing; `--check` exits `2` on drift. Existing files are only overwritten with `--force`.

## `gen` — generate docs from a schema

```sh
typed-settings gen --schema src/settings.ts --out .env.example --docs CONFIG.md [--prefix APP_] [--force]
```

- Emits `KEY=value # type required|default: …` lines plus a `| Env | Path | Type | Required | Default |` markdown table.
- Zod 3/4, Valibot, and ArkType schemas describe fully (including `def.entries`-style Zod 4 enums). Anything else emits a commented placeholder and a `GEN_BEST_EFFORT` warning on stderr — verify manually.
- Without `--out`/`--docs`, artifacts print to stdout. Existing files need `--force` (`E_EXISTS`, exit 2).

## `watch` — validate and supervise

```sh
typed-settings watch -s src/settings.ts -c base.yaml --once
typed-settings watch -s src/settings.ts -c base.yaml -- node server.js
```

- `--once`: single validation, no hanging. Prints `OK: config valid`; exits `0` valid, `1` invalid, `2` load error. A trailing `-- cmd` is ignored with a warning.
- Long-run: revalidates on file change (`reload: ok changed=[port]`), keeps the old config on errors, restarts the child on success. `--exit-on-error` exits `1` on the first invalid reload. SIGINT/SIGTERM dispose cleanly (exit `0`).
- Same `--strict/--no-expand/--array/--schema-export/--prefix` options as `check`.

## Schema resolution

Schemas load via `jiti` (so `.ts` files work directly). Resolution order: `--schema-export NAME` → `schema` → `settingsSchema` → `default` → first export implementing `~standard` (ArkType function schemas included). A missing or non-schema export is `SCHEMA_LOAD_ERROR` (exit 2), with one deliberate strictness: an explicit `--schema-export` that doesn't resolve to a schema fails instead of falling back — silently validating the wrong schema would be worse.
