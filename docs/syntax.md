# Syntax

What happens *inside* a source: the `.env` grammar, `__` keys, `$VAR` expansion, coercion, arrays, and merge strategies.

## `.env` format

POSIX-style, one `KEY=value` per line:

```sh
export APP_PORT=3000        # an `export ` prefix is allowed (once)
APP_URL=https://x.test      # split on the first `=`; values can contain `=`
APP_EMPTY=                  # empty value means ''
APP_HASH=a#b                # `#` inside a value is literal...
APP_TRIM=a # comment        # ...unless whitespace comes before it, then it's a comment
APP_SINGLE='a # b'          # single quotes: completely literal
APP_MULTI="line1\nline2"    # double quotes: \n \r \t escapes, and real multiline values
APP_DUP=1
APP_DUP=2                   # duplicates: last one wins
```

BOMs are stripped and surrounding whitespace trimmed. These throw `ParseError`: backtick values, unterminated quotes, bare keys (`JUSTAKEY`), empty keys (`=x`).

## Key model

Once the prefix is off, flat keys split on `__` and nothing else. A single `_` is just a character. Then everything lowercases:

```
APP_DB__URL        ->  db.url          (with prefix APP_)
APP_ARR__0         ->  arr[0]          (indexed; see Arrays below)
single_word        ->  single_word     (untouched)
```

Keys with characters outside `[A-Za-z0-9_]` are ignored. Empty segments (`A____B`) throw `E_EMPTY_SEGMENT`. And `__proto__` / `constructor` / `prototype` throw `E_PROTO`, matched case-insensitively. Prototype pollution is a hard error here, never something that slips through quietly.

Structured files (JSON/YAML/TOML) don't go through any of this: their nesting is native and their case is preserved. Only their top-level keys take the global `prefix`, and a non-matching one is dropped, not kept.

## Expansion

One pass over every string leaf, after merging. Names are `[A-Za-z_][A-Za-z0-9_]*` and the longest match wins, so `$VAR_SUFFIX` doesn't get misread as `$VAR` plus junk:

```sh
HOST=db.internal
URL=postgres://${HOST}/app     # -> postgres://db.internal/app
FALLBACK=${MISSING:-localhost}  # `:-` fills in when unset OR empty
LOOSE=${MISSING-def}            # `-` fills in when unset only
ESCAPED=pa$$w0rd                # $$ is a literal $
LITERAL=\$NOT_A_VAR             # so is \$
CHAIN=${URL}                    # chains resolve transitively
```

Defaults can nest (`${A:-${B:-z}}`), and `\}` escapes a brace inside one. The `:=`, `:?`, and `:+` operators don't exist here; reaching for them gives `E_BAD_OP`. A name with no value and no default throws `E_UNRESOLVED`, unless `allowUnresolved: true` keeps the literal text. Variables referencing each other in a circle throw `E_CIRCULAR` instead of hanging.

Vault values skip expansion by default. Passwords and connection strings are full of `$` characters that mean nothing, so you have to ask for it with `expandSecrets: true`.

One robustness rule: values from the ambient `'env'` layer never throw at expansion time. A process.env value with an unresolved reference (`${P}`), a bash-style `${A:=x}`, or a self-reference passes through untouched. Strict errors (`E_UNRESOLVED`, `E_CIRCULAR`, `E_BAD_OP`) apply only to values from files, `{ text }`, `{ map }`, structured files, and providers.

## Coercion

Best effort, per leaf, and it never throws. If nothing matches, the string passes through untouched and your schema gets the final say:

| Input | Comes out as |
|---|---|
| `''` | `''` (empty stays empty) |
| `true`, `TRUE`, `yes`, `y`, `on` (any case) | `true` (`no`/`n`/`off` go to `false`) |
| `null`, `NULL` | `null` |
| `3000`, `-12` | numbers (safe integers only, so `9007199254740993` stays a string) |
| `1.5`, `1e3` | numbers (`0x10`, `1_0`, `NaN`, `Infinity` stay strings) |
| `{"a":1}`, `[1,2]` | parsed JSON |
| `a,b,c` | `['a','b','c']`, split quote-aware (`\,` escapes a comma) |

One consequence worth knowing: coercion can't see your schema, so `greeting: 'hello, world'` becomes `['hello', ' world']` and a `z.string()` target rejects it. Quote the value (`'"hello, world"'`) or type the field as a list.

## Arrays

Densely numbered keys fold into arrays. Mixing shapes in one layer is an error, in either order:

```sh
ARR__0=a
ARR__1=b     # arr is ['a', 'b']
```

Gaps (`__0` plus `__2` with no `__1`) throw `E_SPARSE_ARRAY`. More than 1024 elements throws `E_ARRAY_CAP`. A scalar or list next to indexed keys in the same layer (`ARR=a,b` alongside `ARR__0=x`), or indexed keys next to named ones (`ARR__0` alongside `ARR__FOO`), throws `E_ARRAY_MIX`. Indexes under *different* tops don't interact, so `A__0` plus `B__NAME` is fine.

How arrays merge *across* layers is `arrayStrategy`:

| Strategy | Behavior |
|---|---|
| `replace` (default) | The later array wins wholesale, which is also how you shrink one |
| `concat` | The arrays concatenate |
| `mergeIndex` | Per-index deep union, later source wins at each index and the longer tail survives (`[1,2]` + `[3]` becomes `[3,2]`); holes throw `E_SPARSE_ARRAY`, past 1024 throws `E_ARRAY_CAP` |

## Unknown keys

| Mode | Behavior |
|---|---|
| `strip` (default) | Keys the schema doesn't declare are dropped |
| `preserve` | Undeclared input keys are deep-merged into the result |
| `reject` | Throws `E_UNKNOWN_KEY` with every extra leaf path (`db.port`, `tags[1]`) |

On the CLI, `check --strict` means `reject`.
