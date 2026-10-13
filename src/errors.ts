/** One validation failure: the key path, the winning source, and what went wrong. */
export interface ConfigIssue {
  path: string;
  from: string;
  message: string;
}

const SECRET_RE = /key|secret|token|password|private/i;

/** Tests a key path against the default secret pattern plus custom matchers. */
export function isSecretKey(key: string, extra?: (string | RegExp)[]): boolean {
  if (SECRET_RE.test(key)) return true;
  if (extra) {
    for (const m of extra) {
      if (typeof m === 'string') {
        if (m && key.toLowerCase().includes(m.toLowerCase())) return true;
      } else if (m instanceof RegExp) {
        // Avoid stateful global/sticky regexes giving alternating results.
        m.lastIndex = 0;
        if (m.test(key)) return true;
      } else if (m !== null && typeof m === 'object' && typeof (m as { test?: unknown }).test === 'function') {
        // Duck-typed RegExp: cross-realm (vm contexts, dual CJS/ESM copies) and
        // test doubles fail the instanceof check above — match by capability.
        if ((m as unknown as RegExp).test(key)) return true;
      }
    }
  }
  return false;
}

/**
 * Renders a value for error messages. Secret-looking keys (`key|secret|token|
 * password|private`, plus `extra` matchers) never leak their content: short
 * values collapse to `(redacted)`, longer ones to `(redacted: N chars)`. No
 * prefix fragment survives — even three characters of a secret are too many.
 */
export function redactValue(key: string, value: unknown, extra?: (string | RegExp)[]): string {
  if (isSecretKey(key, extra) && typeof value === 'string' && value.length > 0) {
    if (value.length <= 8) return '(redacted)';
    return `(redacted: ${value.length} chars)`;
  }
  return String(value);
}

/** UTF-8 byte length (Edge-safe: TextEncoder → Buffer → string length fallback). */
export function byteLengthUtf8(text: string): number {
  try {
    const g = globalThis as {
      TextEncoder?: new () => { encode(s: string): { length: number } };
      Buffer?: { byteLength(s: string, e: string): number };
    };
    if (g.TextEncoder) return new g.TextEncoder().encode(text).length;
    if (g.Buffer) return g.Buffer.byteLength(text, 'utf8');
  } catch {
    // fall through
  }
  return text.length;
}

/**
 * Every settings failure. Carries machine-readable `issues` plus a `code`
 * (`E_INVALID_CONFIG` by default, e.g. `E_UNKNOWN_KEY`, `E_TIMEOUT`).
 */
export class ConfigError extends Error {
  code = 'E_INVALID_CONFIG';
  issues: ConfigIssue[];
  /**
   * Structural check so `e instanceof ConfigError` holds across dual-package
   * copies (ESM `dist/index.js` + CJS `dist/index.cjs` loaded together have
   * distinct classes; plain instanceof would miss and misroute error codes).
   */
  static [Symbol.hasInstance](inst: unknown): boolean {
    return (
      typeof inst === 'object' &&
      inst !== null &&
      (inst as ConfigError).name === 'ConfigError' &&
      typeof (inst as ConfigError).code === 'string' &&
      Array.isArray((inst as ConfigError).issues)
    );
  }
  constructor(issues: ConfigIssue[] = [], code = 'E_INVALID_CONFIG') {
    const lines = issues.map(
      (i) => `- ${i.path} (from ${i.from}): ${i.message}`,
    );
    super(
      issues.length === 0
        ? 'Invalid config: unknown error (no issues attached)'
        : `Invalid config (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
    this.name = 'ConfigError';
    this.code = code;
    this.issues = issues;
  }
}
