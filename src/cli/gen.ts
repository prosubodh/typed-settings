import { writeFileSync, mkdirSync, existsSync, chmodSync, lstatSync } from 'node:fs';
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
 * True when `p` exists and is a symlink (via lstat, so a dangling link counts).
 * ENOENT reads as false — nothing to refuse.
 */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
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
  const outPath = args.out ? resolve(args.out) : null;
  const docsPath = args.docs ? resolve(args.docs) : null;
  // Atomicity first: refuse before writing anything, so a guarded `docs` file
  // never leaves a half-applied run (fresh `out` written, exit 2).
  for (const p of [outPath, docsPath]) {
    if (!p) continue;
    // --force must never write *through* a symlink — a hostile or accidental
    // link could point at .bashrc or SSH keys. lstat (no follow) also catches
    // dangling links that existsSync would otherwise miss and recreate.
    if (isSymlink(p)) {
      console.error(`E_SYMLINK: ${p} is a symlink — refusing to write through it`);
      return 2;
    }
    if (existsSync(p) && !args.force) {
      console.error(`E_EXISTS: ${p} exists — pass --force to overwrite`);
      return 2;
    }
  };
  const writeGuarded = (p: string, content: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, { mode: 0o600 });
    try {
      // mode is ignored on Windows — repair like init does.
      chmodSync(p, 0o600);
      /* v8 ignore next 3 -- chmod failure is best-effort (Windows/no-permission) */
    } catch {
      // Windows/no-permission: best effort
    }
    console.log(`gen: wrote ${p}`);
  };
  if (outPath) {
    writeGuarded(outPath, envText);
  } else {
    console.log(envText);
  }
  if (docsPath) {
    writeGuarded(docsPath, mdText);
  } else if (!outPath) {
    // No file destinations at all: print both artifacts so the docs are not lost.
    // A header separates them — bare concatenation is unparsable as .env.
    console.log('# ---- CONFIG.md below ----');
    console.log(mdText);
  }
  return 0;
}
