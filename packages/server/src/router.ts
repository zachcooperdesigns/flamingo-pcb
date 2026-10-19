/**
 * `flamingo router`: one HTTP front door on port 80 for every running board.
 * `<name>.flamingopcb.localhost` is proxied (HTTP, streaming MCP responses,
 * and the /ws upgrade) to the port that server registered in the registry;
 * the bare `flamingopcb.localhost` lists the live projects. `*.localhost`
 * already resolves to loopback on macOS and in browsers, so no DNS or
 * /etc/hosts setup is needed, and macOS lets a normal user bind port 80.
 */

import http from 'node:http';
import net from 'node:net';
import { listServers, registryDir, ROUTER_DOMAIN, type ServerEntry } from './registry.js';

export const ROUTER_PORT = 80;

export interface StartRouterOptions {
  /** Registry directory to resolve names against. Defaults to registryDir(). */
  dir?: string;
}

/** `foo.flamingopcb.localhost[:80]` -> `foo`; the bare domain (or localhost) -> ''; anything else -> null. */
export function projectFromHost(host: string | undefined): string | null {
  const h = (host ?? '').split(':')[0]!.toLowerCase();
  if (h === ROUTER_DOMAIN || h === 'localhost' || h === '127.0.0.1') return '';
  const suffix = `.${ROUTER_DOMAIN}`;
  return h.endsWith(suffix) ? h.slice(0, -suffix.length) : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function indexPage(servers: ServerEntry[], missing?: string): string {
  const rows = servers
    .map((s) => {
      const url = `http://${s.name}.${ROUTER_DOMAIN}`;
      return `<li><a href="${url}">${escapeHtml(s.name)}</a> <span>${escapeHtml(s.file)} · port ${s.port}</span></li>`;
    })
    .join('\n');
  const note = missing !== undefined ? `<p class="miss">No running board is named <b>${escapeHtml(missing)}</b>.</p>` : '';
  return `<!doctype html><meta charset="utf-8"><title>Flamingo projects</title>
<style>body{font:15px/1.5 ui-monospace,monospace;background:#111;color:#ddd;margin:40px}a{color:#ff7aa2}span{color:#888;margin-left:8px}.miss{color:#f88}</style>
<h1>Flamingo projects</h1>${note}
${servers.length ? `<ul>${rows}</ul>` : '<p>No boards are being served. Start one with <code>flamingo serve file.flamingo</code>.</p>'}`;
}

async function lookup(name: string, dir: string): Promise<ServerEntry | undefined> {
  return (await listServers(dir)).find((s) => s.name === name);
}

/** Raw request head for replaying an upgrade request onto the backend socket. */
function requestHead(req: http.IncomingMessage): string {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  return `${head}\r\n`;
}

export async function startRouter(port = ROUTER_PORT, opts: StartRouterOptions = {}): Promise<http.Server> {
  const dir = opts.dir ?? registryDir();

  const server = http.createServer((req, res) => {
    void (async () => {
      const name = projectFromHost(req.headers.host);
      if (name === null) {
        res.writeHead(421, { 'content-type': 'text/plain' }).end(`Not a ${ROUTER_DOMAIN} host\n`);
        return;
      }
      const target = name === '' ? undefined : await lookup(name, dir);
      if (!target) {
        const html = indexPage(await listServers(dir), name === '' ? undefined : name);
        res.writeHead(name === '' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Flamingo server "${target.name}" on port ${target.port} is not answering\n`);
      });
      req.pipe(upstream);
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const name = projectFromHost(req.headers.host);
      const target = name ? await lookup(name, dir) : undefined;
      if (!target) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      const upstream = net.connect(target.port, '127.0.0.1', () => {
        upstream.write(requestHead(req));
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
