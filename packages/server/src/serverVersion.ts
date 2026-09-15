import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'open-alive';
const MAX_DEPTH = 5;

/**
 * Version of the `open-alive` package this server ships in. The root
 * package.json is the single source of truth; it sits three levels up in the
 * workspace (packages/server/dist) and one level up in the npm bundle (dist/).
 */
export function readServerVersion(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      // no package.json here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}
