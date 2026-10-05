import type { StandardSchemaV1 } from '@standard-schema/spec';

// withPrefix: scoped prefix helper. Strips `prefix` from flat input keys before
// validation, then re-nests result under the schema shape.
// M1 implementation: wraps a schema's validate to pre-strip prefixed keys from
// flat objects. Works when input is flat (env-style).

export function withPrefix<S extends StandardSchemaV1>(schema: S, prefix: string): S {
  // Empty prefix is the identity: every key trivially "matches", so stripping would
  // just lowercase the whole input — return the schema untouched instead.
  if (!prefix) return schema;
  const inner = schema as StandardSchemaV1;
  const wrapped: StandardSchemaV1 = {
    '~standard': {
      ...inner['~standard'],
      validate: (input: unknown) => {
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const rec = input as Record<string, unknown>;
          const stripped: Record<string, unknown> = {};
          const low = prefix.toLowerCase();
          for (const [k, v] of Object.entries(rec)) {
            if (k.toLowerCase().startsWith(low)) {
              const rest = k.slice(prefix.length);
              // A key that IS the prefix has no remainder — keep it verbatim and let
              // the schema decide (dropping user data silently would be worse).
              stripped[rest ? rest.toLowerCase() : k] = v;
            } else if (!(k.toLowerCase() in stripped)) {
              stripped[k] = v;
            }
          }
          return inner['~standard'].validate(stripped);
        }
        return inner['~standard'].validate(input);
      },
    },
  };
  return wrapped as S;
}

export function coerceEnv(value: unknown): unknown {
  // Re-export helper for docs; actual coercion lives in src/coerce.ts.
  return value;
}
