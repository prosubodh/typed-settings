import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

export interface InitArgs {
  lib?: 'zod' | 'valibot' | 'arktype' | 'yup' | 'joi';
  format?: 'yaml' | 'toml' | 'env';
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
  check?: boolean; // --check: fail if files would change
}

const SETTINGS_TPL: Record<string, string> = {
  zod: `import { z } from 'zod';
import { settings } from 'typed-settings';

const schema = z.object({
  port: z.coerce.number().default(3000),
});

export const cfg = settings({ schema, sources: ['.env', 'env'], prefix: 'APP_' });
`,
  valibot: `import * as v from 'valibot';
import { settings } from 'typed-settings';

const schema = v.object({ port: v.optional(v.pipe(v.unknown(), v.transform(Number)), 3000) });

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_' });
`,
  arktype: `import { type } from 'arktype';
import { settings } from 'typed-settings';

const schema = type({ 'port?: string.integer.parse = 3000' });

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_' });
`,
  yup: `import * as yup from 'yup';
import { settings } from 'typed-settings';
import { yupAdapter } from 'typed-settings/yup';

const schema = yup.object({ port: yup.number().default(3000) });

export const cfg = settings({ schema: yupAdapter(schema) as never, sources: ['.env', 'env'], prefix: 'APP_' });
`,
  joi: `import Joi from 'joi';
import { settings } from 'typed-settings';
import { joiAdapter } from 'typed-settings/joi';

const schema = Joi.object({ port: Joi.number().default(3000) });

export const cfg = settings({ schema: joiAdapter(schema as never) as never, sources: ['.env', 'env'], prefix: 'APP_' });
`,
};

const CONFIG_TPL: Record<string, string> = {
  env: '# APP_PORT=3000\nAPP_PORT=3000\n',
  yaml: '# config.yaml\nport: 3000\n',
  toml: '# config.toml\nport = 3000\n',
};

/** Exit 0 ok / 2 on error (or --check diff). */
export async function runInit(args: InitArgs): Promise<number> {
  const lib = args.lib ?? 'zod';
  const format = args.format ?? 'env';
  if (!(lib in SETTINGS_TPL)) {
    console.error(`E_USAGE: --lib must be ${Object.keys(SETTINGS_TPL).join('|')} (got ${JSON.stringify(lib)})`);
    return 2;
  }
  if (!(format in CONFIG_TPL)) {
    console.error(`E_USAGE: --format must be ${Object.keys(CONFIG_TPL).join('|')} (got ${JSON.stringify(format)})`);
    return 2;
  }
  const dir = resolve(args.dir ?? '.');
  const settingsTpl = SETTINGS_TPL[lib]!;
  const configName = format === 'env' ? '.env.example' : `config.${format}`;
  const files: { path: string; content: string }[] = [
    { path: join(dir, 'src', 'settings.ts'), content: settingsTpl },
    { path: join(dir, configName), content: CONFIG_TPL[format]! },
  ];
  const currentOf = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  // --check/--dry-run compare content, not just existence: drifted files count.
  const drifted = files.filter((f) => currentOf(f.path) !== f.content);
  if (args.dryRun || args.check) {
    for (const f of files) {
      const cur = currentOf(f.path);
      console.log(`${cur === null ? 'create' : cur === f.content ? 'exists' : 'overwrite'} ${f.path}`);
    }
    if (args.check && drifted.length > 0) return 2;
    return 0;
  }
  let written = 0;
  let skipped = 0;
  for (const f of files) {
    if (currentOf(f.path) === f.content) {
      skipped++;
      continue; // already in the desired state
    }
    if (existsSync(f.path) && !args.force) {
      skipped++;
      continue;
    }
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, { mode: 0o600 });
    try {
      // mode only applies to new files — enforce 0600 on overwrites too.
      chmodSync(f.path, 0o600);
      /* v8 ignore next 3 -- chmod failure is best-effort (Windows/no-permission) */
    } catch {
      // Windows/no-permission: best effort
    }
    written++;
  }
  console.log(`init: ${lib} + ${format} scaffolding ${written > 0 ? `written (${written} file${written === 1 ? '' : 's'})` : 'already up to date'}`);
  return 0;
}
