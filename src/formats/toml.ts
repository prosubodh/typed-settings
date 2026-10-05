import { parse as parseToml } from 'smol-toml';

/**
 * TOML parse via smol-toml (duplicate keys rejected). Blank reads as `{}`;
 * failures throw `ParseError` naming the source.
 */
export function parseTomlText(text: string, from = 'toml'): unknown {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!stripped.trim()) return {};
  try {
    // smol-toml v1 validates duplicate keys and throws TomlError
    return parseToml(stripped);
  } catch (e) {
    const err = e as Error;
    throw new Error(`ParseError (${from}): ${err.message}`);
  }
}
