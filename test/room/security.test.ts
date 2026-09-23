import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listenHost, loadConfig } from '../../src/server/config.ts';
import { isInside } from '../../src/server/http/app.ts';
import { clientAddress, DEVELOPMENT_CSP, PRODUCTION_CSP, tokensEqual } from '../../src/server/http/security.ts';

describe('clientAddress', () => {
  const peer = '10.1.2.3';
  const xff = (value: string | string[]) => ({ remoteAddress: peer, headers: { 'x-forwarded-for': value } });

  it('uses the raw peer when no proxy is trusted, whatever the headers say', () => {
    expect(clientAddress(xff('1.1.1.1'), 0)).toBe(peer);
    expect(clientAddress({ remoteAddress: '::ffff:192.0.2.1', headers: {} }, 0)).toBe('192.0.2.1');
  });

  it('trusts exactly n hops of X-Forwarded-For (Express semantics)', () => {
    expect(clientAddress(xff('198.51.100.7'), 1)).toBe('198.51.100.7');
    expect(clientAddress(xff('6.6.6.6, 198.51.100.7'), 1)).toBe('198.51.100.7'); // the spoofed left entry is ignored
    expect(clientAddress(xff('6.6.6.6, 198.51.100.7, 172.16.0.2'), 2)).toBe('198.51.100.7');
    expect(clientAddress(xff(['6.6.6.6', '198.51.100.7']), 1)).toBe('198.51.100.7');
  });

  it('strips ports and brackets, and stops at garbage', () => {
    expect(clientAddress(xff('198.51.100.7:4567'), 1)).toBe('198.51.100.7');
    expect(clientAddress(xff('[2001:db8::1]:443'), 1)).toBe('2001:db8::1');
    expect(clientAddress(xff('evil, not-an-ip'), 2)).toBe(peer);
    expect(clientAddress(xff('198.51.100.7, junk'), 2)).toBe(peer);
  });

  it('falls back to the furthest address when the chain is shorter than the hop count', () => {
    expect(clientAddress(xff('198.51.100.7'), 3)).toBe('198.51.100.7');
    expect(clientAddress({ remoteAddress: peer, headers: {} }, 2)).toBe(peer);
  });
});

describe('CSP', () => {
  it('is exactly the ARCHITECTURE §11.5 policy in production', () => {
    expect(PRODUCTION_CSP).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-eval' blob: data:; worker-src 'self' blob: data:; connect-src 'self' https://raw.githubusercontent.com; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
  });

  it('only relaxes what Vite HMR needs in development', () => {
    expect(DEVELOPMENT_CSP).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(DEVELOPMENT_CSP).toContain("connect-src 'self' ws: wss: https://raw.githubusercontent.com");
    expect(DEVELOPMENT_CSP).toContain("default-src 'none'");
    expect(DEVELOPMENT_CSP).toContain("frame-ancestors 'none'");
  });
});

describe('tokensEqual', () => {
  it('compares any lengths without throwing', () => {
    expect(tokensEqual('secret-token-123456', 'secret-token-123456')).toBe(true);
    expect(tokensEqual('secret-token-123456', 'secret-token-12345')).toBe(false);
    expect(tokensEqual('', 'x')).toBe(false);
  });
});

describe('loadConfig', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'bside-config-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('has the documented defaults', () => {
    const dataDir = tmp();
    const c = loadConfig({ BSIDE_DATA_DIR: dataDir }, []);
    expect(c).toMatchObject({
      port: 3000,
      dev: true,
      dataDir,
      driver: 'scripted',
      model: 'claude-opus-5',
      effort: { section: 'medium', movement: 'high' },
      maxPlansPerHour: 90,
      maxApiCallsPerPlan: 8,
      adminToken: null,
      trustProxy: 0,
      ipv6Prefix: 48,
      sourceUrl: 'https://github.com/jciech/claude-bside',
    });
    expect(c.catalogPath).toMatch(/palette[/\\]catalog\.json$/);
    expect(c.maxSocketsPerNetwork).toBeGreaterThan(0);
  });

  it('is development unless NODE_ENV=production, and --dev forces development', () => {
    const dataDir = tmp();
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, NODE_ENV: 'production' }, []).dev).toBe(false);
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, NODE_ENV: 'production' }, ['--dev']).dev).toBe(true);
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, NODE_ENV: 'test' }, []).dev).toBe(true);
  });

  it('generates the token secret once, persists it privately, and reuses it', () => {
    const dataDir = join(tmp(), 'nested', 'data');
    const first = loadConfig({ BSIDE_DATA_DIR: dataDir }, []).secret;
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir }, []).secret).toBe(first);
    const file = join(dataDir, 'secret.key');
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_SECRET: 'an-explicit-secret-value' }, []).secret).toBe('an-explicit-secret-value');
  });

  it('picks the driver from the key and BSIDE_COMPOSER', () => {
    const dataDir = tmp();
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'sk-x' }, []).driver).toBe('claude');
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'sk-x', BSIDE_COMPOSER: 'external' }, []).driver).toBe('external');
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_COMPOSER: 'claude' }, []).driver).toBe('scripted');
  });

  it('reads the operational knobs', () => {
    const c = loadConfig(
      {
        BSIDE_DATA_DIR: tmp(),
        PORT: '8080',
        BSIDE_TRUST_PROXY: '1',
        BSIDE_IPV6_PREFIX: '56',
        BSIDE_MAX_SOCKETS_PER_NETWORK: '10',
        BSIDE_ADMIN_TOKEN: '  tok  ',
        BSIDE_MAX_PLANS_PER_HOUR: '30',
        BSIDE_SOURCE_URL: 'https://example.org/src',
        BSIDE_MODEL: 'claude-test',
      },
      [],
    );
    expect(c).toMatchObject({ port: 8080, trustProxy: 1, ipv6Prefix: 56, maxSocketsPerNetwork: 10, adminToken: 'tok', maxPlansPerHour: 30, sourceUrl: 'https://example.org/src', model: 'claude-test' });
  });

  it('fails fast on invalid values and weak production secrets', () => {
    const dataDir = tmp();
    expect(() => loadConfig({ BSIDE_DATA_DIR: dataDir, PORT: 'eighty' }, [])).toThrow(/PORT/);
    expect(() => loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_TRUST_PROXY: '-1' }, [])).toThrow(/BSIDE_TRUST_PROXY/);
    expect(() => loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_COMPOSER: 'gpt' }, [])).toThrow(/BSIDE_COMPOSER/);
    expect(() => loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_SECRET: 'short' }, [])).toThrow(/BSIDE_SECRET/);
    expect(() => loadConfig({ BSIDE_DATA_DIR: dataDir, NODE_ENV: 'production', BSIDE_ADMIN_TOKEN: 'change-me' }, [])).toThrow(/BSIDE_ADMIN_TOKEN/);
    expect(loadConfig({ BSIDE_DATA_DIR: dataDir, BSIDE_ADMIN_TOKEN: 'change-me' }, []).adminToken).toBe('change-me');
  });
});

describe('deployment guards', () => {
  it('detects a data dir inside a served root', () => {
    expect(isInside('/srv/app/palette/data', '/srv/app/palette')).toBe(true);
    expect(isInside('/srv/app/palette', '/srv/app/palette')).toBe(true);
    expect(isInside('/srv/app/data', '/srv/app/palette')).toBe(false);
    expect(isInside('/srv/app/palette-data', '/srv/app/palette')).toBe(false);
    expect(isInside('/srv/app/palette/../data', '/srv/app/palette')).toBe(false);
  });

  it('listens on loopback in development unless BSIDE_HOST says otherwise', () => {
    expect(listenHost({}, { dev: true })).toBe('localhost');
    expect(listenHost({}, { dev: false })).toBeUndefined();
    expect(listenHost({ BSIDE_HOST: '0.0.0.0' }, { dev: true })).toBe('0.0.0.0');
  });
});
