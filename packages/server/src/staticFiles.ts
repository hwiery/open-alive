import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Resolve the UI dist directory.
 *
 * Called at handler-construction time (not module-load time) so the env var
 * override `__OPEN_ALIVE_UI_DIST` is read late. The npm bundle's server
 * entry sets this var before importing the server, but ESM `import` hoisting
 * means the import runs first when both live in a single esbuild bundle —
 * a top-level `const X = process.env.FOO ?? ...` captured the wrong value
 * and the dashboard 404'd on `/` (hitting the JSON router fallback instead
 * of the static index.html).
 */
function resolveUiDistDir(override?: string): string {
  if (override) return override;
  if (process.env.__OPEN_ALIVE_UI_DIST) return process.env.__OPEN_ALIVE_UI_DIST;
  return resolve(__dirname, '..', '..', 'ui', 'dist');
}

export function createStaticHandler(uiDistPath?: string) {
  // Resolve lazily on first request so npm-bundle env var assignments that run
  // after the import chain (a side-effect of ESM hoisting in esbuild bundles)
  // are still picked up. Cached after first hit — env doesn't change at runtime.
  let cachedDistDir: string | null = null;
  const getDistDir = (): string => {
    if (cachedDistDir === null) cachedDistDir = resolveUiDistDir(uiDistPath);
    return cachedDistDir;
  };

  return async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const distDir = getDistDir();
    const filePath = resolve(distDir, pathname === '/' ? 'index.html' : '.' + pathname);
    // Separator-anchored, so a sibling like `dist-other/` does not pass.
    if (!filePath.startsWith(distDir.endsWith(sep) ? distDir : distDir + sep)) return false;

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControlFor(pathname, ext) });
      res.end(data);
      return true;
    } catch {
      // A missing file under /assets/ is a stale reference — usually a page
      // loaded before an update asking for the previous build's chunk. Answering
      // it with index.html (200, text/html) made the browser refuse the "script"
      // and left a blank screen; a real 404 lets the page recover by reloading.
      if (isAssetPath(pathname)) return false;
      // Other unknown paths are client-side routes: serve the SPA shell.
      if (pathname !== '/' && pathname !== '/index.html') {
        try {
          const indexData = await readFile(join(getDistDir(), 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_CACHE });
          res.end(indexData);
          return true;
        } catch {
          // index.html not found either — UI not built
          return false;
        }
      }
      return false;
    }
  };
}

/** The shell must be revalidated every load so an update is picked up at once. */
const NO_CACHE = 'no-cache';
/** Vite emits content-hashed files under /assets/: safe to keep for good. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith('/assets/');
}

export function cacheControlFor(pathname: string, ext: string): string {
  if (ext === '.html') return NO_CACHE;
  return isAssetPath(pathname) ? IMMUTABLE : NO_CACHE;
}
