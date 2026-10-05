import { resolve } from 'node:path';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export async function loadSchema(schemaPath: string, exportName?: string): Promise<StandardSchemaV1> {
  const abs = resolve(schemaPath);
  let mod: Record<string, unknown>;
  try {
    const { createJiti } = await import('jiti');
    // NOTE: interopDefault must stay FALSE. With TRUE, jiti's ESM proxy resolves
    // `mod.default` to `schema.default` (Zod schemas expose a `.default()` method,
    // which jiti mistakes for a nested ESM default) — yielding a bound method
    // instead of the schema. We resolve exports explicitly below instead.
    const jiti = createJiti(import.meta.url, { interopDefault: false, fsCache: false, moduleCache: false });
    mod = (await jiti.import(abs)) as Record<string, unknown>;
  } catch (e) {
    const err = e as Error;
    const wrapped = new Error(`SCHEMA_LOAD_ERROR: ${abs}: ${err.message}`);
    (wrapped as { code?: string }).code = 'SCHEMA_LOAD_ERROR';
    throw wrapped;
  }
  const pick = (name: string): unknown => (mod as Record<string, unknown>)[name];
  const isStandard = (v: unknown): v is StandardSchemaV1 => {
    if (!v) return false;
    // Note: ArkType Types are functions; Zod/Valibot schemas are objects.
    if (typeof v !== 'object' && typeof v !== 'function') return false;
    return '~standard' in (v as object);
  };
  // Prefer explicit export flag, then named schema exports — each must implement ~standard.
  // ('default' checked last: jiti interopDefault can synthesize a default that isn't the schema.)
  if (exportName) {
    // An explicit --schema-export that does not resolve to a schema is a usage
    // error, not a fallback opportunity — silently validating the wrong schema
    // would be worse than failing loudly.
    const picked = pick(exportName);
    if (!isStandard(picked)) {
      const err = new Error(
        `SCHEMA_LOAD_ERROR: --schema-export ${JSON.stringify(exportName)} did not resolve to a Standard Schema in ${abs}`,
      );
      (err as { code?: string }).code = 'SCHEMA_LOAD_ERROR';
      throw err;
    }
    return picked;
  }
  for (const cand of ['schema', 'settingsSchema', 'default']) {
    if (isStandard(pick(cand))) return pick(cand) as StandardSchemaV1;
  }
  // NOTE: no `isStandard(mod)` fallthrough — jiti always returns a module
  // namespace object (CJS `module.exports = schema` surfaces under
  // `default`/`module.exports` keys), so the module itself is never a schema.
  const first = Object.values(mod).find((v) => isStandard(v));
  if (first) return first as StandardSchemaV1;
  const err = new Error(`SCHEMA_LOAD_ERROR: no Standard Schema export in ${abs} (tried default/schema/settingsSchema)`);
  (err as { code?: string }).code = 'SCHEMA_LOAD_ERROR';
  throw err;
}
