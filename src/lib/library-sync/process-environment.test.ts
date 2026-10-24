import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { syncWorkerEnvironment } = require('../../../scripts/library-sync-environment.cjs') as {
  syncWorkerEnvironment: (environment: Partial<NodeJS.ProcessEnv>, supported?: boolean) => NodeJS.ProcessEnv;
};

describe('sync process proxy isolation', () => {
  it('keeps the parent and other worker environments unchanged', () => {
    const parent = { LIBRARY_SERVER_PROXY: 'http://127.0.0.1:7897', http_proxy: 'http://old.invalid', NO_PROXY: '*' };
    const sync = syncWorkerEnvironment(parent, true);
    expect(parent).toEqual({ LIBRARY_SERVER_PROXY: 'http://127.0.0.1:7897', http_proxy: 'http://old.invalid', NO_PROXY: '*' });
    expect(sync).toMatchObject({ HTTP_PROXY: 'http://127.0.0.1:7897/', HTTPS_PROXY: 'http://127.0.0.1:7897/', NODE_USE_ENV_PROXY: '1' });
    expect(sync.http_proxy).toBeUndefined();
    expect(sync.NO_PROXY).not.toBe('*');
    expect(syncWorkerEnvironment({ PASSWORD: 'private' }, false)).toEqual({ PASSWORD: 'private' });
  });

  it('fails before startup for an unsupported runtime or unsafe proxy URL without exposing credentials', () => {
    expect(() => syncWorkerEnvironment({ LIBRARY_SERVER_PROXY: 'http://localhost:7897' }, false)).toThrow('Node.js');
    for (const address of ['socks5://localhost:7897', 'http://user:secret@localhost/private', 'not a URL']) {
      expect(() => syncWorkerEnvironment({ LIBRARY_SERVER_PROXY: address }, true)).toThrow('可信 HTTP / HTTPS 代理地址');
    }
  });

  it.skipIf(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))('routes real child fetches through the configured proxy and bypasses localhost', async () => {
    const targets: string[] = [];
    const proxy = createServer((request, response) => {
      targets.push(request.url!);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ throughProxy: true }));
    });
    // Fetch's proxy agent tunnels HTTP origins too. Act as the origin inside
    // that local CONNECT tunnel, so this test never contacts public DNS.
    const tunnels = new Set<import('node:stream').Duplex>();
    proxy.on('connect', (request, socket) => {
      targets.push(request.url!);
      tunnels.add(socket); socket.once('close', () => tunnels.delete(socket));
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        const body = JSON.stringify({ throughProxy: true });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      });
    });
    const origin = createServer((_request, response) => response.end('local-direct'));
    try {
      await Promise.all([proxy, origin].map((server) => new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      })));
      const proxyPort = (proxy.address() as { port: number }).port;
      const originPort = (origin.address() as { port: number }).port;
      const env = syncWorkerEnvironment({ ...process.env, LIBRARY_SERVER_PROXY: `http://127.0.0.1:${proxyPort}` }, true);
      const child = spawn(process.execPath, ['-e', `Promise.all([fetch('http://library.example.invalid/api/library').then(r=>r.json()),fetch('http://127.0.0.1:${originPort}/api/library').then(r=>r.text())]).then(r=>console.log(JSON.stringify(r))).catch(()=>process.exit(1))`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (bytes) => { output += bytes; });
      const timer = setTimeout(() => child.kill(), 5000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      clearTimeout(timer);
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual([{ throughProxy: true }, 'local-direct']);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatch(/library\.example\.invalid/);
    } finally {
      for (const socket of tunnels) socket.destroy();
      proxy.closeAllConnections(); origin.closeAllConnections();
      await Promise.all([proxy, origin].map((server) => new Promise<void>((resolve) => {
        if (!server.listening) resolve(); else server.close(() => resolve());
      })));
    }
  }, 10_000);
});
