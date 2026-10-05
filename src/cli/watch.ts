import { spawn, type ChildProcess } from 'node:child_process';
import { watchSettings } from '../node.js';
import { loadSchema } from './load-schema.js';

export interface WatchArgs {
  schema?: string;
  config?: string;
  schemaExport?: string;
  strict?: boolean;
  expand?: boolean;
  array?: 'replace' | 'concat' | 'mergeIndex';
  prefix?: string;
  once?: boolean;
  exitOnError?: boolean;
  cmd?: string[];
}

/** Long-running until SIGINT. Exit 0 on dispose, 1 on --exit-on-error failure. */
export async function runWatch(args: WatchArgs): Promise<number> {
  if (!args.schema) {
    console.error('Usage: watch -s schema.ts -c base.yaml,.env [-- cmd...]');
    return 2;
  }
  const schema = await loadSchema(args.schema, args.schemaExport).catch((e) => {
    console.error((e as Error).message);
    return null;
  });
  if (!schema) return 2;
  const sources = (args.config ?? '.env,env').split(',').map((s) => s.trim()).filter(Boolean) as never[];
  let child: ChildProcess | null = null;
  const startChild = () => {
    if (!args.cmd?.length) return;
    stopChild();
    child = spawn(args.cmd[0]!, args.cmd.slice(1), { stdio: 'inherit', shell: false });
    child.on('error', (e) => {
      // A missing binary emits 'error', not 'exit' — report instead of crashing.
      console.error(`watch: child failed to start: ${(e as Error).message}`);
      child = null;
    });
    child.on('exit', () => {
      child = null;
    });
  };
  const stopChild = () => {
    try {
      child?.kill();
    } catch {
      // ignore
    }
    child = null;
  };
  if (args.once) {
    // --once validates a single snapshot; a child command makes no sense here.
    if (args.cmd?.length) console.error('watch: -- cmd is ignored with --once (single validation, nothing to supervise)');
    const { settings, ConfigError } = await import('../index.js');
    try {
      settings({ schema, sources: sources.length ? sources : (['.env', 'env'] as never), unknownKeys: args.strict ? 'reject' : 'strip', expand: args.expand ?? true, arrayStrategy: args.array ?? 'replace', prefix: args.prefix } as never);
      console.log('OK: config valid');
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      // Invalid config -> 1; anything else (E_PARSE/EACCES/usage) -> 2.
      return e instanceof ConfigError ? 1 : 2;
    }
  }
  const sub = watchSettings(
    // NOTE: no `env` override — inherit process.env exactly like --once/check do.
    { schema, sources: sources.length ? sources : (['.env', 'env'] as never), unknownKeys: args.strict ? 'reject' : 'strip', expand: args.expand ?? true, arrayStrategy: args.array ?? 'replace', prefix: args.prefix } as never,
    {
      onUpdate: (cfg, changed) => {
        console.log(`reload: ok changed=[${changed.join(',')}]`);
        if (args.cmd?.length) startChild();
        void cfg;
      },
      onError: (e) => {
        console.error(`reload: invalid, kept old\n${(e as Error).message}`);
        if (args.exitOnError) {
          void sub.dispose().then(() => {
            stopChild();
            process.exitCode = 1;
          });
        }
      },
    },
  );
  startChild();
  const shutdown = () => {
    void sub.dispose().then(() => {
      stopChild();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if ((process.exitCode ?? 0) !== 0) {
        clearInterval(t);
        resolve();
      }
    }, 100);
    process.once('SIGINT', () => {
      clearInterval(t);
      resolve();
    });
    process.once('SIGTERM', () => {
      clearInterval(t);
      resolve();
    });
  });
  return Number(process.exitCode ?? 0);
}
