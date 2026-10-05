# Vault providers

Three secret providers behind one interface — `{ name, load() }` returning a flat map. All network providers share: manual redirects (max 2, auth stripped cross-host), `5000ms` default timeout (`E_TIMEOUT`), ~1 MiB default body cap (`E_TOO_LARGE`), single-flight `load()`, and fail-closed errors. No live servers are needed for tests: inject `fetchFn` / `secretsClient` / `ssmClient`.

```ts
import { settingsAsync } from 'typed-settings';
import { hashicorpProvider } from 'typed-settings/vault-hashicorp';

const cfg = await settingsAsync({
  schema,
  sources: [{ provider: hashicorpProvider({ url: 'https://vault:8200', path: 'app/prod' }) }, 'env'],
});
```

## HashiCorp Vault (`typed-settings/vault-hashicorp`)

```ts
hashicorpProvider({
  url: 'https://vault:8200',
  mount: 'secret',        // default; leading/trailing slashes trimmed
  path: 'app/prod',      // KVv2: 'data/app/prod'; KVv1: 'app/prod'
  auth: { token: '…' },  // default: process.env.VAULT_TOKEN
  version: 3,            // optional KVv2 ?version= pin
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  fetchFn,               // inject for tests
});
```

- Auth: explicit `token: ''` means **no credential** (no env fallback); otherwise `VAULT_TOKEN` is used. Sent as `X-Vault-Token`.
- Unwrap: KVv2 envelopes (`data.data` **with** a `metadata` sibling) unwrap to the inner secret. A KVv1 secret that merely *contains* a key named `data` does **not** unwrap.
- `403` fails closed with `E_DENIED` and no value — never a partial merge.

## Generic HTTP (`typed-settings/vault-http`)

```ts
httpProvider({
  url: 'https://secrets.internal/app',
  headers: { Authorization: process.env.SECRETS_TOKEN }, // never CLI args for secrets
  jsonPath: 'data',   // dot path into the body; '' reads the whole body
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  fetchFn,
});
```

Same KV-style `data`/`metadata` unwrap discipline as HashiCorp. Error bodies never leak into messages.

## AWS (`typed-settings/vault-aws`)

```ts
awsProvider({
  secrets: ['prod/app'],       // Secrets Manager ids
  params: ['/app/prod/'],      // SSM names or path prefixes
  timeoutMs: 5000,
  secretsClient,               // inject @aws-sdk/client-secrets-manager (or a fake)
  ssmClient,                   // inject @aws-sdk/client-ssm (or a fake)
  maxBytesSecret: 64 * 1024,   // SM cap
  maxBytesParam: 8 * 1024,     // SSM cap
});
```

Without injected clients, `load()` throws `E_NO_SDK` naming the expected peer package — the SDKs are never imported blindly.

- **Secrets Manager**: `SecretString` holding a JSON object merges; anything else becomes one value keyed by the last path segment, uppercased (`prod/app` → `APP`). `SecretString` + `SecretBinary` together, or neither, is `E_SHAPE`. String `SecretBinary` must be valid base64.
- **SSM**: called with `WithDecryption: true`. Parameters are stripped to the longest requested prefix (`/app/prod/a/b` under `/app/prod` → `A__B`), uppercased, one trailing newline trimmed. Parameters outside every requested prefix fall back to their basename.
- Client throws (sync or async) map to `E_UPSTREAM`; timeouts to `E_TIMEOUT`.

## Shared guards

- Redirects are followed manually (max 2). On cross-host redirect, **all** auth material is stripped (`authorization`, `*token*`, `*secret*`, `*api-key*`, `cookie`, `*auth*`) — not just Vault's headers. Exhaustion or a non-URL `Location` is `E_REDIRECT`.
- Status mapping: `401`/`403` → `E_DENIED`, `404` → `E_NOT_FOUND`, `429` → `E_THROTTLED`, `≥500` → `E_UPSTREAM`, anything else → `E_PROVIDER`. Timeouts/aborts → `E_TIMEOUT`, connection failures → `E_CONN`, bad JSON → `E_PARSE`.
- `normalizeSecretMap` rejects non-object payloads (`E_SHAPE`), skips `null`/`undefined`, preserves nested objects for `__` expansion, and trims one trailing newline.

## Testing with providers

```ts
const prov = hashicorpProvider({
  url: 'https://vault.test', path: 'p',
  fetchFn: async () => new Response(JSON.stringify({ data: { PORT: '1' }, metadata: {} })),
});
const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {} });
```
