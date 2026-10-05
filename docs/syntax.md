# Syntax

What happens *inside* a source: `.env` format, `__` keys, `$VAR` expansion, coercion, arrays, and merge strategies.

## `.env` format

POSIX-style, one `KEY=value` per line:

```sh
export APP_PORT=3000        # `export ` prefix allowed (once)
APP_URL=https://x.test      # first `=` splits; values may contain `=`
APP_EMPTY=                  # empty value -> ''
APP_HASH=a#b                # `#` inside a value is literal...
APP_TRIM=a # comment        # ...unless preceded by whitespace -> comment
APP_SINGLE='a # b'          # single quotes: literal, no expansion
APP_MULTI="line1\nline2"    # double quotes: \n \r \t escapes + real multiline
APP_DUP=1
APP_DUP=2                   # duplicate keys: last wins
BOM stripped, surrounding whitespace trimmed.
```

Rejected with `ParseError`: backtick values, unterminated quotes, bare keys (`JUSTAKEY`), empty keys (`=x`).

## Key model

After prefix stripping, flat keys expand on `__` **only** (a single `_` is literal), then lowercase:

```
APP_DB__URL        ->  db.url          (with prefix APP_)
APP_ARR__0         ->  arr[0]          (indexed, see Arrays)
single_word        ->  single_word     (untouched)
```

- Keys outside `[A-Za-z0-9_]` are ignored.
- Empty segments (`A____B`) throw `E_EMPTY_SEGMENT`.
- `__proto__` / `constructor` / `prototype` throw `E_PROTO` (case-insensitively) — prototype pollution is a hard error, never silent.
- Structured files (JSON/YAML/TOML) keep native nesting and case; only top-level keys take the global `prefix`.

## Expansion

Single pass over every string leaf, after merge. Names are `[A-Za-z_][A-Za-z0-9_]*`, longest match wins:

```sh
HOST=db.internal
URL=postgres://${HOST}/app     # -> postgres://db.internal/app
FALLBACK=${MISSING:-localhost}  # `:-` : default on unset OR empty
LOOSE=${MISSING-def}            # `-`  : default on unset only
ESCAPED=pa$$w0rd                # $$ -> literal $
LITERAL=\$NOT_A_VAR             # \$ -> literal $
CHAIN=${URL}                    # chains resolve transitively
```

- Recursive defaults: `${A:-${B:-z}}` works.
- `\}` escapes a brace inside a default.
- `:=`, `:?`, `:+` are rejected (`E_BAD_OP`); only `:-` and `-` exist.
- Unresolved names throw `E_UNRESOLVED` unless `allowUnresolved: true` (keeps the literal).
- Self/mutual references throw `E_CIRCULAR`, never hang.
- Vault values are **not** expanded unless `expandSecrets: true`.

## Coercion

Best-effort, per leaf, never throws. The schema always has the final word:

| Input | Result |
|---|---|
| `''` | `''` (stays empty) |
| `true` / `TRUE`, `yes`, `y`, `on` (any case) | `true` (`no`/`n`/`off` → `false`) |
| `null` / `NULL` | `null` |
| `3000`, `-12` | numbers (safe integers only; `9007199254740993` stays a string) |
| `1.5`, `1e3` | numbers (`0x10`, `1_0`, `NaN`, `Infinity` stay strings) |
| `{"a":1}`, `[1,2]` | parsed JSON |
| `a,b,c` | `['a','b','c']` (quote-aware; `\,` escapes; fully-quoted singles unwrap) |

Note: coercion can't see the schema, so `greeting: 'hello, world'` becomes `['hello', ' world']` and a `z.string()` target rejects it. Quote it (`greeting: '"hello, world"'`) or use a list type.

## Arrays

Dense indexed keys fold to arrays; mixing shapes in one layer is an error:

```sh
ARR__0=a
ARR__1=b     # -> arr: ['a', 'b']
```

- Gaps (`__0` + `__2`, no `__1`) → `E_SPARSE_ARRAY`. More than 1024 elements → `E_ARRAY_CAP`.
- Same layer scalar/list + indexed (`ARR=a,b` with `ARR__0=x`), or indexed + named (`ARR__0` with `ARR__FOO`) → `E_ARRAY_MIX`, in either order.
- Indexes under *different* tops don't interfere (`A__0` + `B__NAME` is fine).

Cross-layer array merge is set by `arrayStrategy`:

| Strategy | Behavior |
|---|---|
| `replace` (default) | Later layer's array wins wholesale (shrink allowed) |
| `concat` | Arrays concatenate |
| `mergeIndex` | Per-index deep union; holes → `E_SPARSE_ARRAY`; >1024 → `E_ARRAY_CAP` |

## Unknown keys

| Mode | Behavior |
|---|---|
| `strip` (default) | Drop keys the schema doesn't declare |
| `preserve` | Deep-merge undeclared input keys into the result |
| `reject` | Throw `E_UNKNOWN_KEY` listing every extra leaf path (`db.port`, `tags[1]`) |

The CLI flag for `reject` is `check --strict`.
