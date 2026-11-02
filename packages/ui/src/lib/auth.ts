/**
 * Client-side half of remote access.
 *
 * With remote mode on, the server stops treating a loopback address as
 * authentication, so every call from this page needs a bearer token — including
 * the ones made from the machine running the server. The token reaches the page
 * one of two ways: `open-alive start` opens the dashboard with `?token=…`
 * once, or the user pastes a device token into the prompt.
 *
 * The header is attached by wrapping `fetch` rather than by editing all
 * forty-odd call sites. That keeps this cross-cutting concern in one file and,
 * more importantly, makes it impossible for a new call site to forget it — the
 * failure mode of the alternative is a route that works locally and 401s only
 * once someone turns remote mode on.
 */

export const TOKEN_STORAGE_KEY = 'open-alive.token';
const WS_TOKEN_PROTOCOL_PREFIX = 'open-alive.token.';

export interface TokenStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** A private window (or a browser blocking site data) throws on access. */
function browserStorage(): TokenStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What a token may contain. Generated tokens are base64url; the value also
 * travels as a WebSocket subprotocol, where a space, a non-ASCII character or
 * most punctuation makes the browser throw ("An invalid or illegal string was
 * specified") and the whole app stops before it renders.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function readStoredToken(storage: TokenStorage | null = browserStorage()): string | null {
  try {
    const token = storage?.getItem(TOKEN_STORAGE_KEY) ?? null;
    if (token !== null && !isValidToken(token)) {
      // Left over from an earlier paste: unusable, and fatal to the WebSocket.
      storage?.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function storeToken(token: string | null, storage: TokenStorage | null = browserStorage()): void {
  try {
    if (token && isValidToken(token)) storage?.setItem(TOKEN_STORAGE_KEY, token);
    else storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage denied: the token still works for this page load, held by the
    // module-level cache in installAuthFetch's reader.
  }
}

/** The subset of `window.location` this module reads. */
export interface LocationLike {
  search: string;
  pathname: string;
  hash: string;
}

/**
 * Take `?token=` out of the URL, persist it, and rewrite the address bar.
 *
 * The strip matters: a URL with a live credential in it gets bookmarked,
 * screenshotted and pasted into chat.
 */
export function adoptUrlToken(
  location: LocationLike = window.location,
  history: History = window.history,
  storage: TokenStorage | null = browserStorage(),
): string | null {
  // `#token=` (the mobile QR) never reaches the server or its logs; `?token=`
  // is what `open-alive start` opens with. Both are adopted and stripped.
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const params = new URLSearchParams(location.search);
  const fromHash = hash.get('token');
  const fromQuery = params.get('token');
  const token = fromHash ?? fromQuery;
  if (!token) return readStoredToken(storage);
  storeToken(token, storage);
  params.delete('token');
  hash.delete('token');
  const query = params.toString();
  const rest = hash.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${rest ? `#${rest}` : ''}`);
  return token;
}

/**
 * A browser cannot set headers on a WebSocket, so the token rides the
 * subprotocol list; the server echoes it back to complete the handshake.
 */
export function wsProtocols(token: string | null = readStoredToken()): string[] | undefined {
  return token && isValidToken(token) ? [`${WS_TOKEN_PROTOCOL_PREFIX}${token}`] : undefined;
}

/**
 * Set just before the token prompt reloads the page. The app guards reloads
 * with a `beforeunload` prompt so an accidental Cmd-R cannot tear down live
 * terminals — but at this exact moment there is nothing live to lose (the app
 * never authenticated), and asking "leave site?" in the middle of signing in
 * reads like the sign-in failed.
 */
let reloadingForAuth = false;

export function beginAuthReload(): void {
  reloadingForAuth = true;
}

export function isAuthReloading(): boolean {
  return reloadingForAuth;
}

type AuthFailureListener = () => void;
const authFailureListeners = new Set<AuthFailureListener>();

/** Notified when the server answers 401 — the app then asks for a token. */
export function onAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

/** Same-origin only: the token is for this server and must not leak elsewhere. */
function isSameOrigin(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/^[a-z]+:\/\//i.test(raw)) return true;
  try {
    return new URL(raw).origin === window.location.origin;
  } catch {
    return false;
  }
}

export interface FetchHost {
  fetch: typeof fetch;
}

export function installAuthFetch(
  host: FetchHost = window as unknown as FetchHost,
  token: () => string | null = () => readStoredToken(),
): void {
  const original = host.fetch.bind(host);
  host.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const value = token();
    let nextInit = init;
    if (value && isSameOrigin(input)) {
      const headers = new Headers(init?.headers);
      // An explicit header wins: a caller that set one meant it.
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${value}`);
      nextInit = { ...init, headers };
    }
    const response = await original(input, nextInit);
    if (response.status === 401) {
      for (const listener of authFailureListeners) listener();
    }
    return response;
  };
}
