import { settings, ConfigError } from '../index.js';
import { loadSchema } from './load-schema.js';

export interface CheckArgs {
  schema: string;
  config?: string; // comma-separated
  strict?: boolean;
  expand?: boolean; // --no-expand sets false
  array?: 'replace' | 'concat' | 'mergeIndex';
  format?: 'human' | 'json';
  schemaExport?: string;
  prefix?: string;
}

/** Exit codes: 0 ok / 1 invalid / 2 load-usage. */
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
