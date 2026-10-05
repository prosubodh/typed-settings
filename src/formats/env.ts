// Minimal POSIX .env parser per spec v0.1.1 section 6.
// Supports: `export ` prefix strip (one), first `=`, `#` comment only when
// preceded by whitespace outside quotes, `''` literal / `""` with \n + multiline.

/**
 * Parses dotenv text into a flat map. Strips one BOM, joins multiline
 * double-quoted values, lets the last duplicate win. Throws `ParseError` on
 * backticks, unterminated quotes, bare keys, and empty keys.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip single BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = splitLogicalLines(text);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(`ParseError: bare key without '=': ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, eq).trim();
    let rest = line.slice(eq + 1).trimStart();
    if (!key) throw new Error('ParseError: empty key');
    out[key] = parseValue(rest);
  }
  return out;
}

function splitLogicalLines(text: string): string[] {
  // Handle multiline double-quoted values: keep consuming until closing quote.
  const physical = text.split(/\r?\n/);
  const out: string[] = [];
  let buf = '';
  let inDouble = false;
  for (const pl of physical) {
    if (!inDouble) {
      // Detect unclosed double quote
      const opens = countUnescapedQuotes(pl);
      if (opens % 2 === 1 && isValueStartDoubleQuoted(pl)) {
        buf = pl;
        inDouble = true;
      } else {
        out.push(pl);
      }
    } else {
      buf += '\n' + pl;
      const opens = countUnescapedQuotes(buf.split('=').slice(1).join('='));
      if (opens % 2 === 0) {
        inDouble = false;
        out.push(buf);
        buf = '';
      }
    }
  }
  if (inDouble) throw new Error('ParseError: unterminated double-quoted value');
  // NOTE: `buf` is always '' here (it is cleared whenever inDouble flips false).
  return out;
}

function isValueStartDoubleQuoted(line: string): boolean {
  const eq = line.indexOf('=');
  if (eq === -1) return false;
  const rest = line.slice(eq + 1).trimStart();
  return rest.startsWith('"') && !rest.endsWith('"');
}

function countUnescapedQuotes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') n++;
  }
  return n;
}

function parseValue(rest: string): string {
  if (!rest) return '';
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1) throw new Error('ParseError: unterminated single-quoted value');
    // '' literal, no escapes, trailing must be comment/empty
    return rest.slice(1, end);
  }
  if (rest.startsWith('"')) {
    // Find closing unescaped quote
    let i = 1;
    let val = '';
    while (i < rest.length) {
      const c = rest[i];
      if (c === '\\' && i + 1 < rest.length) {
        const n = rest[i + 1];
        if (n === 'n') val += '\n';
        else if (n === 'r') val += '\r';
        else if (n === 't') val += '\t';
        else val += n;
        i += 2;
        continue;
      }
      if (c === '"') break;
      val += c;
      i++;
    }
    if (rest[i] !== '"') throw new Error('ParseError: unterminated double-quoted value');
    return val;
  }
  if (rest.startsWith('`')) throw new Error('ParseError: backtick values not supported');
  // Unquoted: strip trailing comment gated on whitespace
  const hash = findCommentStart(rest);
  const v = (hash === -1 ? rest : rest.slice(0, hash)).trim();
  return v;
}

function findCommentStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) return i;
  }
  return -1;
}
