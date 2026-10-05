import { settings, ConfigError } from '../index.js';
import { loadSchema } from './load-schema.js';

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
}

/**
 * Validates a config against a schema file. Exit codes: 0 valid,
 * 1 invalid config, 2 schema-load failure or bad flags.
 */
export async function runCheck(args: CheckArgs): Promise<number> {
  let schema;
  try {
    schema = await loadSchema(args.schema, args.schemaExport);
  } catch (e) {
    const err = e as Error;
    if (args.format === 'json') console.log(JSON.stringify({ ok: false, error: err.message }));
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
      strict: undefined,
      unknownKeys: args.strict ? 'reject' : 'strip',
      expand: args.expand ?? true,
      arrayStrategy: args.array ?? 'replace',
      prefix: args.prefix,
    } as never);
    if (args.format === 'json') console.log(JSON.stringify({ ok: true, config: cfg }));
    else console.log('OK: config valid');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      if (args.format === 'json') console.log(JSON.stringify({ ok: false, issues: e.issues }));
      else {
        console.error(e.message);
      }
      return 1;
    }
    const err = e as Error;
    if (args.format === 'json') console.log(JSON.stringify({ ok: false, error: err.message }));
    else console.error(`E_LOAD: ${err.message}`);
    return 2;
  }
}
