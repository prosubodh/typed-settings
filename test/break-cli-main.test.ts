import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.js';
import { runWatch } from '../src/cli/watch.js';

const store = vi.hoisted(() => ({
  children: [] as {
    args: unknown[];
    killed: boolean;
    kills: unknown[];
    kill: (...a: unknown[]) => boolean;
    emit: (ev: string, ...a: unknown[]) => void;
  }[],
}));

vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child = {
      args,
      killed: false,
      kills: [] as unknown[],
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(fn);
        return child;
      },
      kill: (...a: unknown[]) => {
        child.killed = true;
        child.kills.push(a[0] ?? 'SIGTERM');
        return true;
      },
      emit: (ev: string, ...a: unknown[]) => {
        for (const fn of handlers[ev] ?? []) fn(...a);
      },
    };
    store.children.push(child);
    return child;
  };
  return { spawn };
});

const localTmp = (prefix: string): string => {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
};

const SCHEMA_TS = `import { z } from 'zod';\nexport const schema = z.object({ port: z.coerce.number().default(3000) });\n`;

const waitFor = (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve(undefined);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
};

beforeEach(() => {
  store.children.length = 0;
});

describe('break: main() dispatch', () => {
  it('--help, no args, and unknown commands', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main([])).toBe(0);
    expect(await main(['frobnicate'])).toBe(2);
  });

  it('parseArgs failures become usage errors, not crashes', async () => {
    expect(await main(['check', '--bogus-flag'])).toBe(2);
    expect(await main(['check'])).toBe(2); // missing -s
    expect(await main(['gen'])).toBe(2); // missing --schema
  });

  it('check validates enums and honors --no-expand/--strict', async () => {
    const dir = localTmp('ts-main');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1111 }));
    expect(await main(['check', '-s', schema, '-c', cfg])).toBe(0);
    expect(await main(['check', '-s', schema, '-c', cfg, '--array', 'bogus'])).toBe(2);
    expect(await main(['check', '-s', schema, '-c', cfg, '--format', 'xml'])).toBe(2);

    // $UNSET... expands (and fails) by default; --no-expand keeps the literal.
    const strSchema = join(dir, 'str-schema.ts');
    writeFileSync(strSchema, `import { z } from 'zod';\nexport const schema = z.object({ name: z.string() });\n`);
    writeFileSync(cfg, JSON.stringify({ name: '$UNSET_VAR_XYZ' }));
    expect(await main(['check', '-s', strSchema, '-c', cfg, '--format', 'json'])).toBe(1);
    expect(await main(['check', '-s', strSchema, '-c', cfg, '--no-expand'])).toBe(0);

    writeFileSync(cfg, JSON.stringify({ port: 1, EXTRA: 'x' }));
    expect(await main(['check', '-s', schema, '-c', cfg])).toBe(0);
    expect(await main(['check', '-s', schema, '-c', cfg, '--strict'])).toBe(1);
  });

  it('init rejects unknown lib/format', async () => {
    const dir = localTmp('ts-main');
    expect(await main(['init', '--lib', 'bogus', '--dir', dir])).toBe(2);
    expect(await main(['init', '--format', 'xml', '--dir', dir])).toBe(2);
    expect(await main(['init', '--lib', 'zod', '--format', 'env', '--dir', dir])).toBe(0);
  });

  it('gen guards overwrites behind --force', async () => {
    const dir = localTmp('ts-main');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const out = join(dir, '.env.example');
    expect(await main(['gen', '--schema', schema, '--out', out])).toBe(0);
    expect(await main(['gen', '--schema', schema, '--out', out])).toBe(2);
    expect(await main(['gen', '--schema', schema, '--out', out, '--force'])).toBe(0);
  });

  it('watch validates usage and delegates --once codes', async () => {
    expect(await main(['watch', '--once'])).toBe(2); // no -s: usage
    const dir = localTmp('ts-main');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    expect(await main(['watch', '--array', 'bogus'])).toBe(2);
    expect(await main(['watch', '-s', join(dir, 'missing.ts'), '--once'])).toBe(2);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 5 }));
    expect(await main(['watch', '-s', schema, '-c', cfg, '--once', '--', 'echo', 'hi'])).toBe(0);
    expect(await main(['watch', '-s', schema, '-c', cfg, '--once'])).toBe(0);
    writeFileSync(cfg, JSON.stringify({ port: 'not-a-number' }));
    expect(await main(['watch', '-s', schema, '-c', cfg, '--once'])).toBe(1);
  });
});

describe('break: supervised watch (mocked child)', () => {
  it('spawns the child, restarts on change, reaps on SIGINT', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'] });
    await waitFor(() => store.children.length >= 1);
    expect(store.children[0]!.args).toEqual(['node', ['server.js'], { stdio: 'inherit', shell: false }]);
    writeFileSync(cfg, JSON.stringify({ port: 2 }));
    await waitFor(() => store.children.length >= 2);
    expect(store.children[0]!.killed).toBe(true); // old child reaped before respawn
    // A child that already exited clears the slot without crashing the supervisor.
    store.children[1]!.emit('exit', 0);
    writeFileSync(cfg, JSON.stringify({ port: 3 }));
    await waitFor(() => store.children.length >= 3);
    process.emit('SIGINT');
    expect(await p).toBe(0);
    expect(store.children[store.children.length - 1]!.killed).toBe(true);
  });

  it('a no-change reload does not restart the child', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    const body = JSON.stringify({ port: 1 });
    writeFileSync(cfg, body);
    const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'] });
    await waitFor(() => store.children.length >= 1);
    // Rewrite identical bytes (mtime bump, same values): the supervised child
    // must not churn on a touch. Only actual value changes restart it.
    writeFileSync(cfg, body);
    await new Promise((r) => setTimeout(r, 400));
    expect(store.children.length).toBe(1);
    process.emit('SIGINT');
    expect(await p).toBe(0);
  });

  it('child start failures do not crash the watcher', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'] });
    await waitFor(() => store.children.length >= 1);
    store.children[0]!.emit('error', new Error('spawn ENOENT'));
    writeFileSync(cfg, JSON.stringify({ port: 2 }));
    await waitFor(() => store.children.length >= 2); // respawned after the failure
    process.emit('SIGINT');
    expect(await p).toBe(0);
  });

  it('child crashes are logged; stale and signal deaths handled; SIGKILL escalates', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a);
    try {
      const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'] });
      await waitFor(() => store.children.length >= 1);
      // Reload replaces the live child (SIGTERM recorded for the kill).
      writeFileSync(cfg, JSON.stringify({ port: 2 }));
      await waitFor(() => store.children.length >= 2);
      expect(store.children[0]!.kills[0]).toBe('SIGTERM');
      // The old child's late death stays silent.
      store.children[0]!.emit('exit', 139);
      await new Promise((r) => setTimeout(r, 30));
      expect(errs.length).toBe(0);
      // A real crash logs the code.
      store.children[1]!.emit('exit', 139);
      await waitFor(() => errs.length >= 1);
      expect(String(errs[0]![0])).toContain('139');
      // Signal deaths log the signal, not a code.
      writeFileSync(cfg, JSON.stringify({ port: 3 }));
      await waitFor(() => store.children.length >= 3);
      store.children[2]!.emit('exit', null, 'SIGKILL');
      await waitFor(() => errs.length >= 2);
      expect(String(errs[errs.length - 1]![0])).toContain('SIGKILL');
      // Clean exits stay silent.
      writeFileSync(cfg, JSON.stringify({ port: 4 }));
      await waitFor(() => store.children.length >= 4);
      const m = errs.length;
      store.children[3]!.emit('exit', 0);
      await new Promise((r) => setTimeout(r, 30));
      expect(errs.length).toBe(m);
      // SIGKILL escalation fires after the grace period for trapped children.
      await new Promise((r) => setTimeout(r, 2300));
      expect(store.children[0]!.kills).toEqual(['SIGTERM', 'SIGKILL']);
      process.emit('SIGINT');
      expect(await p).toBe(0);
    } finally {
      console.error = orig;
    }
  });

  it('exit-on-child-error resolves with the child code', async () => {
    const prevExit = process.exitCode;
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    try {
      const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'], exitOnChildError: true });
      await waitFor(() => store.children.length >= 1);
      store.children[0]!.emit('exit', 3);
      expect(await p).toBe(3);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it('exit-on-child-error resolves 1 on signal deaths', async () => {
    const prevExit = process.exitCode;
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    try {
      const p = runWatch({ schema, config: cfg, cmd: ['node', 'server.js'], exitOnChildError: true });
      await waitFor(() => store.children.length >= 1);
      store.children[0]!.emit('exit', null, 'SIGKILL');
      expect(await p).toBe(1);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it('external exit codes resolve the supervisor; listeners do not leak', async () => {
    const prevExit = process.exitCode;
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    try {
      const p = runWatch({ schema, config: cfg });
      await new Promise((r) => setTimeout(r, 150));
      process.exitCode = 5;
      expect(await p).toBe(5);
      expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it('--exit-on-error resolves 1 on invalid reload and restores exitCode', async () => {    const prevExit = process.exitCode;
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    try {
      const p = runWatch({ schema, config: cfg, exitOnError: true });
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(cfg, 'INVALID JSON{{{');
      expect(await p).toBe(1);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it('--once warns about -- cmd and separates invalid(1) from load errors(2)', async () => {
    const dir = localTmp('ts-main');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 5 }));
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a);
    try {
      expect(await runWatch({ schema, config: cfg, once: true, cmd: ['node', 'x.js'] })).toBe(0);
      expect(errs.some((a) => String(a[0]).includes('ignored with --once'))).toBe(true);
    } finally {
      console.error = orig;
    }
    // Raw settings errors (not ConfigError) are usage/load failures -> 2.
    expect(await runWatch({ schema, config: 'bad\0path.json', once: true })).toBe(2);
  });

  it('once exercises every option branch (empty config, strict, no-expand, concat, prefix)', async () => {
    const { withOverrides } = await import('../src/index.js');
    const scrub: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v?.includes('$')) scrub[k] = undefined;
    }
    await withOverrides(scrub, async () => {
      const dir = localTmp('ts-main');
      const schema = join(dir, 'schema.ts');
      writeFileSync(schema, SCHEMA_TS);
      expect(
        await runWatch({ schema, config: '', once: true, strict: true, expand: false, array: 'concat', prefix: 'APP_' } as never),
      ).toBe(0);
      // Omitted config falls back to .env,env inside runWatch.
      expect(await runWatch({ schema, once: true })).toBe(0);
    });
  });

  it('SIGTERM shuts down like SIGINT; kill failures are swallowed', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const p = runWatch({ schema, config: cfg, strict: true, expand: false, array: 'concat', prefix: 'APP_', cmd: ['node', 's.js'] });
    await waitFor(() => store.children.length >= 1);
    const child = store.children[store.children.length - 1]!;
    child.kill = () => {
      throw new Error('kill ESRCH');
    };
    process.emit('SIGTERM');
    expect(await p).toBe(0);
  });

  it('escalation kill failures are swallowed, never crash the supervisor', async () => {
    const dir = localTmp('ts-watch2');
    const schema = join(dir, 'schema.ts');
    writeFileSync(schema, SCHEMA_TS);
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const p = runWatch({ schema, config: cfg, cmd: ['node', 's.js'] });
    await waitFor(() => store.children.length >= 1);
    const child = store.children[0]!;
    child.kill = () => {
      throw new Error('kill ESRCH');
    };
    // Reload replaces the child (immediate kill throws, swallowed), then the
    // 2s escalation kill throws too — both must stay silent.
    writeFileSync(cfg, JSON.stringify({ port: 2 }));
    await waitFor(() => store.children.length >= 2);
    await new Promise((r) => setTimeout(r, 2300));
    process.emit('SIGINT');
    expect(await p).toBe(0);
  });

  it('long-run with explicit empty config uses .env,env defaults', async () => {
    const { withOverrides } = await import('../src/index.js');
    const scrub: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v?.includes('$')) scrub[k] = undefined;
    }
    await withOverrides(scrub, async () => {
      const dir = localTmp('ts-watch2');
      const schema = join(dir, 'schema.ts');
      writeFileSync(schema, SCHEMA_TS);
      const p = runWatch({ schema, config: '' });
      await new Promise((r) => setTimeout(r, 100));
      process.emit('SIGTERM');
      expect(await p).toBe(0);
    });
  });
});
