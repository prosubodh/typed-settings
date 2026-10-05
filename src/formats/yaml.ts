import { parseAllDocuments } from 'yaml';

/**
 * Single-doc YAML parse (1.2, duplicate keys rejected). A trailing lone `---`
 * still parses; multi-doc payloads, bad indentation, and unresolvable aliases
 * throw `ParseError` naming the source. Explicit `null` reads as `{}`.
 */
export function parseYamlText(text: string, from = 'yaml'): unknown {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!stripped.trim()) return {};
  // Drop empty trailing documents (e.g. a lone trailing `---` separator, which the
  // YAML parser reports as a null-content document) so single-doc payloads with
  // a trailing separator still parse. An explicitly `null` doc also folds to {}.
  const docs = parseAllDocuments(stripped, {
    version: '1.2',
    uniqueKeys: true,
  } as never).filter((d) => {
    if (d.errors.length > 0) return true;
    try {
      const v = d.toJS() as unknown;
      return v !== null && v !== undefined;
    } catch {
      return true;
    }
  });
  if (docs.length === 0) return {};
  if (docs.length > 1) {
    throw new Error(`ParseError (${from}): multi-doc YAML not supported (got ${docs.length} documents)`);
  }
  const doc = docs[0]!;
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    /* v8 ignore next 1 -- yaml parser errors always carry linePos in practice; the '?' is defensive */
    const line = first.linePos?.[0]?.line ?? '?';
    throw new Error(`ParseError (${from}:${line}): ${first.message}`);
  }
  let value: unknown;
  try {
    value = doc.toJS() as unknown;
  } catch (e) {
    // Unresolvable aliases / circular structures surface here, not in doc.errors.
    throw new Error(`ParseError (${from}): ${(e as Error).message}`);
  }
  // The filter above guarantees a non-null value (error docs throw first).
  return value;
}
