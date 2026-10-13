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

BOMs are stripped and surrounding whitespace trimmed. These throw `ParseError`: backtick values, unterminated quotes, bare keys (`JUSTAKEY`), empty keys (`=x`), and trailing garbage after a closing quote (`A="x" y`). Quoted values are literal groups: commas inside them don't become array splits downstream.

## Key model

Once the prefix is off, flat keys split on `__` and nothing else. A single `_` is just a character. Then everything lowercases:

```
APP_DB__URL        ->  db.url          (with prefix APP_)
APP_ARR__0         ->  arr[0]          (indexed; see Arrays below)
single_word        ->  single_word     (untouched)
```

Key charset is strict for **authored** sources: a key with a character outside `[A-Za-z0-9_]` throws `E_BAD_KEY` (bridge it with `envMap`). The ambient `'env'` layer is the deliberate exception — `process.env` carries unrelated OS variables (`ProgramFiles(x86)`, `PROCESSOR_ARCHITEW6432`, …), so off-charset names there are **skipped**, never fatal. Only exact `__proto__` (case-insensitive) throws `E_PROTO`; `constructor` and `prototype` are inert own-data properties and flow through as ordinary keys. Mis-shaped `__` separators (`A____B`, Next.js's `__NEXT_DATA__`) never split and are kept as literal top-level keys — no error, no dropped data.

Structured files (JSON/YAML/TOML) don't go through any of this: their nesting is native and their case is preserved. Only their top-level keys take the global `prefix`, and a non-matching one is dropped, not kept.

## Expansion

One pass over every string leaf, after merging. Names are `[A-Za-z_][A-Za-z0-9_]*` and the longest match wins, so `$VAR_SUFFIX` doesn't get misread as `$VAR` plus junk:

```sh
HOST=db.internal
URL=postgres://${HOST}/app     # -> postgres://db.internal/app
FALLBACK=${MISSING:-localhost}  # `:-` fills in when unset OR empty
LOOSE=${MISSING-def}            # `-` fills in when unset only
ESCAPED=pa$$w0rd                # $$ -> a literal $ (backslash not involved)
LITERAL=\$NOT_A_VAR             # \$ keeps BOTH characters (Windows C:\$RECYCLE)
CHAIN=${URL}                    # chains resolve transitively
```

Defaults can nest (`${A:-${B:-z}}`), and `\}` escapes a brace inside one. The `:=`, `:?`, and `:+` operators don't exist here; reaching for them gives `E_BAD_OP`. A name with no value and no default throws `E_UNRESOLVED`, unless `allowUnresolved: true` keeps the literal text. A `${FOO` with no closing brace at all throws `E_EXPAND` (fail loud, don't hide the typo) — a document that won't *parse* is the separate `E_PARSE`; shapes that *do* close — `${}`, `${A x}` — stay literal. Defaults nested past the lexical cap (50) throw `E_DEPTH`. Variables referencing each other in a circle throw `E_CIRCULAR` instead of hanging.

Vault values skip expansion by default. Passwords and connection strings are full of `$` characters that mean nothing, so you have to ask for it with `expandSecrets: true`. Granularity is top-level: if any vault layer provides a top (e.g. `db`), that whole top skips expansion — including a plain-map sibling under the same top. Mix expandable and vault values under distinct tops.

One robustness rule: values from the ambient `'env'` layer never throw at expansion time. A process.env value with an unresolved reference (`${P}`), a bash-style `${A:=x}`, or a self-reference passes through untouched. Strict errors (`E_UNRESOLVED`, `E_CIRCULAR`, `E_BAD_OP`, `E_EXPAND`, `E_DEPTH`) apply only to values from files, `{ text }`, `{ map }`, structured files, and providers.

## Coercion

Best effort, per leaf, and it never throws. If nothing matches, the string passes through untouched and your schema gets the final say:

| Input | Comes out as |
|---|---|
| `''` | `''` (empty stays empty) |
| `true`, `false` (any case) | `true` / `false`. `yes`/`y`/`on`/`no`/`n`/`off` stay strings — they corrupt real data (country codes, prose) too often to guess |
| `null`, `NULL` | `null` |
| `3000`, `-12` | numbers (safe integers only, so `9007199254740993` stays a string) |
| `1.5`, `1e3` | numbers (`0x10`, `1_0`, `NaN`, `Infinity` stay strings) |
| `{"a":1}`, `[1,2]` | parsed JSON |
| `a,b,c` | `['a','b','c']`, split on bare commas only (`\,` escapes one; quoted commas are protected by the parser) |

One consequence worth knowing: coercion can't see your schema, so an unquoted `greeting: 'hello, world'` becomes `['hello', ' world']` and a `z.string()` target rejects it. In a `.env` file, quote it (`GREETING="hello, world"`) — the parser pre-escapes quoted commas so it stays one string. (Values handed in directly as `{ map: {...} }` bypass the parser; escape the comma yourself as `hello\\, world`.) Otherwise, type the field as a list.

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
