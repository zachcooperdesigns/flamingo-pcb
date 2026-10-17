/**
 * Accessory 3D models: parts that aren't on the board but sit in or on a
 * component, e.g. a microSD card seated in its socket. They are shown in the
 * 3D viewer and the detail STEP export so enclosures can be designed around
 * them; they never reach the BOM, CPL, or Gerbers.
 *
 * The library lives in the repo at `models/accessories/`: one OBJ per
 * accessory (same inline-material format as the EasyEDA models, mm, +Z up)
 * plus `accessories.json`, which maps a component's LCSC id to the accessories
 * that go with it. Each entry's placement uses the same convention as an
 * EasyEDA model (see objmesh.ts): the rotated model bbox is centered on
 * `originMm` in footprint-local x/y and its bottom rests at `zMm` above the
 * board face. Every component with that LCSC id gets the accessory.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/dist/accessories.js -> <repo>/models/accessories
export const ACCESSORIES_DIR = join(here, '..', '..', '..', 'models', 'accessories');

export interface Accessory {
  name: string;
  /** OBJ file name inside ACCESSORIES_DIR. */
  obj: string;
  originMm: { x: number; y: number };
  zMm: number;
  rotationDeg: { x: number; y: number; z: number };
}

export const ACCESSORY_OBJ_RE = /^[\w.-]+\.obj$/;

/** LCSC id → accessories. Returns an empty map (never throws) when the library is missing or unreadable. */
export async function loadAccessories(dir = ACCESSORIES_DIR): Promise<Map<string, Accessory[]>> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'accessories.json'), 'utf8')) as Record<string, Accessory[]>;
    return new Map(
      Object.entries(raw).map(([lcsc, list]) => [lcsc, list.filter((a) => ACCESSORY_OBJ_RE.test(a.obj))]),
    );
  } catch {
    return new Map();
  }
}

export async function loadAccessoryObj(file: string, dir = ACCESSORIES_DIR): Promise<Buffer> {
  if (!ACCESSORY_OBJ_RE.test(file)) throw new Error(`bad accessory file name: ${file}`);
  return readFile(join(dir, file));
}
