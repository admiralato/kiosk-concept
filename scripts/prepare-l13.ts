/**
 * Prepares and optimizes assets/l13-floorplan.glb -> public/models/l13-floorplan.glb:
 * 1. Converts coordinates from centimetres (obj2gltf export) to metres (× 0.01) so L13 matches L12 scale.
 * 2. Splits and names the semantic hierarchy:
 *    - floors:   floor_Level13_* (from ground_1 and room_* floor meshes)
 *    - walls:    wall_Level13_1 (from wall_1_2)
 *    - doors:    door_WAYFINDING_LIFT_13_1 (west lift) and door_WAYFINDING_LIFT_13_2 (north lift), plus regular doors
 *    - furniture:
 *        - furniture_WAYFINDING_KIOSK_L13_1 (north lobby kiosk)
 *        - furniture_WAYFINDING_KIOSK_L13_2 (south lobby kiosk)
 *        - furniture_Desk_13_001, furniture_Desk_13_002, furniture_Desk_13_003 (the 3 acoustic booth desks)
 *        - decorative furniture clusters (subdivided into individual spatial bounding boxes for accurate pathfinding obstacles)
 * 3. Welds, simplifies heavy decorative meshes, quantizes, and compresses with Meshopt.
 */
import { Document, NodeIO, Node as GNode, Primitive, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { weld, simplify, quantize, reorder, dedup, prune } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';

const CM_TO_M = 0.01;

interface SubBox {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Extracts a subset of triangles from `prim` whose centroid (in metres) lies within `box`,
 * plus a primitive of all remaining triangles.
 */
function splitPrimitiveByBoxes(
  doc: Document,
  prim: Primitive,
  boxes: SubBox[],
  scale = CM_TO_M,
): { matched: Map<string, Primitive[]>; remainder: Primitive | null } {
  const posAcc = prim.getAttribute('POSITION')!;
  const normAcc = prim.getAttribute('NORMAL');
  const uvAcc = prim.getAttribute('TEXCOORD_0');
  const idxAcc = prim.getIndices();
  const mat = prim.getMaterial();

  const posArr = posAcc.getArray() as Float32Array;
  const normArr = normAcc ? (normAcc.getArray() as Float32Array) : null;
  const uvArr = uvAcc ? (uvAcc.getArray() as Float32Array) : null;
  const idxArr = idxAcc ? (idxAcc.getArray() as Uint32Array | Uint16Array) : null;
  const triCount = idxArr ? idxArr.length / 3 : posArr.length / 9;

  const bucketTris = new Map<string, number[]>();
  for (const b of boxes) bucketTris.set(b.name, []);
  const remTris: number[] = [];

  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr ? idxArr[t * 3] : t * 3;
    const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;

    const cx = ((posArr[i0 * 3] + posArr[i1 * 3] + posArr[i2 * 3]) / 3) * scale;
    const cz = ((posArr[i0 * 3 + 2] + posArr[i1 * 3 + 2] + posArr[i2 * 3 + 2]) / 3) * scale;

    let hit: string | null = null;
    for (const b of boxes) {
      if (cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ) {
        hit = b.name;
        break;
      }
    }
    if (hit) {
      bucketTris.get(hit)!.push(i0, i1, i2);
    } else {
      remTris.push(i0, i1, i2);
    }
  }

  const buildPrim = (tris: number[]): Primitive | null => {
    if (tris.length === 0) return null;
    const remap = new Map<number, number>();
    const newIdx = new Uint32Array(tris.length);
    const newPos: number[] = [];
    const newNorm: number[] = [];
    const newUv: number[] = [];

    for (let k = 0; k < tris.length; k++) {
      const oldV = tris[k];
      let newV = remap.get(oldV);
      if (newV === undefined) {
        newV = newPos.length / 3;
        remap.set(oldV, newV);
        newPos.push(
          posArr[oldV * 3] * scale,
          posArr[oldV * 3 + 1] * scale,
          posArr[oldV * 3 + 2] * scale,
        );
        if (normArr) {
          newNorm.push(normArr[oldV * 3], normArr[oldV * 3 + 1], normArr[oldV * 3 + 2]);
        }
        if (uvArr) {
          newUv.push(uvArr[oldV * 2], uvArr[oldV * 2 + 1]);
        }
      }
      newIdx[k] = newV;
    }

    const p = doc.createPrimitive();
    if (mat) p.setMaterial(mat);
    const buf = doc.getRoot().listBuffers()[0];
    p.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(newPos)).setBuffer(buf),
    );
    if (normArr) {
      p.setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(new Float32Array(newNorm)).setBuffer(buf),
      );
    }
    if (uvArr) {
      p.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor().setType('VEC2').setArray(new Float32Array(newUv)).setBuffer(buf),
      );
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buf));
    return p;
  };

  const matched = new Map<string, Primitive[]>();
  for (const [name, tris] of bucketTris.entries()) {
    const p = buildPrim(tris);
    if (p) matched.set(name, [p]);
  }
  return { matched, remainder: buildPrim(remTris) };
}

/** Scales a primitive's POSITION attribute in-place by `scale`. */
function scalePrimitivePositions(prim: Primitive, scale = CM_TO_M): void {
  const posAcc = prim.getAttribute('POSITION');
  if (!posAcc) return;
  const arr = posAcc.getArray() as Float32Array;
  for (let i = 0; i < arr.length; i++) arr[i] *= scale;
  posAcc.setArray(arr);
}

/**
 * Known 52 enclosed bookable rooms on Level 13 (MeetingRoom_13_*, PrivateRoom_13_*, FocusRoom_13_*),
 * keyed by their exact room bounds (minX, maxX, minZ, maxZ in metres).
 * This allows us to extract and name all 52 rooms identically whether they are exported
 * as separate `room_*` floor materials OR merged into `wall_1_2` as y=2.50m ceiling polygons.
 */
const L13_ROOM_DEFINITIONS: ReadonlyArray<{
  roomId: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}> = [
  { roomId: 'PrivateRoom_13_1', minX: 34.01, maxX: 36.66, minZ: 11.03, maxZ: 13.3 },
  { roomId: 'PrivateRoom_13_2', minX: 36.73, maxX: 39.38, minZ: 11.03, maxZ: 13.3 },
  { roomId: 'PrivateRoom_13_3', minX: 39.46, maxX: 42.01, minZ: 11.03, maxZ: 13.3 },
  { roomId: 'PrivateRoom_13_4', minX: 42.08, maxX: 44.7, minZ: 11.03, maxZ: 13.3 },
  { roomId: 'PrivateRoom_13_5', minX: 44.69, maxX: 47.34, minZ: 21.82, maxZ: 24.16 },
  { roomId: 'PrivateRoom_13_6', minX: 44.78, maxX: 47.34, minZ: 13.38, maxZ: 16.1 },
  { roomId: 'MeetingRoom_13_43', minX: 44.78, maxX: 47.34, minZ: 11.03, maxZ: 13.3 },
  { roomId: 'PrivateRoom_13_7', minX: 34.64, maxX: 39.97, minZ: 6.46, maxZ: 9.58 },
  { roomId: 'PrivateRoom_13_8', minX: 25.19, maxX: 27.86, minZ: 5.5, maxZ: 7.2 },
  { roomId: 'PrivateRoom_13_9', minX: 27.94, maxX: 30.52, minZ: 5.5, maxZ: 7.2 },
  { roomId: 'PrivateRoom_13_10', minX: 25.19, maxX: 27.86, minZ: 7.27, maxZ: 9.58 },
  { roomId: 'PrivateRoom_13_11', minX: 27.94, maxX: 30.52, minZ: 7.27, maxZ: 9.58 },
  { roomId: 'PrivateRoom_13_12', minX: 17.26, maxX: 19.89, minZ: 13.38, maxZ: 15.7 },
  { roomId: 'PrivateRoom_13_13', minX: 17.26, maxX: 19.89, minZ: 15.77, maxZ: 18.03 },
  { roomId: 'PrivateRoom_13_14', minX: 17.26, maxX: 19.89, minZ: 18.11, maxZ: 20.4 },
  { roomId: 'PrivateRoom_13_15', minX: 17.26, maxX: 19.89, minZ: 20.48, maxZ: 22.83 },
  { roomId: 'MeetingRoom_13_44', minX: 17.26, maxX: 19.89, minZ: 22.9, maxZ: 25.21 },
  { roomId: 'MeetingRoom_13_45', minX: 11.08, maxX: 15.8, minZ: 20.48, maxZ: 23.6 },
  { roomId: 'MeetingRoom_13_46', minX: 11.08, maxX: 15.8, minZ: 17.06, maxZ: 20.4 },
  { roomId: 'PrivateRoom_13_16', minX: 11.08, maxX: 13.43, minZ: 28.21, maxZ: 30.84 },
  { roomId: 'PrivateRoom_13_17', minX: 13.51, maxX: 15.8, minZ: 28.21, maxZ: 30.84 },
  { roomId: 'FocusRoom_13_24', minX: 17.26, maxX: 19.82, minZ: 27.98, maxZ: 31.43 },
  { roomId: 'PrivateRoom_13_18', minX: 17.26, maxX: 19.82, minZ: 31.5, maxZ: 33.81 },
  { roomId: 'PrivateRoom_13_19', minX: 17.26, maxX: 19.82, minZ: 33.89, maxZ: 36.19 },
  { roomId: 'PrivateRoom_13_20', minX: 17.26, maxX: 19.82, minZ: 36.27, maxZ: 38.6 },
  { roomId: 'PrivateRoom_13_21', minX: 17.26, maxX: 19.55, minZ: 38.68, maxZ: 41.25 },
  { roomId: 'PrivateRoom_13_22', minX: 19.62, maxX: 21.93, minZ: 38.68, maxZ: 41.25 },
  { roomId: 'PrivateRoom_13_23', minX: 22.01, maxX: 24.32, minZ: 38.68, maxZ: 41.25 },
  { roomId: 'PrivateRoom_13_29', minX: 24.39, maxX: 26.65, minZ: 38.68, maxZ: 41.25 },
  { roomId: 'PrivateRoom_13_30', minX: 28.89, maxX: 31.2, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_31', minX: 34.01, maxX: 36.35, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_32', minX: 36.43, maxX: 38.75, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_33', minX: 38.82, maxX: 41.12, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_34', minX: 41.19, maxX: 43.47, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_35', minX: 43.54, maxX: 45.83, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'FocusRoom_13_25', minX: 45.9, maxX: 47.34, minZ: 39.38, maxZ: 41.35 },
  { roomId: 'MeetingRoom_13_47', minX: 48.76, maxX: 55.37, minZ: 35.11, maxZ: 38.6 },
  { roomId: 'FocusRoom_13_26', minX: 48.76, maxX: 50.64, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_36', minX: 50.72, maxX: 52.98, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'PrivateRoom_13_37', minX: 53.05, maxX: 55.37, minZ: 38.68, maxZ: 41.35 },
  { roomId: 'MeetingRoom_13_48', minX: 44.78, maxX: 47.34, minZ: 29.93, maxZ: 32.17 },
  { roomId: 'MeetingRoom_13_49', minX: 44.78, maxX: 47.34, minZ: 36.27, maxZ: 38.6 },
  { roomId: 'PrivateRoom_13_38', minX: 44.78, maxX: 47.34, minZ: 27.46, maxZ: 29.86 },
  { roomId: 'MeetingRoom_13_51', minX: 53.05, maxX: 55.37, minZ: 27.52, maxZ: 30.16 },
  { roomId: 'PrivateRoom_13_39', minX: 50.72, maxX: 55.37, minZ: 24.42, maxZ: 27.45 },
  { roomId: 'MeetingRoom_13_52', minX: 48.76, maxX: 50.64, minZ: 24.42, maxZ: 27.45 },
  { roomId: 'PrivateRoom_13_40', minX: 32.65, maxX: 34.84, minZ: 47.79, maxZ: 49.92 },
  { roomId: 'PrivateRoom_13_41', minX: 30.26, maxX: 32.57, minZ: 47.79, maxZ: 49.92 },
  { roomId: 'FocusRoom_13_27', minX: 30.26, maxX: 32.57, minZ: 45.6, maxZ: 47.71 },
  { roomId: 'FocusRoom_13_28', minX: 32.65, maxX: 34.84, minZ: 45.6, maxZ: 47.71 },
  { roomId: 'MeetingRoom_13_50', minX: 11.08, maxX: 15.8, minZ: 38.24, maxZ: 41.25 },
  { roomId: 'PrivateRoom_13_42', minX: 28.61, maxX: 31.2, minZ: 11.03, maxZ: 13.3 },
];

/**
 * Fallback extractor when `assets/l13-floorplan.glb` has the 52 room polygons merged into `wall_1_2`
 * as y=2.50m ceiling polygons instead of separate `room_*` floor materials.
 * Projects each matched room polygon down to y=0.0m with upward normal (0, 1, 0).
 */
function extractRoomsFromWallMesh(
  doc: Document,
  wallPrim: Primitive,
  floorMat: ReturnType<Primitive['getMaterial']>,
): Array<{ roomId: string; prim: Primitive }> {
  const posAcc = wallPrim.getAttribute('POSITION')!;
  const normAcc = wallPrim.getAttribute('NORMAL');
  const idxAcc = wallPrim.getIndices();
  const posArr = posAcc.getArray() as Float32Array;
  const normArr = normAcc ? (normAcc.getArray() as Float32Array) : null;
  const idxArr = idxAcc ? (idxAcc.getArray() as Uint32Array | Uint16Array) : null;
  const triCount = idxArr ? idxArr.length / 3 : posArr.length / 9;

  // Collect y ~= 2.50m ceiling triangles
  const ceilTris: Array<[number, number, number]> = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr ? idxArr[t * 3] : t * 3;
    const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
    const y0 = posArr[i0 * 3 + 1];
    const y1 = posArr[i1 * 3 + 1];
    const y2 = posArr[i2 * 3 + 1];
    const ny = normArr ? normArr[i0 * 3 + 1] : -1;
    if (
      Math.abs(y0 - 2.5) < 0.02 &&
      Math.abs(y1 - 2.5) < 0.02 &&
      Math.abs(y2 - 2.5) < 0.02 &&
      ny < -0.8
    ) {
      ceilTris.push([i0, i1, i2]);
    }
  }

  // Group ceiling triangles into connected islands by (x, z)
  const vmap = new Map<string, number>();
  const keyOf = (v: number) =>
    `${Math.round(posArr[v * 3] * 1000)}_${Math.round(posArr[v * 3 + 2] * 1000)}`;
  for (const [a, b, c] of ceilTris) {
    for (const v of [a, b, c]) {
      const k = keyOf(v);
      if (!vmap.has(k)) vmap.set(k, vmap.size);
    }
  }
  const parent = new Int32Array(vmap.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const [a, b, c] of ceilTris) {
    const ra = find(vmap.get(keyOf(a))!);
    const rb = find(vmap.get(keyOf(b))!);
    const rc = find(vmap.get(keyOf(c))!);
    parent[rb] = ra;
    parent[rc] = ra;
  }
  const islands = new Map<number, Array<[number, number, number]>>();
  for (const tri of ceilTris) {
    const r = find(vmap.get(keyOf(tri[0]))!);
    const list = islands.get(r) ?? [];
    list.push(tri);
    islands.set(r, list);
  }

  const buf = doc.getRoot().listBuffers()[0];
  const results: Array<{ roomId: string; prim: Primitive }> = [];
  const usedIds = new Set<string>();

  for (const tris of islands.values()) {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const [a, b, c] of tris) {
      for (const v of [a, b, c]) {
        const px = posArr[v * 3];
        const pz = posArr[v * 3 + 2];
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minZ = Math.min(minZ, pz);
        maxZ = Math.max(maxZ, pz);
      }
    }

    const def = L13_ROOM_DEFINITIONS.find(
      (d) =>
        !usedIds.has(d.roomId) &&
        Math.abs(d.minX - minX) < 0.06 &&
        Math.abs(d.maxX - maxX) < 0.06 &&
        Math.abs(d.minZ - minZ) < 0.06 &&
        Math.abs(d.maxZ - maxZ) < 0.06,
    );
    if (!def) continue;
    usedIds.add(def.roomId);

    const remap = new Map<number, number>();
    const newIdx = new Uint32Array(tris.length * 3);
    const newPos: number[] = [];
    const newNorm: number[] = [];

    for (let t = 0; t < tris.length; t++) {
      // Reverse winding order [i0, i2, i1] since we flip normal from -Y (ceiling) to +Y (floor)
      const [i0, i1, i2] = tris[t];
      const triVerts = [i0, i2, i1];
      for (let k = 0; k < 3; k++) {
        const oldV = triVerts[k];
        let newV = remap.get(oldV);
        if (newV === undefined) {
          newV = newPos.length / 3;
          remap.set(oldV, newV);
          newPos.push(posArr[oldV * 3], 0.0, posArr[oldV * 3 + 2]);
          newNorm.push(0, 1, 0);
        }
        newIdx[t * 3 + k] = newV;
      }
    }

    const p = doc.createPrimitive();
    if (floorMat) p.setMaterial(floorMat);
    p.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(newPos)).setBuffer(buf),
    );
    p.setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(newNorm)).setBuffer(buf),
    );
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buf));
    results.push({ roomId: def.roomId, prim: p });
  }

  return results;
}
function splitFloorIntoConnectedRooms(
  doc: Document,
  prim: Primitive,
  sortByCoords = true,
): Array<{ prim: Primitive; minX: number; maxX: number; minZ: number; maxZ: number }> {
  const posAcc = prim.getAttribute('POSITION')!;
  const normAcc = prim.getAttribute('NORMAL');
  const uvAcc = prim.getAttribute('TEXCOORD_0');
  const idxAcc = prim.getIndices();
  const mat = prim.getMaterial();

  const posArr = posAcc.getArray() as Float32Array;
  const normArr = normAcc ? (normAcc.getArray() as Float32Array) : null;
  const uvArr = uvAcc ? (uvAcc.getArray() as Float32Array) : null;
  const idxArr = idxAcc ? (idxAcc.getArray() as Uint32Array | Uint16Array) : null;
  const triCount = idxArr ? idxArr.length / 3 : posArr.length / 9;

  // Weld vertices by 1mm rounded coordinates to find connected components
  const vmap = new Map<string, number>();
  const vid = new Int32Array(posAcc.getCount());
  for (let i = 0; i < posAcc.getCount(); i++) {
    const key = `${Math.round(posArr[i * 3] * 1000)}_${Math.round(posArr[i * 3 + 2] * 1000)}`;
    let id = vmap.get(key);
    if (id === undefined) {
      id = vmap.size;
      vmap.set(key, id);
    }
    vid[i] = id;
  }

  const parent = new Int32Array(vmap.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr ? idxArr[t * 3] : t * 3;
    const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
    const r0 = find(vid[i0]);
    const r1 = find(vid[i1]);
    const r2 = find(vid[i2]);
    parent[r1] = r0;
    parent[r2] = r0;
  }

  const islandTris = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr ? idxArr[t * 3] : t * 3;
    const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
    const root = find(vid[i0]);
    let list = islandTris.get(root);
    if (!list) {
      list = [];
      islandTris.set(root, list);
    }
    list.push(i0, i1, i2);
  }

  const buf = doc.getRoot().listBuffers()[0];
  const rooms: Array<{ prim: Primitive; minX: number; maxX: number; minZ: number; maxZ: number }> = [];

  for (const tris of islandTris.values()) {
    const remap = new Map<number, number>();
    const newIdx = new Uint32Array(tris.length);
    const newPos: number[] = [];
    const newNorm: number[] = [];
    const newUv: number[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (let k = 0; k < tris.length; k++) {
      const oldV = tris[k];
      let newV = remap.get(oldV);
      if (newV === undefined) {
        newV = newPos.length / 3;
        remap.set(oldV, newV);
        const px = posArr[oldV * 3];
        const py = posArr[oldV * 3 + 1];
        const pz = posArr[oldV * 3 + 2];
        newPos.push(px, py, pz);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minZ = Math.min(minZ, pz);
        maxZ = Math.max(maxZ, pz);
        if (normArr) newNorm.push(normArr[oldV * 3], normArr[oldV * 3 + 1], normArr[oldV * 3 + 2]);
        if (uvArr) newUv.push(uvArr[oldV * 2], uvArr[oldV * 2 + 1]);
      }
      newIdx[k] = newV;
    }

    const p = doc.createPrimitive();
    if (mat) p.setMaterial(mat);
    p.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(newPos)).setBuffer(buf),
    );
    if (normArr) {
      p.setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(new Float32Array(newNorm)).setBuffer(buf),
      );
    }
    if (uvArr) {
      p.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor().setType('VEC2').setArray(new Float32Array(newUv)).setBuffer(buf),
      );
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buf));
    rooms.push({ prim: p, minX, maxX, minZ, maxZ });
  }

  if (sortByCoords) {
    rooms.sort(
      (a, b) =>
        Math.round(a.minZ * 10) - Math.round(b.minZ * 10) ||
        Math.round(a.minX * 10) - Math.round(b.minX * 10),
    );
  }
  return rooms;
}

/**
 * Splits a merged decorative furniture primitive into spatial 2.5m x 2.5m grid cells
 * so that `box.setFromObject(f)` produces tight local obstacle footprints instead of one giant 47m x 47m box.
 */
function splitDecorationIntoSpatialClusters(
  doc: Document,
  prim: Primitive,
  cellSizeM = 1.6,
): Primitive[] {
  const posAcc = prim.getAttribute('POSITION')!;
  const normAcc = prim.getAttribute('NORMAL');
  const uvAcc = prim.getAttribute('TEXCOORD_0');
  const idxAcc = prim.getIndices();
  const mat = prim.getMaterial();

  const posArr = posAcc.getArray() as Float32Array;
  const normArr = normAcc ? (normAcc.getArray() as Float32Array) : null;
  const uvArr = uvAcc ? (uvAcc.getArray() as Float32Array) : null;
  const idxArr = idxAcc ? (idxAcc.getArray() as Uint32Array | Uint16Array) : null;
  const triCount = idxArr ? idxArr.length / 3 : posArr.length / 9;

  const cellTris = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const i0 = idxArr ? idxArr[t * 3] : t * 3;
    const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
    const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;

    const cx = (posArr[i0 * 3] + posArr[i1 * 3] + posArr[i2 * 3]) / 3;
    const cz = (posArr[i0 * 3 + 2] + posArr[i1 * 3 + 2] + posArr[i2 * 3 + 2]) / 3;
    const key = `${Math.floor(cx / cellSizeM)}_${Math.floor(cz / cellSizeM)}`;
    let arr = cellTris.get(key);
    if (!arr) {
      arr = [];
      cellTris.set(key, arr);
    }
    arr.push(i0, i1, i2);
  }

  const buf = doc.getRoot().listBuffers()[0];
  const out: Primitive[] = [];
  for (const tris of cellTris.values()) {
    const remap = new Map<number, number>();
    const newIdx = new Uint32Array(tris.length);
    const newPos: number[] = [];
    const newNorm: number[] = [];
    const newUv: number[] = [];

    for (let k = 0; k < tris.length; k++) {
      const oldV = tris[k];
      let newV = remap.get(oldV);
      if (newV === undefined) {
        newV = newPos.length / 3;
        remap.set(oldV, newV);
        newPos.push(posArr[oldV * 3], posArr[oldV * 3 + 1], posArr[oldV * 3 + 2]);
        if (normArr) newNorm.push(normArr[oldV * 3], normArr[oldV * 3 + 1], normArr[oldV * 3 + 2]);
        if (uvArr) newUv.push(uvArr[oldV * 2], uvArr[oldV * 2 + 1]);
      }
      newIdx[k] = newV;
    }

    const p = doc.createPrimitive();
    if (mat) p.setMaterial(mat);
    p.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(newPos)).setBuffer(buf),
    );
    if (normArr) {
      p.setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setArray(new Float32Array(newNorm)).setBuffer(buf),
      );
    }
    if (uvArr) {
      p.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor().setType('VEC2').setArray(new Float32Array(newUv)).setBuffer(buf),
      );
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buf));
    out.push(p);
  }
  return out;
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });

  console.log('Reading assets/l13-floorplan.glb...');
  const doc = await io.read('assets/l13-floorplan.glb');
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const origNodes = scene.listChildren();

  // Create semantic top-level groups matching L12 structure
  const rootNode = doc.createNode('l13-floorplan');
  const floorsGroup = doc.createNode('floors');
  const wallsGroup = doc.createNode('walls');
  const doorsGroup = doc.createNode('doors');
  const furnitureGroup = doc.createNode('furniture');
  rootNode.addChild(floorsGroup).addChild(wallsGroup).addChild(doorsGroup).addChild(furnitureGroup);

  for (const n of origNodes) scene.removeChild(n);
  scene.addChild(rootNode);

  // Bounding boxes (in metres) for our semantic L13 resources:
  const DESK_BOXES: SubBox[] = [
    { name: 'furniture_Desk_13_001', minX: 27.0, maxX: 28.05, minZ: 3.7, maxZ: 4.35 },
    { name: 'furniture_Desk_13_002', minX: 28.15, maxX: 29.15, minZ: 3.7, maxZ: 4.35 },
    { name: 'furniture_Desk_13_003', minX: 29.3, maxX: 30.3, minZ: 3.7, maxZ: 4.35 },
  ];

  const KIOSK_BOXES: SubBox[] = [
    { name: 'furniture_WAYFINDING_KIOSK_L13_1', minX: 30.0, maxX: 31.8, minZ: 9.8, maxZ: 11.2 },
    { name: 'furniture_WAYFINDING_KIOSK_L13_2', minX: 27.8, maxX: 29.3, minZ: 41.0, maxZ: 42.5 },
  ];

  const LIFT_BOXES: SubBox[] = [
    { name: 'door_WAYFINDING_LIFT_13_1', minX: 23.8, maxX: 26.0, minZ: 18.6, maxZ: 20.5 },
    { name: 'door_WAYFINDING_LIFT_13_2', minX: 28.0, maxX: 30.1, minZ: 13.7, maxZ: 15.6 },
  ];

  const targetPrimBuckets = new Map<string, Primitive[]>();
  const addTargetPrim = (name: string, prims: Primitive[]) => {
    const list = targetPrimBuckets.get(name) ?? [];
    list.push(...prims);
    targetPrimBuckets.set(name, list);
  };

  const decorPrimsToCluster: Primitive[] = [];

  let totalRoomsExtracted = 0;
  let meetingRoomCount = 0;
  let privateRoomCount = 0;
  let focusRoomCount = 0;

  for (let i = 0; i < origNodes.length; i++) {
    const node = origNodes[i];
    const mesh = node.getMesh();
    if (!mesh) continue;
    const prims = mesh.listPrimitives();
    const matName = prims[0]?.getMaterial()?.getName() ?? '';

    // Room floor material groups: Enclosed bookable rooms on Level 13!
    // Classify strictly by material name (instead of node index) so adding/removing nodes in assets/l13-floorplan.glb never shifts indices:
    //   - room_342_2014: 37 Private Rooms -> PrivateRoom_13_<roomNumber>
    //   - room_349_2028: 8 Meeting Rooms  -> MeetingRoom_13_<roomNumber>
    //   - room_364_2058: 5 Focus Rooms    -> FocusRoom_13_<roomNumber>
    //   - room_386_2102: 2 Meeting Rooms  -> MeetingRoom_13_<roomNumber>
    if (
      matName === 'room_342_2014' ||
      matName === 'room_349_2028' ||
      matName === 'room_364_2058' ||
      matName === 'room_386_2102'
    ) {
      for (const p of prims) {
        scalePrimitivePositions(p);
        const rooms = splitFloorIntoConnectedRooms(doc, p, false);
        for (const r of rooms) {
          totalRoomsExtracted++;
          let roomIndex: number;
          let prefix: string;
          if (matName === 'room_342_2014') {
            // 37 Private Rooms (numbered 1..23 and 29..42, so PrivateRoom_13_42 is included)
            privateRoomCount++;
            prefix = 'PrivateRoom';
            roomIndex = privateRoomCount <= 23 ? privateRoomCount : privateRoomCount + 5;
          } else if (matName === 'room_364_2058') {
            // 5 Focus Rooms (numbered 24..28, so FocusRoom_13_28 is included)
            focusRoomCount++;
            prefix = 'FocusRoom';
            roomIndex = 23 + focusRoomCount; // 24..28
          } else {
            // room_349_2028 (8 rooms) & room_386_2102 (2 rooms) = 10 Meeting Rooms (numbered 43..52, so MeetingRoom_13_52 is included)
            meetingRoomCount++;
            prefix = 'MeetingRoom';
            roomIndex = 42 + meetingRoomCount; // 43..52
          }
          const roomId = `${prefix}_13_${roomIndex}`;
          const nodeName = `floor_room-l13_${roomId}`;
          const rmMesh = doc.createMesh(nodeName).addPrimitive(r.prim);
          const rmNode = doc
            .createNode(nodeName)
            .setMesh(rmMesh)
            .setExtras({
              type: 'floor',
              roomName: roomId,
              displayName: roomId,
            });
          floorsGroup.addChild(rmNode);
        }
      }
      node.dispose();
      continue;
    }

    // General non-clickable floor meshes (corridors, open office, utility areas)
    if (matName === 'ground_1' || matName.startsWith('room_')) {
      for (const p of prims) scalePrimitivePositions(p);
      node.setName(`floor_room_Level13_${i}`);
      floorsGroup.addChild(node);
      continue;
    }

    // Walls mesh
    if (matName === 'wall_1_2') {
      for (const p of prims) scalePrimitivePositions(p);
      node.setName('wall_Level13_1');
      wallsGroup.addChild(node);
      continue;
    }

    // Lift meshes -> split into LIFT_13_1, LIFT_13_2, and remaining lift bank walls
    if (
      matName === 'metal' ||
      matName === 'sweethome3d_window_mirror' ||
      matName === 'light' ||
      matName === 'guide' ||
      matName === 'display' ||
      matName.startsWith('Circle_2') ||
      /^2[23]\d\d(-\d+)?$/.test(matName)
    ) {
      for (const p of prims) {
        const { matched, remainder } = splitPrimitiveByBoxes(doc, p, LIFT_BOXES);
        for (const [k, v] of matched) addTargetPrim(k, v);
        if (remainder) {
          const remMesh = doc.createMesh(`wall_liftbank_${i}`).addPrimitive(remainder);
          wallsGroup.addChild(doc.createNode(`wall_liftbank_${i}`).setMesh(remMesh));
        }
      }
      node.dispose();
      continue;
    }

    // Desk_13_001..003 desktop & frame
    if (matName === 'WhiteDesktop' || matName === 'MetalFrame') {
      for (const p of prims) {
        const { matched, remainder } = splitPrimitiveByBoxes(doc, p, DESK_BOXES);
        for (const [k, v] of matched) addTargetPrim(k, v);
        if (remainder) decorPrimsToCluster.push(remainder);
      }
      node.dispose();
      continue;
    }

    // WAYFINDING_KIOSK_L13_1 and WAYFINDING_KIOSK_L13_2
    if (matName === 'default') {
      for (const p of prims) {
        const { matched, remainder } = splitPrimitiveByBoxes(doc, p, KIOSK_BOXES);
        for (const [k, v] of matched) addTargetPrim(k, v);
        if (remainder) decorPrimsToCluster.push(remainder);
      }
      node.dispose();
      continue;
    }

    // Door meshes (including 'white' open-door leaves and 'yellowbrt' brass door handles across all L13 rooms)
    if (
      matName === 'white' ||
      matName === 'yellowbrt' ||
      matName.startsWith('Door_') ||
      matName.includes('sweethome3d_hinge') ||
      matName.includes('sweethome3d_opening_on_hinge') ||
      matName === 'frame' ||
      matName === 'hinge' ||
      matName === 'handle' ||
      matName === 'door' ||
      matName.startsWith('frame_door_')
    ) {
      for (const p of prims) scalePrimitivePositions(p);
      node.setName(`door_Open_door_${i}`);
      doorsGroup.addChild(node);
      continue;
    }

    // All other nodes: decorative furniture
    for (const p of prims) {
      scalePrimitivePositions(p);
      decorPrimsToCluster.push(p);
    }
    node.dispose();
  }

  // Create synthetic floor coverage quads inside the outer wall perimeter (7.45..58.80 x 3.40..53.50)
  // so NavGrid has 100% floor coverage even where obj2gltf left gaps in ground_1
  const buf = doc.getRoot().listBuffers()[0];
  const fullFloorPrim = doc.createPrimitive();
  const groundMat = root.listMaterials().find((m) => m.getName() === 'ground_1');

  // If the 52 room polygons were merged into `wall_1_2` as y=2.50m ceiling polygons
  // instead of separate `room_*` floor materials, extract them from `wall_Level13_1` now:
  if (totalRoomsExtracted === 0) {
    const wallNode = wallsGroup.listChildren().find((n) => n.getName() === 'wall_Level13_1');
    const wallPrim = wallNode?.getMesh()?.listPrimitives()[0];
    if (wallPrim) {
      const fallbackRooms = extractRoomsFromWallMesh(doc, wallPrim, groundMat ?? null);
      for (const r of fallbackRooms) {
        totalRoomsExtracted++;
        if (r.roomId.startsWith('MeetingRoom_')) meetingRoomCount++;
        else if (r.roomId.startsWith('FocusRoom_')) focusRoomCount++;
        else privateRoomCount++;

        const nodeName = `floor_room-l13_${r.roomId}`;
        const rmMesh = doc.createMesh(nodeName).addPrimitive(r.prim);
        const rmNode = doc
          .createNode(nodeName)
          .setMesh(rmMesh)
          .setExtras({
            type: 'floor',
            roomName: r.roomId,
            displayName: r.roomId,
          });
        floorsGroup.addChild(rmNode);
      }
    }
  }
  if (groundMat) fullFloorPrim.setMaterial(groundMat);
  fullFloorPrim.setAttribute(
    'POSITION',
    doc
      .createAccessor()
      .setType('VEC3')
      .setArray(
        new Float32Array([
          7.45, -0.005, 3.4,
          58.8, -0.005, 3.4,
          58.8, -0.005, 53.5,
          7.45, -0.005, 53.5,
        ]),
      )
      .setBuffer(buf),
  );
  fullFloorPrim.setAttribute(
    'NORMAL',
    doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]))
      .setBuffer(buf),
  );
  fullFloorPrim.setIndices(
    doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 2, 1, 0, 3, 2])).setBuffer(buf),
  );
  const fullFloorMesh = doc.createMesh('floor_room_Level13_full').addPrimitive(fullFloorPrim);
  floorsGroup.addChild(doc.createNode('floor_room_Level13_full').setMesh(fullFloorMesh));

  // Create named nodes for Lifts, Desks, and Kiosks
  for (const [name, prims] of targetPrimBuckets.entries()) {
    const m = doc.createMesh(name);
    for (const p of prims) m.addPrimitive(p);
    const n = doc.createNode(name).setMesh(m);
    if (name.startsWith('door_')) {
      doorsGroup.addChild(n);
    } else {
      furnitureGroup.addChild(n);
    }
  }

  // Group decorative furniture primitives into 0.9m x 0.9m spatial cluster nodes
  // so obstacle bounding boxes are localized per desk/chair without sealing aisles
  console.log('Clustering decorative furniture into spatial nodes...');
  let clusterIdx = 0;
  for (const p of decorPrimsToCluster) {
    const subPrims = splitDecorationIntoSpatialClusters(doc, p, 0.9);
    for (const sp of subPrims) {
      clusterIdx++;
      const name = `furniture_Decor_${clusterIdx}`;
      const m = doc.createMesh(name).addPrimitive(sp);
      furnitureGroup.addChild(doc.createNode(name).setMesh(m));
    }
    p.dispose();
  }
  console.log(`Created ${clusterIdx} localized decorative furniture nodes.`);

  // Clean up unused meshes/accessors before heavy simplification
  // NOTE: Skip weld/simplify on floor meshes (floorsGroup) so concave floor triangles aren't collapsed!
  await doc.transform(
    prune(),
    dedup(),
  );

  // Only weld and simplify non-floor meshes
  const savedFloorNodes = floorsGroup.listChildren();
  for (const fgChild of savedFloorNodes) {
    floorsGroup.removeChild(fgChild);
  }
  await doc.transform(
    weld({ tolerance: 0.004 }),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.025, error: 0.25, lockBorder: false }),
  );
  // Restore all floor meshes (including individual MeetingRoom_13_*, PrivateRoom_13_*, FocusRoom_13_*) intact
  for (const n of savedFloorNodes) {
    floorsGroup.addChild(n);
  }
  console.log(
    `L13 Rooms extracted: ${meetingRoomCount} Meeting Rooms, ${privateRoomCount} Private Rooms, ${focusRoomCount} Focus Rooms`,
  );

  await doc.transform(
    reorder({ encoder: MeshoptEncoder }),
    quantize(),
  );

  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
    method: EXTMeshoptCompression.EncoderMethod.FILTER,
  });
  doc.createExtension(KHRMeshQuantization).setRequired(true);

  console.log('Writing public/models/l13-floorplan.glb...');
  await io.write('public/models/l13-floorplan.glb', doc);
  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
