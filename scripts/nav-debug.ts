/**
 * Debug helper: builds the navigation grid from the optimised GLB in Node and
 * writes an image of the walkable area with routes from the kiosk to every
 * resource. Run with:  npx tsx scripts/nav-debug.ts [out.ppm]
 */
import { NodeIO, Node as GNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { writeFileSync } from 'node:fs';
import { NavGrid, type Footprint, type TriangleSource, type Vec2 } from '../src/app/wayfinding/nav-grid';
import {
  HOME_KIOSK_ID,
  matchResource,
  NODE_PREFIX,
} from '../src/app/wayfinding/resource-config';

type M4 = number[];
const apply = (m: M4, x: number, y: number, z: number): [number, number, number] => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

function triSource(nodes: GNode[]): TriangleSource {
  return {
    forEachTriangle(visit) {
      for (const node of nodes) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        const m = node.getWorldMatrix() as unknown as M4;
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION')!;
          const idx = prim.getIndices();
          const n = idx ? idx.getCount() : pos.getCount();
          const v: number[] = [0, 0, 0];
          const get = (k: number) => {
            pos.getElement(idx ? idx.getScalar(k) : k, v);
            return apply(m, v[0], v[1], v[2]);
          };
          for (let k = 0; k + 2 < n; k += 3) {
            const a = get(k), b = get(k + 1), c = get(k + 2);
            visit(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          }
        }
      }
    },
  };
}

function bounds(nodes: GNode[]) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  triSource(nodes).forEachTriangle((...p) => {
    for (let i = 0; i < 9; i += 3) {
      b.minX = Math.min(b.minX, p[i]); b.maxX = Math.max(b.maxX, p[i]);
      b.minY = Math.min(b.minY, p[i + 1]); b.maxY = Math.max(b.maxY, p[i + 1]);
      b.minZ = Math.min(b.minZ, p[i + 2]); b.maxZ = Math.max(b.maxZ, p[i + 2]);
    }
  });
  return b;
}

const subtree = (n: GNode): GNode[] => [n, ...n.listChildren().flatMap(subtree)];

async function main() {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(process.argv[3] ?? 'public/models/l13-floorplan.glb');
  const homeId = process.argv[4] ?? 'WAYFINDING_KIOSK_L13_1';
  const all = doc.getRoot().listNodes();

  const floors = all.filter((n) => n.getName().startsWith(NODE_PREFIX.floor));
  const walls = all.filter((n) => n.getName().startsWith(NODE_PREFIX.wall));
  const lifts = all.filter((n) => matchResource(n.getName())?.rule.kind === 'lift');
  const furniture = all.filter((n) => n.getName().startsWith(NODE_PREFIX.furniture));

  const t0 = performance.now();
  const obstacles: Footprint[] = [];
  let kiosk: Vec2 | null = null;
  const targets: { id: string; p: Vec2; region?: Footprint }[] = [];
  for (const f of furniture) {
    const b = bounds(subtree(f));
    const r = matchResource(f.getName());
    if (r?.rule.kind === 'kiosk') {
      if (r.rule.id(r.match) === homeId) kiosk = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
      else targets.push({ id: r.rule.id(r.match), p: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 } });
      continue;
    }
    if (r?.rule.kind === 'desk') targets.push({ id: r.rule.id(r.match), p: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 } });
    if (b.minY > 0.3) continue;
    obstacles.push(b);
  }
  for (const n of floors) {
    const r = matchResource(n.getName());
    if (r?.rule.kind !== 'meeting-room' && r?.rule.kind !== 'amenity') continue;
    const b = bounds([n]);
    targets.push({ id: r.rule.id(r.match), p: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, region: b });
  }
  for (const l of lifts) {
    const r = matchResource(l.getName())!;
    const b = bounds(subtree(l));
    console.log('lift', r.rule.id(r.match), b);
    targets.push({ id: r.rule.id(r.match), p: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 } });
  }

  const grid = NavGrid.build({
    floors: [triSource(floors)],
    walls: [triSource(walls), triSource(lifts.flatMap(subtree))],
    obstacles,
  });
  console.log('grid', grid.cols, grid.rows, 'built in', (performance.now() - t0).toFixed(0), 'ms');
  if (!kiosk) throw new Error('kiosk not found');
  const start = grid.nearestWalkable(kiosk);
  const comp = grid.component[start];

  const img = new Uint8Array(grid.cols * grid.rows * 3);
  for (let i = 0; i < grid.cols * grid.rows; i++) {
    const c = grid.solid[i] ? [40, 40, 40] : !grid.floor[i] ? [255, 255, 255]
      : grid.walkable[i] ? (grid.component[i] === comp ? [190, 230, 190] : [230, 190, 190]) : [200, 200, 200];
    img.set(c, i * 3);
  }
  const plot = (p: Vec2, col: number[], r = 0) => {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const i = grid.indexOf(p.x + dx * grid.cell, p.z + dz * grid.cell);
      if (i >= 0) img.set(col, i * 3);
    }
  };
  for (const t of targets) {
    const t1 = performance.now();
    const goal = grid.nearestWalkable(t.p, comp, 6, t.region);
    const cells = grid.findPath(start, goal);
    if (!cells) { console.log('NO PATH to', t.id); plot(t.p, [255, 0, 0], 3); continue; }
    const pts = grid.simplify(cells);
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    console.log(t.id.padEnd(24), `${len.toFixed(1)} m`, pts.length, 'pts', (performance.now() - t1).toFixed(0), 'ms');
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05);
      for (let s = 0; s <= steps; s++) plot({ x: a.x + (b.x - a.x) * s / steps, z: a.z + (b.z - a.z) * s / steps }, [30, 90, 230]);
    }
    plot(t.p, [230, 120, 0], 2);
  }
  plot(kiosk, [220, 0, 200], 3);
  const out = process.argv[2] ?? '/tmp/nav.ppm';
  writeFileSync(out, Buffer.concat([Buffer.from(`P6 ${grid.cols} ${grid.rows} 255\n`), Buffer.from(img)]));
  console.log('wrote', out);
}

main();
