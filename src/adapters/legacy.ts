import type { StandardSchemaV1 } from '@standard-schema/spec';

// Legacy bridges: normalize Yup / Joi / Superstruct schemas to Standard Schema.
// Each is ~30 lines, optional entry, peerDep on the lib.
// NOTE: yup/joi/superstruct are intentionally NOT peerDependencies: the bridges
// duck-type `validateSync`/`validate`/`create` and never import the libs, so any
// version exposing those methods works. Install whichever you use.

type AnySchema = { validateSync?: (v: unknown, o?: unknown) => unknown; validate?: (...a: never[]) => unknown };

/**
 * Adapts a Yup schema via `validateSync` (`stripUnknown`, all errors).
 * `inner[]` failures map to issues; anything else becomes a root issue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function yupAdapter(schema: any): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'typed-settings.yup',
      validate: (input: unknown) => {
        try {
          const value = schema.validateSync(input, { stripUnknown: true, abortEarly: false });
          return { value };
        } catch (e) {
          const err = e as { inner?: { path?: string; message?: string }[]; message?: string };
          const issues = (err.inner?.length ? err.inner : [{ path: '<root>', message: err.message ?? String(e) }]).map(
            (i) => ({ message: String(i.message ?? String(e)), path: i.path ? [i.path] : undefined }),
          );
          return { issues };
        }
      },
    },
  } as StandardSchemaV1;
}

/**
 * Adapts a Joi schema (`validate` with convert + stripUnknown). `details[]`
 * map to issues; a throwing `validate()` or empty details still yields a
 * non-empty issues array, as Standard Schema requires. Sync only: an async
 * `validate()` returning a promise is reported as failure, never validated.
 */
export function joiAdapter(schema: AnySchema & { validate?: (v: unknown, o?: unknown) => { error?: { message?: string; details?: { path: (string|number)[]; message: string }[] }; value: unknown } }): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'typed-settings.joi',
      validate: (input: unknown) => {
        let res: { error?: { message?: string; details?: { path: (string | number)[]; message: string }[] }; value: unknown };
        try {
          res = schema.validate!(input, { abortEarly: false, convert: true, allowUnknown: true, stripUnknown: true });
        } catch (e) {
          // A throwing validate() must surface as issues, never leak raw.
          const err = e as Error;
          return { issues: [{ message: err?.message ?? String(e) }] };
        }
        // An async validate() hands back a promise, not a result — calling it
        // valid would freeze a Promise into the config. Fail loudly instead.
        if (res && typeof (res as { then?: unknown }).then === 'function') {
          return { issues: [{ message: 'USE_ASYNC: Joi schema is async, which legacy bridges do not support' }] };
        }
        if (!res.error) return { value: res.value };
        const issues = (res.error.details ?? []).map((d) => ({ message: d.message, path: d.path.map(String) }));
        // Standard Schema requires a non-empty issues array on failure.
        if (issues.length === 0) return { issues: [{ message: res.error.message ?? 'Invalid input' }] };
        return { issues };
      },
    },
  } as StandardSchemaV1;
}

/**
 * Adapts a Superstruct struct via `create()`. `failures()` map to issues;
 * anything else falls back to the thrown message.
 */
export function superstructAdapter(schema: AnySchema & { create?: (v: unknown) => unknown }): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'typed-settings.superstruct',
      validate: (input: unknown) => {
        let value: unknown;
        try {
          value = schema.create!(input);
          return { value };
        } catch (e) {
          const err = e as { failures?: () => { path: (string|number)[]; message: string }[]; message?: string };
          let issues: { message: string; path?: string[] }[] | undefined;
          try {
            if (typeof err.failures === 'function') {
              const found = err.failures().map((f) => ({ message: f.message, path: f.path.map(String) }));
              if (found.length > 0) issues = found;
            }
          } catch {
            // A throwing failures() reporter must not escape validate().
          }
          if (issues) return { issues };
          return { issues: [{ message: err?.message ?? String(e) }] };
        }
      },
    },
  } as StandardSchemaV1;
}
