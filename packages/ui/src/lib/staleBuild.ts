/**
 * After an update the server only has the new build's files. A tab opened
 * before it still asks for the old chunks when a lazy view first opens, and
 * that import fails. Reload once to pick up the new build; the timestamp guard
 * stops a reload loop if the failure is something else.
 */
const KEY = 'open-alive:stale-build-reload';
const MIN_INTERVAL_MS = 30_000;

export function shouldReloadForStaleBuild(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt > MIN_INTERVAL_MS;
}

export function installStaleBuildReload(win: Window = window): void {
  win.addEventListener('vite:preloadError', (event) => {
    let last: number | null = null;
    try {
      const raw = win.sessionStorage.getItem(KEY);
      last = raw ? Number(raw) : null;
    } catch {
      // storage blocked: treat as never reloaded
    }
    const now = Date.now();
    if (!shouldReloadForStaleBuild(last, now)) return;
    event.preventDefault();
    try {
      win.sessionStorage.setItem(KEY, String(now));
    } catch {
      // storage blocked: the interval guard is best-effort
    }
    win.location.reload();
  });
}
