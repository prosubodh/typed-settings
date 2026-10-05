import type { StandardSchemaV1 } from '@standard-schema/spec';

// Best-effort schema description for `gen`.
// Zod 3/4: full. Valibot v1: full (entries). ArkType v2: full (json).
// Effect/others: best-effort placeholder + GEN_BEST_EFFORT flag.

export interface FieldDesc {
  path: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
}

function getShape(schema: unknown): Record<string, unknown> | null {
  const s = schema as { shape?: Record<string, unknown> | (() => Record<string, unknown>); _def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) } };
  if (s && typeof s.shape === 'object' && s.shape !== null) return s.shape as Record<string, unknown>;
  if (s && typeof s.shape === 'function') {
    try {
      return (s.shape as () => Record<string, unknown>)();
    } catch {
      return null;
    }
  }
  const d = s?._def?.shape;
  if (typeof d === 'function') {
    try {
      return (d as () => Record<string, unknown>)();
    } catch {
      return null;
    }
  }
  if (d && typeof d === 'object') return d as Record<string, unknown>;
  return null;
}

function unwrapField(t: unknown): { inner: unknown; optional: boolean; def?: unknown; desc?: string } {
  let cur: unknown = t;
  let optional = false;
  let def: unknown;
  for (let i = 0; i < 10; i++) {
    const c = cur as {
      type?: string;
      description?: string;
      def?: { type?: string; innerType?: unknown; defaultValue?: unknown; description?: string };
      _def?: { typeName?: string; innerType?: unknown; defaultValue?: unknown; description?: string };
      unwrap?: () => unknown;
    };
    // Zod 4: .type + .def.innerType. Nullable/catch wrappers carry the meaningful
    // type inside — unwrap them (nullable stays required; it widens, not optionals).
    const z4type = c?.type ?? c?.def?.type;
    if (z4type === 'optional') {
      optional = true;
      cur = c?.def?.innerType ?? (typeof c?.unwrap === 'function' ? safeUnwrap(c.unwrap) : undefined) ?? cur;
      if (cur === t) break;
      t = cur;
      continue;
    }
    if (z4type === 'nullable') {
      cur = c?.def?.innerType ?? (typeof c?.unwrap === 'function' ? safeUnwrap(c.unwrap) : undefined) ?? cur;
      if (cur === t) break;
      t = cur;
      continue;
    }
    if (z4type === 'catch' || z4type === 'prefault' || z4type === 'pipe' || z4type === 'brand' || z4type === 'readonly') {
      const inner = c?.def?.innerType ?? (typeof c?.unwrap === 'function' ? safeUnwrap(c.unwrap) : undefined);
      if (inner === undefined || inner === cur) break;
      cur = inner;
      t = cur;
      continue;
    }
    if (z4type === 'default') {
      const dv = c?.def?.defaultValue;
      if (def === undefined) def = typeof dv === 'function' ? safeCall(dv as () => unknown) : dv;
      // Defaulted fields never require input — even when the factory throws.
      optional = true;
      cur = c?.def?.innerType ?? (typeof c?.unwrap === 'function' ? safeUnwrap(c.unwrap) : undefined) ?? cur;
      continue;
    }
    if (z4type === 'readonly' || z4type === 'nonoptional' || z4type === 'success') {
      cur = c?.def?.innerType ?? cur;
      continue;
    }
    // Zod 3: _def.typeName
    const tn = c?._def?.typeName;
    if (tn === 'ZodOptional') {
      optional = true;
      cur = c?._def?.innerType;
      continue;
    }
    if (tn === 'ZodNullable') {
      cur = (c?._def as { innerType?: unknown })?.innerType;
      continue;
    }
    if (tn === 'ZodDefault') {
      if (def === undefined) {
        const dv = c?._def?.defaultValue;
        def = typeof dv === 'function' ? safeCall(dv as () => unknown) : dv;
      }
      // A defaulted field never requires input — even when its factory throws
      // (we lose the concrete default, but the "not required" stays true).
      optional = true;
      cur = (c?._def as { innerType?: unknown })?.innerType;
      continue;
    }
    if (tn === 'ZodReadonly') {
      cur = (c?._def as { innerType?: unknown })?.innerType;
      continue;
    }
    break;
  }
  const desc = (cur as { description?: string })?.description ?? (cur as { def?: { description?: string } })?.def?.description ?? (t as { description?: string })?.description;
  return { inner: cur, optional, def, desc };
}

function safeUnwrap(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Enum members across Zod shapes: v4 `entries` object, legacy `values` array. */
function enumMembers(def: unknown): unknown[] {
  const d = def as { values?: unknown; entries?: unknown };
  if (Array.isArray(d?.values)) return d.values as unknown[];
  if (d?.entries && typeof d.entries === 'object') return Object.values(d.entries);
  return [];
}

function unwrapZod(t: unknown): { inner: unknown; optional: boolean; def?: unknown; desc?: string } {
  return unwrapField(t);
}

function zodTypeName(t: unknown): string {
  const c = t as { type?: string; def?: { type?: string; values?: unknown; entries?: unknown; options?: unknown[] }; _def?: { typeName?: string; values?: unknown[]; options?: unknown[] } };
  const z4 = c?.type ?? c?.def?.type;
  if (z4) {
    switch (z4) {
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'array': return 'array';
      case 'object': return 'object';
      // Zod 4 keeps enum members in `def.entries` (object); older shapes use `def.values`.
      case 'enum': return `enum(${enumMembers(c?.def).join('|')})`;
      case 'literal': return 'literal';
      case 'union': return 'union';
      default: return z4;
    }
  }
  const tn = c?._def?.typeName ?? 'unknown';
  switch (tn) {
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodArray': return 'array';
    case 'ZodObject': return 'object';
    case 'ZodEnum': return `enum(${((c?._def?.values ?? []) as unknown[]).join('|')})`;
    case 'ZodLiteral': return 'literal';
    case 'ZodUnion': return 'union';
    default: return 'string';
  }
}

function walkZod(prefix: string, t: unknown, out: FieldDesc[]): void {
  const { inner, optional, def, desc } = unwrapZod(t);
  const shape = getShape(inner);
  if (shape) {
    for (const [k, v] of Object.entries(shape)) {
      walkZod(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  out.push({
    path: prefix || '<root>',
    type: zodTypeName(inner),
    required: !optional && def === undefined,
    default: def,
    description: desc,
  });
}

export function describeSchema(schema: unknown): { fields: FieldDesc[]; bestEffort: boolean } {
  // Zod 3 (_def.shape) or Zod 4 (.shape). An explicitly empty object is a
  // complete description (zero fields), not a best-effort fallback.
  try {
    if (getShape(schema)) {
      const out: FieldDesc[] = [];
      walkZod('', schema, out);
      return { fields: out, bestEffort: false };
    }
  } catch {
    // fall through
  }
  // Valibot v1 (.type === 'object' + .entries).
  try {
    if (isValibotObject(schema)) {
      const out: FieldDesc[] = [];
      walkValibot('', schema, out);
      return { fields: out, bestEffort: false };
    }
  } catch {
    // fall through
  }
  // ArkType v2 (.json with domain 'object').
  try {
    const j = arktypeJson(schema);
    if (j && (j as { domain?: string }).domain === 'object') {
      const out: FieldDesc[] = [];
      walkArktype(j, out);
      return { fields: out, bestEffort: false };
    }
  } catch {
    // fall through
  }
  return { fields: [{ path: '<root>', type: 'string', required: false, description: 'GEN_BEST_EFFORT: unknown schema (Effect/others), fill manually' }], bestEffort: true };
}

// --- Valibot v1 ---

interface ValibotField {
  type?: string;
  default?: unknown;
  wrapped?: unknown;
  entries?: Record<string, unknown>;
  options?: unknown[];
  literal?: unknown;
  description?: string;
}

function isValibotObject(schema: unknown): schema is { entries: Record<string, unknown> } {
  const s = schema as { type?: string; entries?: unknown };
  return !!s && s.type === 'object' && !!s.entries && typeof s.entries === 'object';
}

function unwrapValibot(t: unknown): { inner: unknown; optional: boolean; def?: unknown; desc?: string } {
  let cur: unknown = t;
  let optional = false;
  let def: unknown;
  for (let i = 0; i < 10; i++) {
    const c = cur as ValibotField;
    const ty = c?.type;
    if (ty === 'optional' || ty === 'nullish') {
      optional = true;
      if (def === undefined && c?.default !== undefined) def = c.default;
      if (!c?.wrapped) break;
      cur = c.wrapped;
      continue;
    }
    if (ty === 'nullable') {
      if (!c?.wrapped) break;
      cur = c.wrapped;
      continue;
    }
    if (ty === 'non_optional' || ty === 'non_nullable' || ty === 'non_nullish') {
      if (!c?.wrapped) break;
      cur = c.wrapped;
      continue;
    }
    break;
  }
  const leaf = cur as ValibotField;
  if (def === undefined && leaf?.default !== undefined) def = leaf.default;
  return { inner: cur, optional, def, desc: leaf?.description };
}

function valibotTypeName(t: unknown): string {
  const c = t as ValibotField;
  switch (c?.type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'bigint': return 'bigint';
    case 'date': return 'date';
    case 'array': return 'array';
    case 'object': return 'object';
    case 'record': return 'object';
    case 'tuple': return 'array';
    case 'map': return 'object';
    case 'picklist':
    case 'enum_': return `enum(${((c.options ?? []) as unknown[]).map((o) => JSON.stringify(o)).join('|')})`;
    case 'literal': return `literal(${JSON.stringify(c.literal)})`;
    case 'union':
    case 'variant':
    case 'intersect': return c.type;
    case 'nan': return 'number';
    default: return typeof c?.type === 'string' ? c.type : 'string';
  }
}

function walkValibot(prefix: string, t: unknown, out: FieldDesc[]): void {
  const { inner, optional, def, desc } = unwrapValibot(t);
  const c = inner as ValibotField;
  if (c?.type === 'object' && c.entries && typeof c.entries === 'object') {
    for (const [k, v] of Object.entries(c.entries)) {
      walkValibot(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  out.push({
    path: prefix || '<root>',
    type: valibotTypeName(inner),
    required: !optional && def === undefined,
    default: def,
    description: desc,
  });
}

// --- ArkType v2 (.json) ---

function arktypeJson(schema: unknown): unknown {
  const s = schema as { json?: unknown };
  const j = s?.json;
  // `.json` may be a data property or a zero-arg method depending on version.
  if (typeof j === 'function') {
    try {
      return (j as () => unknown)();
    } catch {
      return null;
    }
  }
  return j ?? null;
}

function arktypeTypeName(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return 'union';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('sequence' in o) return 'array';
    if (o['domain'] === 'object') return 'object';
    if (typeof o['proto'] === 'string') return String(o['proto']).toLowerCase();
  }
  return 'string';
}

function walkArktype(node: unknown, out: FieldDesc[]): void {
  const n = node as { domain?: string; required?: { key: string; value: unknown }[]; optional?: { key: string; value: unknown; default?: unknown }[] };
  if (n && n.domain === 'object' && (Array.isArray(n.required) || Array.isArray(n.optional))) {
    // NOTE: top-level keys are used verbatim (no prefix threading — nesting
    // recurses through walkArktypeValue, never back through here).
    for (const r of n.required ?? []) walkArktypeValue(r.key, r.value, true, undefined, out);
    for (const r of n.optional ?? []) walkArktypeValue(r.key, r.value, false, r.default, out);
    return;
  }
  out.push({ path: '<root>', type: arktypeTypeName(node), required: true, default: undefined });
}

function walkArktypeValue(path: string, value: unknown, required: boolean, def: unknown, out: FieldDesc[]): void {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as { domain?: string }).domain === 'object') {
    const n = value as { required?: { key: string; value: unknown }[]; optional?: { key: string; value: unknown; default?: unknown }[] };
    if (Array.isArray(n.required) || Array.isArray(n.optional)) {
      for (const r of n.required ?? []) walkArktypeValue(`${path}.${r.key}`, r.value, true, undefined, out);
      for (const r of n.optional ?? []) walkArktypeValue(`${path}.${r.key}`, r.value, false, r.default, out);
      return;
    }
  }
  out.push({ path, type: arktypeTypeName(value), required: required && def === undefined, default: def });
}

export function toEnvExample(fields: FieldDesc[], prefix = ''): string {
  const lines: string[] = ['# Generated by typed-settings gen — edit values, keep keys'];
  const sorted = [...fields].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    // The '<root>' placeholder (unknown schema) has no env-mappable key —
    // emit a comment, never a literal `<ROOT>=` line (invalid env syntax).
    if (f.path === '<root>') {
      lines.push(`# ${f.description ?? 'no fields discovered — fill manually'}`);
      continue;
    }
    const key = (prefix + f.path.replace(/\./g, '__')).toUpperCase();
    const val = f.default !== undefined && typeof f.default !== 'object' ? String(f.default) : f.type === 'number' ? '0' : f.type === 'boolean' ? 'false' : '';
    const comment = f.required ? 'required' : `default: ${f.default !== undefined ? JSON.stringify(f.default) : 'none'}`;
    if (f.description) lines.push(`# ${f.description}`);
    lines.push(`${key}=${val} # ${f.type} ${comment}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function toMarkdownDocs(fields: FieldDesc[], prefix = ''): string {
  const lines = ['# Configuration', '', '| Env | Path | Type | Required | Default |', '| --- | --- | --- | --- | --- |'];
  for (const f of [...fields].sort((a, b) => a.path.localeCompare(b.path))) {
    const env = (prefix + f.path.replace(/\./g, '__')).toUpperCase();
    lines.push(`| \`${env}\` | \`${f.path}\` | ${f.type} | ${f.required} | ${f.default !== undefined ? `\`${JSON.stringify(f.default)}\`` : '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export type { StandardSchemaV1 };
