import http from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { newBoard } from '@flamingo/engine';
import { Doc } from '../src/document.js';
import { startServer } from '../src/http.js';
import { listServers, projectSlug, registerServer, unregisterServerSync } from '../src/registry.js';
import { projectFromHost, startRouter } from '../src/router.js';

describe('startServer on a busy port', () => {
  it('rejects with EADDRINUSE instead of crashing, so `serve` can try the next port', async () => {
    const first = await startServer(new Doc(newBoard('a', 2)), 0);
    await expect(startServer(new Doc(newBoard('b', 2)), first.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.close();
  });
});

const entry = (port: number, pid = process.pid) => ({ port, pid, file: '/tmp/x.flamingo', startedAt: 'now' });

describe('server registry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-reg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('slugs board names into DNS labels', () => {
    expect(projectSlug('Olto_Mini_CAN_Logger_rev_A')).toBe('olto-mini-can-logger-rev-a');
    expect(projectSlug('__')).toBe('board');
    expect(projectSlug('x'.repeat(80))).toHaveLength(63);
  });

  it('suffixes a name held by another live server, and reuses it for the same pid', async () => {
    expect(await registerServer('puck', entry(4242), dir)).toBe('puck');
    expect(await registerServer('puck', entry(4242), dir)).toBe('puck');
    // pid 1 (launchd/init) is always alive and never ours
    await writeFile(join(dir, 'led.json'), JSON.stringify({ name: 'led', ...entry(4243, 1) }));
    expect(await registerServer('led', entry(4244), dir)).toBe('led-2');
  });

  it('prunes entries whose process has exited and unregisters only its own pid', async () => {
    await writeFile(join(dir, 'dead.json'), JSON.stringify({ name: 'dead', ...entry(4250, 2 ** 22 - 7) }));
    await registerServer('alive', entry(4251), dir);
    expect((await listServers(dir)).map((s) => s.name)).toEqual(['alive']);
    expect(await readdir(dir)).toEqual(['alive.json']);
    unregisterServerSync('alive', 12345, dir);
    expect(await readdir(dir)).toEqual(['alive.json']);
    unregisterServerSync('alive', process.pid, dir);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('router', () => {
  let dir: string;
  let backend: http.Server;
  let wss: WebSocketServer;
  let router: http.Server;
  let routerPort: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flamingo-router-'));
    backend = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`backend ${req.method} ${req.url}`);
    });
    wss = new WebSocketServer({ server: backend, path: '/ws' });
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
    await new Promise<void>((r) => backend.listen(0, r));
    const backendPort = (backend.address() as { port: number }).port;
    await registerServer('puck-rev-a', entry(backendPort), dir);
    router = await startRouter(0, { dir });
    routerPort = (router.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise((r) => router.close(r));
    wss.close();
    await new Promise((r) => backend.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const get = (host: string, path = '/') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: routerPort, path, headers: { host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  it('parses project names out of the Host header', () => {
    expect(projectFromHost('puck.flamingopcb.localhost')).toBe('puck');
    expect(projectFromHost('Puck.FlamingoPCB.localhost:80')).toBe('puck');
    expect(projectFromHost('flamingopcb.localhost')).toBe('');
    expect(projectFromHost('example.com')).toBeNull();
  });

  it('proxies <project>.flamingopcb.localhost to that server', async () => {
    const res = await get('puck-rev-a.flamingopcb.localhost', '/api/board?x=1');
    expect(res).toEqual({ status: 200, body: 'backend GET /api/board?x=1' });
  });

  it('lists live projects on the bare domain and 404s unknown ones', async () => {
    const index = await get('flamingopcb.localhost');
    expect(index.status).toBe(200);
    expect(index.body).toContain('http://puck-rev-a.flamingopcb.localhost');
    const missing = await get('nope.flamingopcb.localhost');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('nope');
  });

  it('tunnels the /ws WebSocket upgrade', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/ws`, { headers: { host: 'puck-rev-a.flamingopcb.localhost' } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    ws.close();
    expect(reply).toBe('echo hi');
  });
});
