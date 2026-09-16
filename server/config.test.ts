import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('config', () => {
  it('applies documented defaults when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe('info');
    expect(config.isProduction).toBe(false);
  });

  it('resolves DATA_DIR to an absolute path', () => {
    const config = loadConfig({ DATA_DIR: './data' });

    expect(isAbsolute(config.dataDir)).toBe(true);
  });

  it('coerces PORT and rejects out-of-range values', () => {
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
  });

  it('fails fast on an unknown LOG_LEVEL and names the offending key', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('validates LOCAL_USER_ID as a canonical lowercase UUID', () => {
    // It is the sole source of the user-directory segment until Phase 4
    // (INV-14), so an invalid value must stop the process at boot rather than
    // reach path construction.
    expect(loadConfig({}).localUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadConfig({ LOCAL_USER_ID: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' }).localUserId).toBe(
      '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'
    );

    for (const invalid of [
      'not-a-uuid',
      '0A1B2C3D-4E5F-4A6B-8C9D-0E1F2A3B4C5D',
      '../../etc/passwd',
      '',
      '0a1b2c3d4e5f4a6b8c9d0e1f2a3b4c5d',
    ]) {
      expect(() => loadConfig({ LOCAL_USER_ID: invalid })).toThrow(/LOCAL_USER_ID/);
    }
  });

  it('never echoes the offending value in the error message', () => {
    // A bad value could be a mistyped secret; only the key is safe to print.
    expect(() => loadConfig({ NODE_ENV: 'sk-live-supersecret' })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sk-live-supersecret') as unknown as string,
      })
    );
  });

  describe('TLS', () => {
    it('is off by default', () => {
      expect(loadConfig({}).tls).toBeNull();
    });

    it('is configured when both cert and key are given', () => {
      const config = loadConfig({
        TLS_CERT_FILE: '/etc/tls/cert.pem',
        TLS_KEY_FILE: '/etc/tls/key.pem',
      });
      expect(config.tls).toEqual({ certFile: '/etc/tls/cert.pem', keyFile: '/etc/tls/key.pem' });
    });

    it('refuses a half-configuration, both ways', () => {
      // The dangerous case: a server meant to be HTTPS coming up on plain HTTP
      // because one variable was mistyped. It must stop the boot instead.
      expect(() => loadConfig({ TLS_CERT_FILE: '/etc/tls/cert.pem' })).toThrow(/both/i);
      expect(() => loadConfig({ TLS_KEY_FILE: '/etc/tls/key.pem' })).toThrow(/both/i);
    });
  });
});

/**
 * Settings that are present but empty.
 *
 * Compose writes `KEY: ${KEY:-}` for anything optional, and an `.env` line with
 * nothing after the `=` is how an operator leaves a value out. Both arrive as
 * the empty string. Read as a deliberate value, they stop the server from
 * booting at all — which is what a fresh `docker compose up` did, on a
 * provider key nobody had set.
 */
describe('an optional setting left empty', () => {
  it('reads an empty LLAMA_API_KEY as no key at all', () => {
    expect(loadConfig({ LLAMA_API_KEY: '' }).provider.apiKey).toBeUndefined();
  });

  it('reads whitespace the same way', () => {
    expect(loadConfig({ LLAMA_API_KEY: '   ' }).provider.apiKey).toBeUndefined();
  });

  it('still carries a key that was actually set, trimmed', () => {
    expect(loadConfig({ LLAMA_API_KEY: ' secret ' }).provider.apiKey).toBe('secret');
  });

  it('reads empty TLS paths as no TLS, rather than as half of it', () => {
    expect(loadConfig({ TLS_CERT_FILE: '', TLS_KEY_FILE: '' }).tls).toBeNull();
  });

  /** The half-configured case must still be refused; that check is the point. */
  it('still refuses a certificate with no key', () => {
    expect(() => loadConfig({ TLS_CERT_FILE: '/tls/cert.pem', TLS_KEY_FILE: '' })).toThrow(/both/i);
  });

  /**
   * An empty base URL is "no provider named", not a malformed one.
   *
   * `${LLAMA_BASE_URL:-}` is how the compose file says an operator has not set
   * it, and `.default()` only covers a key that is absent altogether — so
   * without this the shipped compose file refused to boot, on a variable
   * nobody had touched.
   */
  it('treats an empty LLAMA_BASE_URL as unset rather than as an invalid URL', () => {
    const config = loadConfig({ LLAMA_BASE_URL: '' });

    expect(config.provider.baseUrl).toBe('http://127.0.0.1:8080');
    expect(config.providerConfigured).toBe(false);
  });

  it('marks a base URL the operator actually set as configured', () => {
    const config = loadConfig({ LLAMA_BASE_URL: 'http://llama:8080' });

    expect(config.provider.baseUrl).toBe('http://llama:8080');
    expect(config.providerConfigured).toBe(true);
  });

  it('still refuses a base URL that is set and malformed', () => {
    expect(() => loadConfig({ LLAMA_BASE_URL: 'not-a-url' })).toThrow();
  });

  /**
   * The whole compose environment, exactly as shipped, with no .env present:
   * every optional variable interpolates to the empty string.
   */
  it('boots on the environment the compose file sets with no .env file', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '3001',
      DATA_DIR: '/data',
      LLAMA_BASE_URL: '',
      LLAMA_API_KEY: '',
      TRUST_PROXY_HOPS: '0',
    });

    expect(config.port).toBe(3001);
    expect(config.provider.apiKey).toBeUndefined();
    expect(config.providerConfigured).toBe(false);
    expect(config.trustProxyHops).toBe(0);
  });
});
