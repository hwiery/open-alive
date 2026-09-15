import { createConnection } from 'node:net';

const PROBE_TIMEOUT_MS = 500;

/**
 * Whether something already accepts TCP connections on `host:port`.
 *
 * Binding is not a reliable test: on macOS a server can bind 127.0.0.1:3141
 * while another process holds *:3141, and both then run — hook events silently
 * go to whichever one the kernel picks. A connect probe sees the other server.
 */
export function isPortInUse(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const finish = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
