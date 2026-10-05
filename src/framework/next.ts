/**
 * Next.js App Router binding (Edge-safe: no `fs`, no static `server-only` import).
 * Load the full config on the server, hand the client only an explicit subset.
 *
 * IMPORTANT: add `import 'server-only'` at the top of YOUR server settings file
 * (not inside this library — the `server-only` package throws when evaluated
 * outside a React Server Component, which would break plain Node/vitest usage).
 *   // settings.ts (server)
 *   import 'server-only';
 *
 * @module
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { settings, settingsAsync, ConfigError, pickPublic } from '../index.js';
import type { SettingsOptions } from '../types.js';

export { settings, settingsAsync, ConfigError, pickPublic };

/** Explicit public subset - no spread, keys enumerated so secrets can't leak via `...cfg`. */
export function publicSettings<T extends object, K extends keyof T>(cfg: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  // Only copy keys actually present — a missing key yields no entry, not `{k: undefined}`.
  for (const k of keys) if (k in (cfg as object)) out[k] = cfg[k];
  return out;
}

export type { SettingsOptions, StandardSchemaV1 };
