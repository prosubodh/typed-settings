# Vault providers

Three secret backends behind one small interface: `{ name, load() }`, where `load()` returns a flat map (or a promise of one). They all share the same posture: manual redirects (max 2, auth stripped when crossing hosts), a 5-second default timeout, roughly a megabyte of default body cap, single-flight `load()`, and errors that fail closed. For tests you inject `fetchFn` / `secretsClient` / `ssmClient` fakes, so no live servers are ever needed.

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
  mount: 'secret',        // default; slashes trimmed
  path: 'app/prod',      // KVv2 reads data/app/prod; KVv1 reads app/prod
  auth: { token: '…' },  // default: process.env.VAULT_TOKEN
  version: 3,            // optional KVv2 ?version= pin
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  fetchFn,               // inject in tests
});
```

Auth has one sharp edge, deliberately: an explicit `token: ''` means *no credential* and does not fall back to `VAULT_TOKEN`. Otherwise the env var is used, sent as `X-Vault-Token`.

Unwrapping is conservative. KVv2 envelopes (`data.data` sitting next to a `metadata` sibling) unwrap to the inner secret. But a KVv1 secret that merely happens to contain a key called `data` is left alone. The `metadata` sibling is what distinguishes the two. A `403` fails closed with `E_DENIED` and no value; you never get a half-merged secret.

## Generic HTTP (`typed-settings/vault-http`)

```ts
httpProvider({
  url: 'https://secrets.internal/app',
  headers: { Authorization: process.env.SECRETS_TOKEN }, // from env, never from CLI args
  jsonPath: 'data',   // dot path into the body; '' reads the whole body
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  fetchFn,
});
```

Same KV-style unwrap discipline as HashiCorp, same guards. Error bodies never end up in messages.

## AWS (`typed-settings/vault-aws`)

```ts
awsProvider({
  secrets: ['prod/app'],       // Secrets Manager ids
  params: ['/app/prod/'],      // SSM names or path prefixes
  timeoutMs: 5000,
  secretsClient,               // bring your @aws-sdk/client-secrets-manager client (or a fake)
  ssmClient,                   // bring your @aws-sdk/client-ssm client (or a fake)
  maxBytesSecret: 64 * 1024,   // SM cap
  maxBytesParam: 8 * 1024,     // SSM cap
});
```

The SDKs are peers, not dependencies. Call `load()` without an injected client and you get `E_NO_SDK` telling you which package it expected. The SDK is never imported blindly.

- **Secrets Manager.** A `SecretString` holding a JSON object merges into the map. Anything else becomes a single value keyed by the last path segment, uppercased (`prod/app` → `APP`). Both `SecretString` and `SecretBinary` present, or neither, is `E_SHAPE`. A string `SecretBinary` has to be valid base64; anything else would decode silently into garbage, so it's rejected.
- **SSM.** Called with `WithDecryption: true`. Parameters strip to the longest requested prefix (`/app/prod/a/b` under `/app/prod` becomes `A__B`), uppercased, with one trailing newline trimmed. A trailing slash on the request isn't required. Names that match nothing fall back to their basename; names that map to nothing are skipped rather than emitted as empty keys.
- Client throws, sync or async, become `E_UPSTREAM`. Timeouts become `E_TIMEOUT`.

## Shared guards

- Redirects are followed by hand (max 2). Crossing hosts strips *all* auth material (`authorization`, anything with `token`/`secret`/`api-key`, cookies), not just Vault's own headers. Running out of budget, or a `Location` that isn't a URL, is `E_REDIRECT`.
- Status codes map to typed errors: `401`/`403` → `E_DENIED`, `404` → `E_NOT_FOUND`, `429` → `E_THROTTLED`, 5xx → `E_UPSTREAM`, anything else → `E_PROVIDER`. Timeouts and aborts are `E_TIMEOUT`, connection failures `E_CONN`, non-JSON bodies `E_PARSE`.
- `normalizeSecretMap` rejects non-object payloads (`E_SHAPE`), skips `null`/`undefined`, keeps nested objects for `__` expansion, and trims one trailing newline.

## Testing with providers

```ts
const prov = hashicorpProvider({
  url: 'https://vault.test', path: 'p',
  fetchFn: async () => new Response(JSON.stringify({ data: { PORT: '1' }, metadata: {} })),
});
const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {} });
```
