#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBoard } from '@flamingo/engine';
import { Doc } from './document.js';
import { startServer, type StartedServer } from './http.js';
import { listServers, projectSlug, registerServer, ROUTER_DOMAIN, unregisterServerSync } from './registry.js';
import { ROUTER_PORT, startRouter } from './router.js';

const VERSION = '0.1.0';
const DEFAULT_PORT = 4242;
/** How far past DEFAULT_PORT `serve` looks for a free port when FLAMINGO_PORT isn't set. */
const PORT_SEARCH = 100;

const USAGE = `Usage:
  flamingo serve [file.flamingo] [--name <project>]
  flamingo router [--port <n>]       front door: <project>.${ROUTER_DOMAIN} -> its server
  flamingo router install            run the router at login (macOS LaunchAgent)
  flamingo router uninstall
  flamingo list                      running projects`;

const LAUNCH_LABEL = 'com.cwandt.flamingo.router';
const launchAgentPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
const launchDomain = (): string => `gui/${process.getuid?.() ?? 501}`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** FLAMINGO_PORT is used as-is; otherwise the first free port from DEFAULT_PORT up. */
async function listen(doc: Doc, projectDir: string): Promise<StartedServer> {
  if (process.env.FLAMINGO_PORT) return startServer(doc, Number(process.env.FLAMINGO_PORT), { projectDir });
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SEARCH; port++) {
    try {
      return await startServer(doc, port, { projectDir });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`no free port in ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_SEARCH - 1}`);
}

async function serve(fileArg: string, nameArg: string | undefined): Promise<void> {
  const filePath = resolve(process.cwd(), fileArg);
  const stem = basename(filePath, extname(filePath)) || 'board';

  let doc: Doc;
  if (existsSync(filePath)) {
    doc = await Doc.load(filePath);
  } else {
    doc = new Doc(newBoard(stem, 2), filePath);
    await doc.save();
  }

  const started = await listen(doc, dirname(filePath));
  const name = await registerServer(projectSlug(nameArg ?? process.env.FLAMINGO_NAME ?? stem), {
    port: started.port,
    pid: process.pid,
    file: filePath,
    startedAt: new Date().toISOString(),
  });
  process.on('exit', () => unregisterServerSync(name, process.pid));
  console.log(
    `Flamingo v${VERSION} serving ${fileArg} at http://${name}.${ROUTER_DOMAIN} ` +
      `(direct: http://${ROUTER_DOMAIN}:${started.port})`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    doc
      .close()
      .catch((err: unknown) => {
        console.error('[flamingo] failed to flush pending save on shutdown:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Write the LaunchAgent that keeps `flamingo router` running from login on, and (re)load it. */
async function installRouter(): Promise<void> {
  const log = join(homedir(), '.flamingo', 'router.log');
  await mkdir(dirname(launchAgentPath()), { recursive: true });
  await mkdir(dirname(log), { recursive: true });
  await writeFile(
    launchAgentPath(),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${fileURLToPath(import.meta.url)}</string><string>router</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`,
  );
  uninstallLaunchAgent();
  execFileSync('launchctl', ['bootstrap', launchDomain(), launchAgentPath()]);
  console.log(`Router installed (${launchAgentPath()}); it runs at login. Projects: http://${ROUTER_DOMAIN}`);
}

function uninstallLaunchAgent(): void {
  try {
    execFileSync('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_LABEL}`], { stdio: 'ignore' });
  } catch {
    // not loaded
  }
}

async function router(args: string[]): Promise<void> {
  if (args[0] === 'install') {
    await installRouter();
    return;
  }
  if (args[0] === 'uninstall') {
    uninstallLaunchAgent();
    await rm(launchAgentPath(), { force: true });
    console.log('Router uninstalled.');
    return;
  }
  const port = Number(flagValue(args, '--port') ?? ROUTER_PORT);
  await startRouter(port);
  console.log(`Flamingo router on port ${port}: http://<project>.${ROUTER_DOMAIN}${port === 80 ? '' : `:${port}`}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'serve') {
    const file = args[1] && !args[1].startsWith('--') ? args[1] : './board.flamingo';
    await serve(file, flagValue(args, '--name'));
  } else if (command === 'router') {
    await router(args.slice(1));
  } else if (command === 'list') {
    for (const s of await listServers()) console.log(`http://${s.name}.${ROUTER_DOMAIN}  port ${s.port}  ${s.file}`);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
