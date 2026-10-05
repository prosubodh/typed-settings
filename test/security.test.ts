import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, ConfigError } from '../src/index.js';
import { redactValue } from '../src/errors.js';

const SECRET = 'sk-live-abc123XYZ789';

describe('secret redaction', () => {
  it('redactValue masks long secrets, fully hides short ones', () => {
    expect(redactValue('apiKey', SECRET)).toContain('***');
    expect(redactValue('apiKey', SECRET)).not.toContain(SECRET);
    expect(redactValue('token', 'short')).toBe('(redacted)');
    expect(redactValue('port', '3000')).toBe('3000'); // non-secret keys untouched
  });

  it('ConfigError for secret paths never contains the raw value', () => {
    const schema = z.object({ apiKey: z.string().min(100) });
    try {
      settings({ schema, sources: [{ map: { APIKEY: SECRET } }], env: {}, expand: false, coerce: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET);
      expect(msg).toContain('(redacted)');
    }
  });

  it('value-echoing messages are scrubbed (raw + base64)', () => {
    const schema = z.object({
      apiKey: z.string().refine((v) => v === 'never-matches', { message: `saw ${SECRET}` }),
    });
    try {
      settings({ schema, sources: [{ map: { APIKEY: SECRET } }], env: {}, expand: false, coerce: false } as never);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET);
      const b64 = Buffer.from(SECRET, 'utf8').toString('base64');
      expect(msg).not.toContain(b64);
    }
  });

  it('non-secret failures are unaffected', () => {
    const schema = z.object({ port: z.coerce.number() });
    try {
      settings({ schema, sources: [{ map: { PORT: 'abc' } }], env: {}, expand: false });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('(redacted)');
    }
  });
});
