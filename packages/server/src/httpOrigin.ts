/**
 * Cross-site request gate for the HTTP API.
 *
 * Loopback binding keeps the network out, not the browser. Any page the user
 * visits can `fetch('http://127.0.0.1:3141/api/tickets', { method: 'POST' })`
 * with a CORS-safelisted Content-Type: no preflight is sent, the request arrives
 * from a loopback address, and the access gate treats it as the user. CORS only
 * hides the response — the ticket has already started. The WebSocket upgrade
 * has had an Origin check (wsOrigin.ts); this is the same check for HTTP.
 *
 * DNS rebinding defeats an Origin check alone: a page on `evil.example` that
 * re-resolves to 127.0.0.1 is same-origin with itself. In local mode the server
 * is only ever addressed as a loopback host, so the Host header closes that.
 */
import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const EXTENSION_PROTOCOLS: ReadonlySet<string> = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
]);
/** The one route the prompt-capture browser extension posts to (prompt-agent). */
const EXTENSION_INGEST_PATH = '/v1/ingest/web';
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CrossSiteInput {
  headers: IncomingHttpHeaders;
  method: string;
  pathname: string;
  /** True unless remote mode is on — the server is then only reachable as localhost. */
  loopbackOnly: boolean;
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

export function isCrossSiteRequest(input: CrossSiteInput): boolean {
  const { headers, method, pathname, loopbackOnly } = input;
  const host = headers.host;

  if (loopbackOnly && host !== undefined) {
    const name = hostnameOf(host);
    if (name === null || !LOOPBACK_HOSTNAMES.has(name)) return true;
  }

  const origin = headers.origin;
  if (origin === undefined) {
    // Native clients (hook script, CLI) send neither header. A cross-site link
    // that opens the dashboard is a safe GET and stays allowed.
    return !SAFE_METHODS.has(method) && headers['sec-fetch-site'] === 'cross-site';
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return true; // includes the opaque "null" origin
  }
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  if (EXTENSION_PROTOCOLS.has(parsed.protocol)) return pathname !== EXTENSION_INGEST_PATH;
  // Remote mode: the dashboard this server served, loaded by its LAN/tunnel name.
  if (!loopbackOnly && host !== undefined && parsed.host === host) return false;
  return true;
}
