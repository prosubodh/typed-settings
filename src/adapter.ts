import type { StandardSchemaV1 } from '@standard-schema/spec';

export interface NormalizedResult {
  ok: boolean;
  value?: unknown;
  issues?: { path: string; message: string }[];
}

function normalizePath(path: StandardSchemaV1.PathSegment[] | readonly unknown[] | undefined): string {
  if (!path || path.length === 0) return '<root>';
  const parts: string[] = [];
  for (const seg of path as Array<PropertyKey | { key: PropertyKey }>) {
    if (seg !== null && typeof seg === 'object' && 'key' in (seg as object)) {
      parts.push(String((seg as { key: PropertyKey }).key));
    } else {
      parts.push(String(seg as PropertyKey));
    }
  }
  return parts.join('.');
}

export function validateStandard<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): { value: unknown } | { issues: { path: string; message: string }[]; async: false } | { promise: Promise<NormalizedResult> } {
  let r: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    r = schema['~standard'].validate(input) as StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { issues: [{ path: '<root>', message: msg }], async: false };
  }
  if (typeof (r as unknown as Promise<unknown>)?.then === 'function') {
    const p = (r as unknown as Promise<StandardSchemaV1.Result<unknown>>).then(
      (resolved) => normalizeResult(resolved),
      (e) => ({ ok: false as const, issues: [{ path: '<root>', message: e instanceof Error ? e.message : String(e) }] }),
    );
    return { promise: p };
  }
  const n = normalizeResult(r as StandardSchemaV1.Result<unknown>);
  if (!n.ok) return { issues: n.issues!, async: false };
  return { value: n.value };
}

function normalizeResult(r: StandardSchemaV1.Result<unknown>): NormalizedResult {
  if (!r.issues || r.issues.length === 0) {
    return { ok: true, value: (r as { value: unknown }).value };
  }
  return {
    ok: false,
    issues: r.issues.map((i) => ({ path: normalizePath(i.path as never), message: i.message })),
  };
}
