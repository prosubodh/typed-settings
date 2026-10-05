# Errors

Every failure is a `ConfigError` with machine-readable `issues` (`{ path, from, message }`) and a `code`. `from` names the winning source: `'env'`, the filename, the provider name, `'overrides'`, `'defaults'`, or `'schema'`.

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

| Code | Meaning | Typical fix |
|---|---|---|
| `E_INVALID_CONFIG` | validation failed (default envelope) | read `issues`, fix values/schema |
| `E_UNKNOWN_KEY` | extra keys with `unknownKeys: 'reject'` | remove keys or use `strip`/`preserve` |
| `E_UNRESOLVED` | `$VAR` has no value | set it, add `${VAR:-default}`, or `allowUnresolved: true` |
| `E_CIRCULAR` | `A=${B}`, `B=${A}` reference cycle | break the cycle |
| `E_BAD_OP` | `${A:=x}` / `${A:?x}` — only `:-` and `-` exist | use a supported operator |
| `E_PARSE` | bad file syntax (names the file) | fix the file |
| `E_PROTO` | `__proto__`/`constructor`/`prototype` key | rename the key — never silently merged |
| `E_CYCLE` | cyclic in-memory value (map, YAML anchors) | remove the cycle |
| `E_EMPTY_SEGMENT` | `A____B` double separator | fix the key |
| `E_ARRAY_MIX` | scalar/list + indexed (or indexed + named) siblings in one layer | pick one shape per layer |
| `E_SPARSE_ARRAY` | indexed gaps (`__0` + `__2`) | fill the indexes |
| `E_ARRAY_CAP` | over 1024 indexed elements | restructure the data |
| `E_NO_FS` | file source under ESM without `typed-settings/node` | import it, or use `{ text }`/`{ map }` |
| `E_FILE_TOO_LARGE` | file over `maxBytes` | raise the cap or shrink the file |
| `USE_ASYNC` | async provider/schema with sync `settings()` | use `settingsAsync()` |
| `E_TIMEOUT` | provider or async validation exceeded `timeoutMs` | raise it or fix the backend |
| `E_PROVIDER` | provider threw a plain error | see the wrapped message |
| `E_DENIED` | HTTP 401/403 from a secret backend | fix credentials; fails closed, no partial values |
| `E_NOT_FOUND` | HTTP 404 | fix the path |
| `E_THROTTLED` | HTTP 429 | back off |
| `E_UPSTREAM` | HTTP 5xx or AWS client failure | check the backend |
| `E_CONN` | connection failure | check network/URL |
| `E_PARSE` (vault) | backend returned non-JSON | check the backend |
| `E_SHAPE` | unexpected secret shape (incl. `SecretString XOR SecretBinary`) | check the secret format |
| `E_TOO_LARGE` | secret over the provider cap | raise the cap |
| `E_REDIRECT` | too many/invalid redirects | check the URL |
| `E_NO_FETCH` | no global `fetch` and no `fetchFn` | inject `fetchFn` |
| `E_NO_SDK` | AWS provider without an injected client | inject `secretsClient`/`ssmClient` |
| `SCHEMA_LOAD_ERROR` | CLI couldn't load the schema file | check path/export (`--schema-export`) |
| `E_LOAD` | CLI check hit a non-config load error | see the message |
| `E_USAGE` | bad CLI flags/values | read `--help` |
| `E_EXISTS` | `gen` refusing to overwrite without `--force` | pass `--force` |

CLI-only: `GEN_BEST_EFFORT` (non-Zod schema description is a starting point — verify types manually).

## Redaction

Secret-keyed issues (`/key|secret|token|password|private/i`) never carry the value: the raw string **and** its base64 are scrubbed from the message and replaced with `(redacted)` (short values) or `abc-*** (N chars)`. This holds for sync and async paths, nested/array paths, and for messages that echo the value (e.g. custom refinements).
