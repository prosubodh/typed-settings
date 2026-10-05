// Vite binding (Edge-safe, no `fs`).
// Usage in app code (NOT here — keeps this entry CJS-safe):
//   import { viteSettings } from 'typed-settings/vite';
//   export const cfg = viteSettings({ schema }, import.meta.env);
//
// Rules: never spread `import.meta.env` (forbid `...import.meta.env` —
// it drags server secrets into the client bundle). Pass it as a map;
// file preloading belongs in `vite.config.ts` via `loadEnvFiles()` passed as `{ text }`.
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { settings, settingsAsync, ConfigError, pickPublic } from '../index.js';
import type { Flat, SettingsOptions } from '../types.js';

export { settings, settingsAsync, ConfigError, pickPublic };

/** Validate `import.meta.env` (passed explicitly by the caller) against a schema. */
export function viteSettings<S extends StandardSchemaV1>(
  opts: Omit<SettingsOptions<S>, 'sources' | 'env'>,
  metaEnv: Flat,
): StandardSchemaV1.InferOutput<S> {
  return settings({ ...opts, sources: [{ map: metaEnv }], env: {} } as SettingsOptions<S>);
}

export type { Flat, SettingsOptions, StandardSchemaV1 };
