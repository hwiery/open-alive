import { describe, expect, it } from 'vitest';
import { isCrossSiteRequest, type CrossSiteInput } from '../httpOrigin.js';

function check(overrides: Partial<CrossSiteInput> & { headers?: CrossSiteInput['headers'] }): boolean {
  return isCrossSiteRequest({
    method: 'POST',
    pathname: '/api/tickets',
    loopbackOnly: true,
    ...overrides,
    headers: { host: '127.0.0.1:3141', ...overrides.headers },
  });
}

describe('isCrossSiteRequest', () => {
  it('allows native clients that send no Origin', () => {
    expect(check({})).toBe(false);
  });

  it('allows the dashboard on any loopback origin', () => {
    expect(check({ headers: { origin: 'http://localhost:5173' } })).toBe(false);
    expect(check({ headers: { origin: 'http://127.0.0.1:3141' } })).toBe(false);
    expect(check({ headers: { host: '[::1]:3141', origin: 'http://[::1]:3141' } })).toBe(false);
  });

  it('refuses a foreign origin', () => {
    expect(check({ headers: { origin: 'https://evil.example' } })).toBe(true);
  });

  it('refuses the opaque null origin', () => {
    expect(check({ headers: { origin: 'null' } })).toBe(true);
  });

  it('refuses an unsafe cross-site request that hides its Origin', () => {
    expect(check({ headers: { 'sec-fetch-site': 'cross-site' } })).toBe(true);
  });

  it('allows a cross-site link that opens the dashboard', () => {
    expect(check({ method: 'GET', pathname: '/', headers: { 'sec-fetch-site': 'cross-site' } })).toBe(false);
  });

  it('refuses a DNS-rebound host in local mode', () => {
    expect(check({ headers: { host: 'evil.example:3141', origin: 'http://evil.example:3141' } })).toBe(true);
    expect(check({ method: 'GET', headers: { host: 'evil.example:3141' } })).toBe(true);
  });

  it('lets the browser extension reach only its ingest route', () => {
    const origin = 'chrome-extension://abcdefghijklmnop';
    expect(check({ pathname: '/v1/ingest/web', headers: { origin } })).toBe(false);
    expect(check({ pathname: '/api/tickets', headers: { origin } })).toBe(true);
  });

  it('allows the same-origin dashboard in remote mode', () => {
    expect(
      check({ loopbackOnly: false, headers: { host: '192.0.2.10:3141', origin: 'http://192.0.2.10:3141' } }),
    ).toBe(false);
    expect(
      check({ loopbackOnly: false, headers: { host: '192.0.2.10:3141', origin: 'https://evil.example' } }),
    ).toBe(true);
  });
});
