import { settings, ConfigError, isSecretKey } from '../index.js';
import { redactValue } from '../errors.js';
import { loadSchema } from './load-schema.js';

/** Redact secret-looking leaves before printing `--format json` (CI logs capture stdout). */
function redactForJson(cfg: unknown, secretKeys?: (string | RegExp)[], prefix = ''): unknown {
  if (Array.isArray(cfg)) return cfg.map((x) => redactForJson(x, secretKeys, prefix));
  if (cfg && typeof cfg === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      // Match the full dotted path, like error redaction does: a secret nested
      // under a secret parent (mykey.x) redacts even when the leaf name is plain.
      const path = prefix ? `${prefix}.${k}` : k;
      // Strings, numbers, and booleans all leak when printed (PIN=123456
      // coerces to a number before validation ever sees it).
      const leaking =
        isSecretKey(path, secretKeys) &&
        ((typeof v === 'string' && v.length > 0) || typeof v === 'number' || typeof v === 'boolean');
      out[k] = leaking
        ? (typeof v === 'string' ? redactValue(path, v, secretKeys) : '(redacted)')
        : redactForJson(v, secretKeys, path);
    }
    return out;
  }
  return cfg;
}

/** Arguments for {@link runCheck} (mirrors the `check` CLI flags). */
export interface CheckArgs {
  /** Schema file path (required). */
  schema: string;
  /** Comma-separated sources. Default `'.env,env'`. */
  config?: string; // comma-separated
  /** `unknownKeys: 'reject'`. */
  strict?: boolean;
  /** `--no-expand` sets false. */
  expand?: boolean; // --no-expand sets false
  array?: 'replace' | 'concat' | 'mergeIndex';
  /** `'human'` prints errors, `'json'` prints `{ok, config}` or `{ok:false, ...}`. */
  format?: 'human' | 'json';
  /** Which export holds the schema. */
  schemaExport?: string;
  prefix?: string;
  /** Extra secret matchers for json output redaction (see `secretKeys`). */
  secretKeys?: (string | RegExp)[];
}

/** ConfigError codes that mean "fix the values" (exit 1); the rest mean "fix the invocation" (exit 2). */
const VALUE_CODES = new Set(['E_INVALID_CONFIG', 'E_UNKNOWN_KEY', 'E_UNRESOLVED', 'E_CIRCULAR', 'E_BAD_OP', 'E_EXPAND']);

/**
 * Validates a config against a schema file. Exit codes: 0 valid, 1 bad values,
 * 2 schema-load failure, bad flags, or load/usage problems.
 */
export async function runCheck(args: CheckArgs): Promise<number> {
  let schema;
  try {
    schema = await loadSchema(args.schema, args.schemaExport);
  } catch (e) {
    // loadSchema always sets .code (SCHEMA_LOAD_ERROR) — no fallback needed.
    const err = e as Error & { code: string };
    const code = err.code;
    if (args.format === 'json') console.log(JSON.stringify({ ok: false, code, error: err.message }));
    else console.error(err.message);
    return 2;
  }
  const sources = (args.config ?? '.env,env')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ('env' | '.env' | string)[];
  try {
    const cfg = settings({
      schema,
      sources: sources.length ? sources : ['.env', 'env'],
      unknownKeys: args.strict ? 'reject' : 'strip',
      expand: args.expand ?? true,
      arrayStrategy: args.array ?? 'replace',
      prefix: args.prefix,
      secretKeys: args.secretKeys,
    } as never);
    if (args.format === 'json') console.log(JSON.stringify({ ok: true, config: redactForJson(cfg, args.secretKeys) }));
    else console.log('OK: config valid');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      if (args.format === 'json') console.log(JSON.stringify({ ok: false, code: e.code, issues: e.issues }));
      else {
        console.error(e.message);
      }
      // Only value problems are exit 1 (fix the values): rejected values,
      // unknown keys, and unresolvable/circular/bad-op references. Load and
      // usage failures are exit 2 (fix the invocation) so CI can tell them apart.
      return VALUE_CODES.has(e.code) ? 1 : 2;
    }
    const err = e as Error;
    if (args.format === 'json') console.log(JSON.stringify({ ok: false, code: 'E_LOAD', error: err.message }));
    else console.error(`E_LOAD: ${err.message}`);
    return 2;
  }
}
