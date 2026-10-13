import { spawn, type ChildProcess } from 'node:child_process';
import { watchSettings } from '../node.js';
import { loadSchema } from './load-schema.js';

/** Arguments for {@link runWatch} (mirrors the `watch` CLI flags). */
export interface WatchArgs {
  /** Schema file path (required). */
  schema?: string;
  /** Comma-separated sources. Default `'.env,env'`. */
  config?: string;
  schemaExport?: string;
  /** `unknownKeys: 'reject'`. */
  strict?: boolean;
  /** Set false via `--no-expand`. */
  expand?: boolean;
  array?: 'replace' | 'concat' | 'mergeIndex';
  prefix?: string;
  /** Extra secret matchers (comma-separated `--secret-keys`, `--once` only). */
  secretKeys?: (string | RegExp)[];
  /** Output shape for `--once` (same `--format` as `check`). */
  format?: 'human' | 'json';
  /** Validate once and exit (0/1/2) instead of supervising. */
  once?: boolean;
  /** Long-run: exit 1 on the first invalid reload. */
  exitOnError?: boolean;
  /** Long-run: exit with the child's code when it crashes instead of supervising. */
  exitOnChildError?: boolean;
  /** Child command after `--`, spawned at startup and restarted per reload. */
  cmd?: string[];
}

/**
 * Validates once (`--once`) or supervises until SIGINT/SIGTERM. Long-running
 * until dispose: exit 0 on clean shutdown, 1 on `--exit-on-error` failure.
 */
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
    const proc = spawn(args.cmd[0]!, args.cmd.slice(1), { stdio: 'inherit', shell: false });
    child = proc;
    proc.on('error', (e) => {
      // A missing binary emits 'error', not 'exit' — report instead of crashing.
      console.error(`watch: child failed to start: ${(e as Error).message}`);
      if (child === proc) child = null;
    });
    proc.on('exit', (code, signal) => {
      // Only clear if this is still the current child — an old child's late
      // exit must not null out its replacement (orphan/unKillable). Our own
      // kills already nulled the slot, so anything handled here is a real death.
      if (child !== proc) return;
      child = null;
      // A crash would otherwise idle silently at exit 0 until the next reload.
      // Kills arrive as (null, 'SIGTERM'); only real deaths report and propagate.
      if (typeof code === 'number' && code !== 0) {
        console.error(`watch: child exited with code ${code}`);
        if (args.exitOnChildError) childFailed(code);
      } else if (typeof signal === 'string') {
        console.error(`watch: child exited on signal ${signal}`);
        if (args.exitOnChildError) childFailed(1);
      }
    });
  };
  const stopChild = () => {
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // ignore (already dead)
    }
    // A child trapping SIGTERM would otherwise orphan and collide with its
    // replacement's bind: escalate once after a grace period. Unref'd so a
    // dying supervisor is never pinned by its own escalation timer.
    const t = setTimeout(() => {
      try {
        (proc.kill as (sig?: string) => boolean)('SIGKILL');
      } catch {
        // ignore (exited between SIGTERM and escalation)
      }
    }, 2000);
    (t as unknown as { unref(): void }).unref();
  };
  if (args.once) {
    // --once validates a single snapshot; a child command makes no sense here.
    if (args.cmd?.length) console.error('watch: -- cmd is ignored with --once (single validation, nothing to supervise)');
    // Single implementation with `check`: same exit codes, same redaction,
    // same --format shapes. (Duplicating settings() here drifted before.)
    const { runCheck } = await import('./check.js');
    return runCheck({
      schema: args.schema,
      config: args.config,
      schemaExport: args.schemaExport,
      strict: args.strict,
      expand: args.expand,
      array: args.array,
      prefix: args.prefix,
      format: args.format,
      secretKeys: args.secretKeys,
    });
  }
  const sub = watchSettings(
    // NOTE: no `env` override — inherit process.env exactly like --once/check do.
    { schema, sources: sources.length ? sources : (['.env', 'env'] as never), unknownKeys: args.strict ? 'reject' : 'strip', expand: args.expand ?? true, arrayStrategy: args.array ?? 'replace', prefix: args.prefix } as never,
    {
      onUpdate: (cfg, changed) => {
        // A mtime-only touch must not churn the supervised child: only actual
        // value changes restart it (changed=[] still reports a healthy reload
        // for `get()`-based consumers — the *child* just isn't restarted).
        if (changed.length === 0) return;
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
            finish(1);
          });
        }
      },
    },
  );
  // Local completion (not the global exitCode side-channel): the interval poll
  // below stays as a backstop for externally-set exit codes, but every path we
  // own resolves through finish(), which also drops our signal listeners so
  // sequential runWatch calls in one process don't accumulate them.
  let resolveMain!: (code: number) => void;
  const finished = new Promise<number>((res) => {
    resolveMain = res;
  });
  const finish = (code: number): void => {
    // Drop our signal listeners: sequential runWatch calls in one process
    // (tests, embedded use) must not accumulate stale handlers.
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
    process.removeListener('SIGINT', signalDone);
    process.removeListener('SIGTERM', signalDone);
    clearInterval(t);
    resolveMain(code);
  };
  const childFailed = (code: number): void => {
    void sub.dispose().then(() => {
      stopChild();
      process.exitCode = code;
      finish(code);
    });
  };
  startChild();
  // Shutdown must complete (watchers closed, child reaped) before runWatch
  // resolves — returning first lets the process exit with the child orphaned.
  let markDown: (() => void) | null = null;
  const down = new Promise<void>((res) => {
    markDown = res;
  });
  const shutdown = () => {
    void sub.dispose().then(() => {
      stopChild();
      (markDown as () => void)();
    });
  };
  const t = setInterval(() => {
    if ((process.exitCode ?? 0) !== 0) finish(Number(process.exitCode));
  }, 100);
  const signalDone = (): void => {
    clearInterval(t);
    void down.then(() => finish(Number(process.exitCode ?? 0)));
  };
  function onSigInt(): void {
    shutdown();
  }
  function onSigTerm(): void {
    shutdown();
  }
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);
  process.once('SIGINT', signalDone);
  process.once('SIGTERM', signalDone);
  return finished;
}
