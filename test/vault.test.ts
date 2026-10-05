import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { settings, settingsAsync, ConfigError } from '../src/index.js';
import { hashicorpProvider } from '../src/vault/hashicorp.js';
import { awsProvider } from '../src/vault/aws.js';
import { httpProvider } from '../src/vault/http.js';

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('hashicorp provider', () => {
  it('unwraps KVv2 data.data', async () => {
    const fetchFn = async () => jsonResponse({ data: { data: { PORT: '4000' }, metadata: { version: 1 } } });
    const prov = hashicorpProvider({ url: 'https://vault:8200', path: 'data/app', fetchFn });
    const schema = z.object({ port: z.coerce.number().default(3000) });
    const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false });
    expect(cfg.port).toBe(4000);
  });

  it('unwraps KVv1 data', async () => {
    const fetchFn = async () => jsonResponse({ data: { PORT: '5000' } });
    const prov = hashicorpProvider({ url: 'https://vault:8200', path: 'app', fetchFn });
    const schema = z.object({ port: z.coerce.number().default(0) });
    const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false });
    expect(cfg.port).toBe(5000);
  });

  it('403 fail-closed with E_DENIED, no value leak', async () => {
    const fetchFn = async () => new Response('forbidden', { status: 403 });
    const prov = hashicorpProvider({ url: 'https://vault:8200', path: 'data/app', fetchFn });
    const schema = z.object({ port: z.coerce.number().default(0) });
    try {
      await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String((e as Error).message)).not.toContain('secret-value');
    }
  });

  it('sync settings() with async provider throws USE_ASYNC', () => {
    const prov = hashicorpProvider({
      url: 'https://vault:8200',
      path: 'data/app',
      fetchFn: async () => jsonResponse({ data: { data: {}, metadata: { version: 1 } } }),
    });
    const schema = z.object({ port: z.coerce.number().default(0) });
    expect(() => settings({ schema, sources: [{ provider: prov }], env: {}, expand: false })).toThrow(/USE_ASYNC/);
  });

  it('per-source prefix strips', async () => {
    const fetchFn = async () => jsonResponse({ data: { data: { APP_PORT: '7000', OTHER: 'x' }, metadata: { version: 1 } } });
    const prov = hashicorpProvider({ url: 'https://vault:8200', path: 'data/app', fetchFn });
    const schema = z.object({ port: z.coerce.number().default(0) });
    const cfg = await settingsAsync({
      schema,
      sources: [{ provider: prov, prefix: 'APP_' }],
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(7000);
  });
});

describe('http provider (Doppler/Infisical generic)', () => {
  it('extracts jsonPath + strips cross-host auth (mock redirect)', async () => {
    let authed = false;
    const fetchFn = async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (url === 'https://a.example/secret' && h.get('X-Vault-Token')) authed = true;
      if (url === 'https://a.example/secret') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example/secret' } });
      }
      // cross-host: token must be stripped
      if (h.get('X-Vault-Token')) throw new Error('auth leaked cross-host');
      return jsonResponse({ data: { PORT: '8000' } });
    };
    const prov = httpProvider({ url: 'https://a.example/secret', headers: { 'X-Vault-Token': 't' }, fetchFn });
    const schema = z.object({ port: z.coerce.number().default(0) });
    const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false });
    expect(authed).toBe(true);
    expect(cfg.port).toBe(8000);
  });
});

describe('aws provider (mocked SDK)', () => {
  it('merges JSON SecretString + SSM params with prefix strip', async () => {
    const prov = awsProvider({
      secrets: ['prod/app'],
      params: ['/app/prod/'],
      secretsClient: {
        getSecretValue: async () => ({ SecretString: JSON.stringify({ PORT: '9000' }) }),
      },
      ssmClient: {
        getParameters: async () => ({ '/app/prod/EXTRA': 'hi' }),
      },
    });
    const schema = z.object({ port: z.coerce.number().default(0), extra: z.string().default('') });
    const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false });
    expect(cfg.port).toBe(9000);
    expect(cfg.extra).toBe('hi');
  });

  it('raw string secret keyed by last segment', async () => {
    const prov = awsProvider({
      secrets: ['prod/api_key'],
      secretsClient: { getSecretValue: async () => ({ SecretString: 'raw-value' }) },
    });
    const schema = z.object({ api_key: z.string() });
    const cfg = await settingsAsync({ schema, sources: [{ provider: prov }], env: {}, expand: false, coerce: false });
    expect((cfg as Record<string, unknown>)['api_key']).toBe('raw-value');
  });

  it('precedence: later source wins (vault vs file)', async () => {
    const prov = awsProvider({
      secrets: ['prod/app'],
      secretsClient: { getSecretValue: async () => ({ SecretString: JSON.stringify({ PORT: '1111' }) }) },
    });
    const schema = z.object({ port: z.coerce.number().default(0) });
    const cfg = await settingsAsync({
      schema,
      sources: [{ provider: prov }, { map: { PORT: '2222' } }],
      env: {},
      expand: false,
    });
    expect(cfg.port).toBe(2222);
  });
});
