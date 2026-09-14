/**
 * Server entry point for the npm-published package.
 * Wraps the real server but overrides the UI dist path
 * so it resolves correctly from the bundled location.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __bundleDir = dirname(fileURLToPath(import.meta.url));

// Set env so the server can pick up the correct UI dist path
process.env.__OPEN_ALIVE_UI_DIST = resolve(__bundleDir, '..', 'ui');

// Re-export everything from the real server entry
import '../packages/server/src/index.js';
