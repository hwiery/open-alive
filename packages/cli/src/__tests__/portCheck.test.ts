import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPortInUse } from '../portCheck.js';

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

describe('isPortInUse', () => {
  it('sees a server that is already listening', async () => {
    const { server, port } = await listen();
    try {
      expect(await isPortInUse(port)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('reports a closed port as free', async () => {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortInUse(port)).toBe(false);
  });
});
