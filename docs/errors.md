# Errors

Everything fails the same way: a `ConfigError` carrying machine-readable `issues`, each with a `path`, a `from`, and a `message`. `from` tells you which layer won for that key: `'env'`, a filename, a provider name, `'overrides'`, or `'defaults'`/`'schema'` when no source provided it.

```
Invalid config (2 issues):
- port (from c.json): Invalid input: expected number, received NaN
- db.url (from env): E_UNRESOLVED: DB_URL missing (expand)
```

```ts
import { ConfigError } from 'typed-settings';
try {
  settings({ schema, sources: ['c.json'] });
} catch (e) {
  if (e instanceof ConfigError) {
    console.log(e.code);    // 'E_INVALID_CONFIG'
    console.log(e.issues);  // [{ path, from, message }]
  }
}
```

## Codes

| Code | What happened | What to do |
|---|---|---|
| `E_INVALID_CONFIG` | validation failed (the default envelope) | read `issues`, fix values or schema |
| `E_UNKNOWN_KEY` | extra keys with `unknownKeys: 'reject'` | remove the keys, or use `strip`/`preserve` |
| `E_UNRESOLVED` | a `$VAR` points at nothing | set it, add `${VAR:-default}`, or pass `allowUnresolved: true` |
| `E_CIRCULAR` | variables reference each other (`A=${B}`, `B=${A}`) | unwind the cycle |
| `E_BAD_OP` | `${A:=x}` / `${A:?x}` (only `:-` and `-` exist) | use a supported operator |
| `E_PARSE` | broken file syntax, filename attached | fix the file |
| `E_PROTO` | a `__proto__`/`constructor`/`prototype` key showed up | rename it. These are never merged quietly |
| `E_CYCLE` | a cyclic value in memory (a map, or YAML anchors) | remove the cycle |
| `E_EMPTY_SEGMENT` | `A____B` double separator | fix the key |
| `E_ARRAY_MIX` | scalar/list next to indexed keys (or indexed next to named) in one layer | pick one shape per layer |
| `E_SPARSE_ARRAY` | indexed gaps (`__0` plus `__2`, no `__1`) | fill in the indexes |
| `E_ARRAY_CAP` | over 1024 indexed elements | restructure the data |
| `E_NO_FS` | a file source under ESM without `typed-settings/node` | import it, or use `{ text }`/`{ map }` |
| `E_FILE_TOO_LARGE` | a file over `maxBytes` | raise the cap or shrink the file |
| `USE_ASYNC` | async provider or schema met sync `settings()` | switch to `settingsAsync()`. Branch on `error.code`, never on the message text |
| `E_TIMEOUT` | a provider or async validation outran `timeoutMs` | raise it, or fix the backend |
| `E_PROVIDER` | a provider threw a plain error | read the wrapped message |
| `E_DENIED` | HTTP 401/403 from a secret backend | fix credentials. Fails closed; no partial values |
| `E_NOT_FOUND` | HTTP 404 | fix the path |
| `E_THROTTLED` | HTTP 429 | back off |
| `E_UPSTREAM` | HTTP 5xx or an AWS client failure | check the backend |
| `E_CONN` | connection failure | check network and URL |
| `E_PARSE` (vault) | backend returned non-JSON | check the backend |
| `E_SHAPE` | unexpected secret shape (including `SecretString XOR SecretBinary` violations) | check the secret's format |
| `E_TOO_LARGE` | a secret over the provider's cap | raise the cap |
| `E_REDIRECT` | too many redirects, or a `Location` that isn't a URL | check the URL |
| `E_NO_FETCH` | no global `fetch` and no injected `fetchFn` | inject `fetchFn` |
| `E_NO_SDK` | AWS provider without an injected client | inject `secretsClient`/`ssmClient` |
| `SCHEMA_LOAD_ERROR` | the CLI couldn't load the schema file | check the path and export (`--schema-export`) |
| `E_LOAD` | `check` hit a non-config load error | read the message |
| `E_USAGE` | bad CLI flags or values | read `--help` |
| `E_EXISTS` | `gen` refusing to overwrite without `--force` | pass `--force` |

CLI-only: `GEN_BEST_EFFORT` means a non-Zod schema was described on a best-effort basis. Treat the output as a draft.

## Redaction

Issues on secret-looking keys (`key`, `secret`, `token`, `password`, `private`, any case) never carry the value. Both the raw string and its base64 get scrubbed from the message and replaced with `(redacted)` (short values collapse entirely; longer ones show a `abc-*** (N chars)` shape). This holds on sync and async paths, down nested and array paths, and even when the message echoes the value back (like a custom refinement saying what it received).
