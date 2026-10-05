/**
 * Strict JSON parse (BOM-tolerant, blank reads as `{}`). Failures throw
 * `ParseError` naming the source for attribution.
 */
export function parseJsonText(text: string, from = 'json'): unknown {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!stripped.trim()) return {};
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const err = e as Error;
    throw new Error(`ParseError (${from}): ${err.message}`);
  }
}
