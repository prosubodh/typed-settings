import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadSchema } from './load-schema.js';
import { describeSchema, toEnvExample, toMarkdownDocs } from './describe.js';

/** Arguments for {@link runGen} (mirrors the `gen` CLI flags). */
export interface GenArgs {
  /** Schema file path (required). */
  schema: string;
  schemaExport?: string;
  /** `.env.example` destination; stdout when omitted. */
  out?: string; // .env.example path
  /** `CONFIG.md` destination; skipped when omitted (unless nothing prints). */
  docs?: string; // CONFIG.md path
  prefix?: string;
  /** Overwrite existing `out`/`docs` (default false). */
  force?: boolean; // overwrite existing out/docs (default false)
}

/**
 * Generates `.env.example` + `CONFIG.md` from a schema file. Warns
 * `GEN_BEST_EFFORT` for non-Zod schemas. Exit 0 ok, 2 on load error or
 * refusal to overwrite without `--force`.
 */
export async function runGen(args: GenArgs): Promise<number> {
  let schema;
  try {
    schema = await loadSchema(args.schema, args.schemaExport);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const { fields, bestEffort } = describeSchema(schema);
  if (bestEffort) console.error('GEN_BEST_EFFORT: non-Zod schema, output is a starting point — verify types manually');
  const envText = toEnvExample(fields, args.prefix);
  const mdText = toMarkdownDocs(fields, args.prefix);
  const writeGuarded = (p: string, content: string): number => {
    if (existsSync(p) && !args.force) {
      console.error(`E_EXISTS: ${p} exists — pass --force to overwrite`);
      return 2;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, { mode: 0o600 });
    console.log(`gen: wrote ${p}`);
    return 0;
  };
  if (args.out) {
    const code = writeGuarded(resolve(args.out), envText);
    if (code !== 0) return code;
  } else {
    console.log(envText);
  }
  if (args.docs) {
    const code = writeGuarded(resolve(args.docs), mdText);
    if (code !== 0) return code;
  } else if (!args.out) {
    // No file destinations at all: print both artifacts so the docs are not lost.
    console.log(mdText);
  }
  return 0;
}
