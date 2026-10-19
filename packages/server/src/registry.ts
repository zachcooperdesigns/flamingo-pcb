/**
 * Local server registry: every `flamingo serve` records `{ name, port, pid, file }`
 * in `~/.flamingo/servers/<name>.json`, so `flamingo router` can send
 * `<name>.flamingopcb.localhost` to the right port. An entry whose pid has
 * exited counts as absent (and is pruned on the next listing), so a crashed
 * server can't leave a stale route behind.
 */

import { readFileSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Every project is served at `<name>.ROUTER_DOMAIN`; the bare domain lists them. */
export const ROUTER_DOMAIN = 'flamingopcb.localhost';

export interface ServerEntry {
  /** DNS-label project name (see projectSlug). */
  name: string;
  port: number;
  pid: number;
  /** Absolute path of the board file being served. */
  file: string;
  startedAt: string;
}

export function registryDir(): string {
  return process.env.FLAMINGO_REGISTRY_DIR ?? join(homedir(), '.flamingo', 'servers');
}

/** A board file stem (or any label) as a DNS label: `Olto_Mini_rev_A` -> `olto-mini-rev-a`. */
export function projectSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug || 'board';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live servers, sorted by name. Entries for exited pids are deleted. Never throws. */
export async function listServers(dir = registryDir()): Promise<ServerEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: ServerEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const path = join(dir, f);
    try {
      const entry = JSON.parse(await readFile(path, 'utf8')) as ServerEntry;
      if (isAlive(entry.pid)) out.push(entry);
      else await rm(path, { force: true });
    } catch {
      // unreadable or half-written entry: skip it
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Register a server under `wanted`, or `wanted-2`, `wanted-3`, ... when another
 * live server already holds the name. Returns the name actually registered.
 */
export async function registerServer(
  wanted: string,
  entry: Omit<ServerEntry, 'name'>,
  dir = registryDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const taken = new Map((await listServers(dir)).map((e) => [e.name, e.pid]));
  let name = wanted;
  for (let i = 2; taken.has(name) && taken.get(name) !== entry.pid; i++) name = `${wanted}-${i}`;
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ name, ...entry }, null, 2));
  return name;
}

/** Remove `name`'s entry if it still belongs to `pid`. Synchronous so it can run in an exit handler. */
export function unregisterServerSync(name: string, pid: number, dir = registryDir()): void {
  const path = join(dir, `${name}.json`);
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as ServerEntry;
    if (entry.pid === pid) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}
