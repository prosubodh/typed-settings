# Frameworks & recipes

## Next.js (`typed-settings/next`)

Server side, with an explicit public subset so secrets can't leak out through a spread:

```ts
import 'server-only';
import { settings, publicSettings } from 'typed-settings/next';

const cfg = settings({ schema, sources: ['.env', 'env'], prefix: 'APP_' });
export const publicCfg = publicSettings(cfg, ['port'] as const);
```

`publicSettings` copies only the keys you list, and only if they're actually present (no `undefined` placeholders). The `server-only` import is yours to add; the package stays dependency-free on purpose.

## Vite (`typed-settings/vite`)

Hand it `import.meta.env` as a plain map. No filesystem involved:

```ts
import { viteSettings } from 'typed-settings/vite';
const cfg = viteSettings({ schema }, import.meta.env);
```

That's shorthand for `settings({ ...opts, sources: [{ map: metaEnv }], env: {} })`.

## Watch (`typed-settings/node`)

```ts
import { watchSettings } from 'typed-settings/node';

const sub = watchSettings({ schema, sources: ['config.yaml'] }, {
  debounceMs: 100,   // default; coalesces rapid saves
  pollMs: 0,         // off by default; stat-poll fallback for NFS/Docker
  refreshMs: 0,      // off by default (60s when providers or dirs are present)
  onUpdate: (cfg, changed) => console.log('reloaded', changed), // e.g. ['db.host']
  onError: (e) => console.error('kept old config:', e.message),
});

sub.get();            // current config
await sub.reload();   // re-read right now (overlapping reloads drop the stale one)
await sub.dispose();  // idempotent, safe to call twice
sub.version;          // bumps on every successful reload
```

How it behaves: parent directories are watched, so atomic renames don't lose the subscription. Files created after startup get picked up on reload. Validation runs off to the side and the old config stays live when the new one is broken. Callback throws never escape the watcher.

## Tests

```ts
import { withOverrides } from 'typed-settings';

withOverrides({ PORT: '1' }, () => settings({ schema }));
```

`process.env` is patched for the duration and restored after, across awaits and on throws. Pass `env: {}` (or your own map) to isolate from ambient variables completely.

Vault providers in tests take injected fakes (`fetchFn`, `secretsClient`, `ssmClient`). No live servers needed; see [vault.md](vault.md).

## Edge runtimes

Core (`typed-settings`) has no `node:` imports, so it bundles cleanly for Edge. Import only core or framework entries and hand data in directly:

```ts
settings({ schema, sources: [{ map: envFromPlatform }], env: {} });
// or { text: rawDotenv }
```

File sources without `typed-settings/node` under ESM throw `E_NO_FS` rather than silently skipping. That's intentional: an unread config file should be loud.

## Docker / Kubernetes secrets

```ts
import { loadSecretsDir } from 'typed-settings/node';

// /run/secrets/DB_PASSWORD becomes { DB_PASSWORD: '…' }.
// Whitespace is preserved (only one trailing newline goes),
// `..*` entries and subdirectories are skipped,
// and a missing directory reads as {}.
const cfg = settings({ schema, sources: [{ map: loadSecretsDir('/run/secrets') }, 'env'] });
```
