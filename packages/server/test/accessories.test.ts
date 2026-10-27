import { describe, expect, it } from 'vitest';
import { loadAccessories, loadAccessoryObj } from '../src/accessories.js';
import { parseObjMesh, placeMeshGroups } from '../src/objmesh.js';

describe('accessory library', () => {
  it('seats a microSD card in the TF-015 socket (C113206)', async () => {
    const lib = await loadAccessories();
    const [card] = lib.get('C113206') ?? [];
    expect(card?.name).toBe('microSD card');

    const groups = parseObjMesh((await loadAccessoryObj(card.obj)).toString('utf8'));
    expect(groups.map((g) => g.color !== null)).toEqual([true, true]); // body + gold contacts

    const placed = placeMeshGroups(groups, card, { at: { x: 10, y: 20 }, rotation: 0, side: 'top' }, 1.6);
    const pts = placed.flatMap((g) => g.tris.flat());
    const span = (k: 'x' | 'y' | 'z') => {
      const v = pts.map((p) => p[k]);
      return [Math.min(...v), Math.max(...v)];
    };
    const [x0, x1] = span('x');
    const [y0, y1] = span('y');
    const [z0, z1] = span('z');
    expect(x1 - x0).toBeCloseTo(11, 1);
    expect(y1 - y0).toBeCloseTo(15, 1);
    expect((x0 + x1) / 2).toBeCloseTo(10 + card.originMm.x, 3);
    expect((y0 + y1) / 2).toBeCloseTo(20 + card.originMm.y, 3);
    expect(z0).toBeCloseTo(1.6 + card.zMm, 3);
    expect(z1 - z0).toBeCloseTo(1.0, 2);
  });

  it('rejects path-like file names', async () => {
    await expect(loadAccessoryObj('../accessories.json')).rejects.toThrow(/bad accessory/);
  });
});
