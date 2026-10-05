# Frameworks & recipes

## Next.js (`typed-settings/next`)

Server-only, explicit public subset — secrets can't leak via `...cfg`:

```ts
import 'server-only';
import { settings, publicSettings } from 'typed-settings/next';

const cfg = settings({ schema, sources: ['.env', 'env'], prefix: 'APP_' });
export const publicCfg = publicSettings(cfg, ['port'] as const);
```

`publicSettings` copies only listed, actually-present keys. (The `server-only` import is yours to add — the package stays dependency-free.)

## Vite (`typed-settings/vite`)

`import.meta.env` as a plain map; no filesystem, no spread:

```ts
import { viteSettings } from 'typed-settings/vite';

const cfg = viteSettings({ schema }, import.meta.env);
```

Equivalent to `settings({ ...opts, sources: [{ map: metaEnv }], env: {} })`.

## Watch (`typed-settings/node`)

```ts
import { watchSettings } from 'typed-settings/node';

const sub = watchSettings({ schema, sources: ['config.yaml'] }, {
  debounceMs: 100,   // default; coalesces rapid saves
  pollMs: 0,         // default off; stat-poll fallback for NFS/Docker
  refreshMs: 0,      // default off (60s when providers/dirs present)
  onUpdate: (cfg, changed) => console.log('reloaded', changed), // e.g. ['db.host']
  onError: (e) => console.error('kept old config:', e.message),
});

sub.get();            // current config
await sub.reload();   // re-read now (generation counter drops stale overlaps)
await sub.dispose();  // idempotent; safe to call twice
sub.version;          // increments per successful reload
```

Semantics: parent-directory watching survives atomic renames; files created after startup are picked up on reload; validation runs off-side and the old config stays live on errors; overlapping reloads drop the stale one; throwing callbacks never escape the watcher.

## Tests

```ts
import { withOverrides } from 'typed-settings';

withOverrides({ PORT: '1' }, () => settings({ schema }));
// process.env restored after — even across awaits and throws.
// Pass `env: {}` / `env: {...}` to isolate from ambient variables entirely.
```

Vault providers in tests: inject `fetchFn`, `secretsClient`, or `ssmClient` fakes — no live servers needed (see [vault.md](vault.md)).

## Edge runtimes

Core (`typed-settings`) has no `node:` imports. On Edge, import only core/framework entries and pass data directly:

```ts
settings({ schema, sources: [{ map: envFromPlatform }], env: {} });
// or { text: rawDotenv }
```

File sources without `typed-settings/node` under ESM throw `E_NO_FS` rather than silently skipping.

## Docker / Kubernetes secrets

```ts
import { loadSecretsDir } from 'typed-settings/node';

// /run/secrets/DB_PASSWORD -> { DB_PASSWORD: '…' } (whitespace preserved,
// one trailing newline stripped, `..*` entries and subdirs skipped)
const cfg = settings({ schema, sources: [{ map: loadSecretsDir('/run/secrets') }, 'env'] });
```
