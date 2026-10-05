/** One validation failure: the key path, the winning source, and what went wrong. */
export interface ConfigIssue {
  path: string;
  from: string;
  message: string;
}

const SECRET_RE = /key|secret|token|password|private/i;

/**
 * Renders a value for error messages. Secret-looking keys (`key|secret|token|
 * password|private`) never leak: short values collapse to `(redacted)`, longer
 * ones to a `abc-*** (N chars)` shape.
 */
export function redactValue(key: string, value: unknown): string {
  if (SECRET_RE.test(key) && typeof value === 'string' && value.length > 0) {
    if (value.length <= 8) return '(redacted)';
    return `${value.slice(0, 3)}-*** (${value.length} chars)`;
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
  constructor(issues: ConfigIssue[], code = 'E_INVALID_CONFIG') {
    const lines = issues.map(
      (i) => `- ${i.path} (from ${i.from}): ${i.message}`,
    );
    super(`Invalid config (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`);
    this.name = 'ConfigError';
    this.code = code;
    this.issues = issues;
  }
}
