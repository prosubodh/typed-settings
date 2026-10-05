#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runCheck } from './check.js';
import { runInit } from './init.js';
import { runGen } from './gen.js';
import { runWatch } from './watch.js';

/**
 * CLI dispatcher (`check|init|gen|watch`). Returns the process exit code
 * instead of exiting, so it's testable: 0 ok, 1 invalid, 2 usage/load error.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`typed-settings <check|init|gen|watch>\n\ncheck -s schema.ts -c base.yaml,.env [--strict] [--no-expand] [--array replace|concat|mergeIndex] [--format human|json]\ninit --lib zod|valibot|arktype|yup|joi --format yaml|toml|env [--force|--dry-run|--check]\ngen --schema src/config.ts --out .env.example --docs CONFIG.md\nwatch -s schema.ts -c base.yaml --once [--exit-on-error] [-- cmd...]`);
    return 0;
  }
  try {
    if (cmd === 'check') {
      const { values } = parseArgs({
        args: rest,
        // allowNegative enables the advertised `--no-expand` negation flag.
        allowNegative: true,
        options: {
          schema: { type: 'string', short: 's' },
          config: { type: 'string', short: 'c' },
          strict: { type: 'boolean', default: false },
          expand: { type: 'boolean', default: true },
          array: { type: 'string', default: 'replace' },
          format: { type: 'string', default: 'human' },
          'schema-export': { type: 'string' },
          prefix: { type: 'string' },
        },
      });
      if (!values.schema) {
        console.error('Usage: check -s schema.ts -c base.yaml,.env');
        return 2;
      }
      // parseArgs accepts any string — reject unknown enum values here (usage error).
      if (values.array !== undefined && !['replace', 'concat', 'mergeIndex'].includes(values.array)) {
        console.error(`E_USAGE: --array must be replace|concat|mergeIndex (got ${JSON.stringify(values.array)})`);
        return 2;
      }
      if (values.format !== undefined && !['human', 'json'].includes(values.format)) {
        console.error(`E_USAGE: --format must be human|json (got ${JSON.stringify(values.format)})`);
        return 2;
      }
      return await runCheck({
        schema: values.schema,
        config: values.config,
        strict: values.strict,
        expand: values.expand,
        array: values.array as 'replace' | 'concat' | 'mergeIndex',
        format: values.format as 'human' | 'json',
        schemaExport: values['schema-export'],
        prefix: values.prefix,
      });
    }
    if (cmd === 'init') {
      const { values } = parseArgs({
        args: rest,
        options: {
          lib: { type: 'string', default: 'zod' },
          format: { type: 'string', default: 'env' },
          dir: { type: 'string', default: '.' },
          force: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          check: { type: 'boolean', default: false },
        },
      });
      return await runInit({
        lib: values.lib as 'zod',
        format: values.format as 'yaml',
        dir: values.dir,
        force: values.force,
        dryRun: values['dry-run'],
        check: values.check,
      });
    }
    if (cmd === 'gen') {
      const { values } = parseArgs({
        args: rest,
        options: {
          schema: { type: 'string' },
          'schema-export': { type: 'string' },
          out: { type: 'string' },
          docs: { type: 'string' },
          prefix: { type: 'string' },
          force: { type: 'boolean', default: false },
        },
      });
      if (!values.schema) {
        console.error('Usage: gen --schema src/config.ts --out .env.example --docs CONFIG.md');
        return 2;
      }
      return await runGen({
        schema: values.schema,
        schemaExport: values['schema-export'],
        out: values.out,
        docs: values.docs,
        prefix: values.prefix,
        force: values.force,
      });
    }
    if (cmd === 'watch') {
      const dashIdx = rest.indexOf('--');
      const watchArgs = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
      const childCmd = dashIdx === -1 ? [] : rest.slice(dashIdx + 1);
      const { values } = parseArgs({
        args: watchArgs,
        allowNegative: true,
        options: {
          schema: { type: 'string', short: 's' },
          config: { type: 'string', short: 'c' },
          strict: { type: 'boolean', default: false },
          expand: { type: 'boolean', default: true },
          array: { type: 'string', default: 'replace' },
          once: { type: 'boolean', default: false },
          'exit-on-error': { type: 'boolean', default: false },
          'schema-export': { type: 'string' },
          prefix: { type: 'string' },
        },
      });
      if (values.array !== undefined && !['replace', 'concat', 'mergeIndex'].includes(values.array)) {
        console.error(`E_USAGE: --array must be replace|concat|mergeIndex (got ${JSON.stringify(values.array)})`);
        return 2;
      }
      return await runWatch({
        schema: values.schema,
        config: values.config,
        schemaExport: values['schema-export'],
        strict: values.strict,
        expand: values.expand,
        array: values.array as 'replace' | 'concat' | 'mergeIndex',
        prefix: values.prefix,
        once: values.once,
        exitOnError: values['exit-on-error'],
        cmd: childCmd.length ? childCmd : undefined,
      });
    }
    console.error(`unknown command: ${cmd}`);
    return 2;
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}

/* v8 ignore next 6 -- process entry bootstrap: only runs as the real CLI binary. */
const isDirect = process.argv[1]?.endsWith('main.js') || process.argv[1]?.endsWith('main.cjs');
if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  });
}
