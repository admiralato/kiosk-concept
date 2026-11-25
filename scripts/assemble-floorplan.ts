/**
 * Generic multi-part floorplan assembler & optimizer.
 *
 * Usage:
 *   NODE_OPTIONS='--max-old-space-size=8192' tsx scripts/assemble-floorplan.ts <inputDir> <outputGlb>
 *
 * Example:
 *   NODE_OPTIONS='--max-old-space-size=8192' tsx scripts/assemble-floorplan.ts assets/l13 public/models/l13-floorplan.glb
 *
 * Conventions for divided floorplans in `<inputDir>`:
 *   - `*-base.glb` (required): Contains the architectural shell (`floors`, `walls`, `doors`, `ceilings`, `rooms`, kiosks).
 *   - All other `*.glb` files in `<inputDir>` (`*-desks_*.glb`, `*-lifts.glb`, `*-focusrooms.glb`,
 *     `*-meetingrooms.glb`, `*-privaterooms.glb`, etc.) are layered on top of `-base.glb` in the exact
 *     same Sweet Home 3D world coordinate system:
 *       - `doors` children are appended into the merged `doors` group
 *       - `furniture` children are appended into the merged `furniture` group
 *       - `walls` / `floors` children (if any) are appended into the merged `walls` / `floors` groups
 *
 * Room floor plate synthesis:
 *   - When Sweet Home 3D exports rooms with hidden/unset floor polygons (only `ceiling_room-<uuid>_<Name>`
 *     at y=2.50m exists), this script automatically projects each named room's ceiling polygon down to
 *     y=0.0m (`floor_room-<uuid>_<Name>`) with upward normal so every Meeting Room, Private Room, Focus Room,
 *     and Toilet has an exact clickable floor plate and 100% floor coverage in the NavGrid.
 *   - Normalizes minor typos in room names (e.g. `MeetingRoom_13-32` -> `MeetingRoom_13_32`) and resolves
 *     duplicate room names (e.g. second `MeetingRoom_13_13` -> `MeetingRoom_13_1` when matching furniture group).
 *
 * Optimization:
 *   - Simplifies each heavy furniture/desk part individually BEFORE merging to keep peak RAM low and
 *     reduce ~1.1 GB of raw divided GLBs down to a fast Meshopt-compressed GLB for SpaceBoard PC.
 */
import { Document, NodeIO, Node as GNode, Primitive, Accessor, Material } from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from '@gltf-transform/extensions';
import {
  dedup,
  joinPrimitives,
  mergeDocuments,
  prune,
  quantize,
  reorder,
  simplify,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const SEMANTIC_GROUPS = ['floors', 'walls', 'doors', 'furniture', 'ceilings', 'rooms'] as const;

/** Normalizes a raw Sweet Home 3D room suffix (e.g. `MeetingRoom_13-32` -> `MeetingRoom_13_32`). */
function normalizeRoomSuffix(raw: string): string {
  return raw.replace(/^(MeetingRoom|PrivateRoom|FocusRoom|Desk)_(\d+)-(\d+)$/, '$1_$2_$3');
}

/**
 * Projects a ceiling node's geometry (y ~= 2.5m, normal -Y) down to y = 0.0m with normal +Y
 * to create a clickable `floor_room-...` polygon for rooms whose floor wasn't exported.
 */
function createFloorFromCeilingNode(
  doc: Document,
  ceilNode: GNode,
  floorName: string,
  roomName: string,
  floorMat: Material | null,
): GNode | null {
  const srcMesh = ceilNode.getMesh();
  if (!srcMesh) return null;
  const buf = doc.getRoot().listBuffers()[0];
  const newMesh = doc.createMesh(floorName);

  for (const srcPrim of srcMesh.listPrimitives()) {
    const posAcc = srcPrim.getAttribute('POSITION');
    if (!posAcc) continue;
    const posArr = posAcc.getArray() as Float32Array;
    const idxAcc = srcPrim.getIndices();
    const idxArr = idxAcc ? (idxAcc.getArray() as Uint32Array | Uint16Array) : null;

    const newPos = new Float32Array(posArr.length);
    const newNorm = new Float32Array(posArr.length);
    for (let i = 0; i < posArr.length; i += 3) {
      newPos[i] = posArr[i];
      newPos[i + 1] = 0.002;
      newPos[i + 2] = posArr[i + 2];
      newNorm[i] = 0;
      newNorm[i + 1] = 1;
      newNorm[i + 2] = 0;
    }

    const triCount = idxArr ? idxArr.length / 3 : posArr.length / 9;
    const newIdx = new Uint32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = idxArr ? idxArr[t * 3] : t * 3;
      const i1 = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
      const i2 = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
      // Flip winding order so normal faces +Y
      newIdx[t * 3] = i0;
      newIdx[t * 3 + 1] = i2;
      newIdx[t * 3 + 2] = i1;
    }

    const p = doc.createPrimitive();
    if (floorMat) p.setMaterial(floorMat);
    p.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(newPos).setBuffer(buf),
    );
    p.setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(newNorm).setBuffer(buf),
    );
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buf));
    newMesh.addPrimitive(p);
  }

  if (newMesh.listPrimitives().length === 0) return null;
  return doc
    .createNode(floorName)
    .setMesh(newMesh)
    .setExtras({
      ...(ceilNode.getExtras() ?? {}),
      type: 'floor',
      roomName,
      displayName: roomName,
    });
}

/** Finds a named semantic collection node inside a document's first scene. */
function findGroup(doc: Document, groupName: string): GNode | null {
  for (const n of doc.getRoot().listNodes()) {
    if (n.getName() === groupName) return n;
  }
  return null;
}

/** Computes world XZ bounding box of a node subtree. */
function subtreeBoundsXZ(node: GNode): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const visit = (n: GNode) => {
    const mesh = n.getMesh();
    if (mesh) {
      for (const p of mesh.listPrimitives()) {
        const pos = p.getAttribute('POSITION');
        if (!pos) continue;
        const arr = pos.getArray() as Float32Array;
        for (let i = 0; i < arr.length; i += 3) {
          minX = Math.min(minX, arr[i]);
          maxX = Math.max(maxX, arr[i]);
          minZ = Math.min(minZ, arr[i + 2]);
          maxZ = Math.max(maxZ, arr[i + 2]);
        }
      }
    }
    for (const c of n.listChildren()) visit(c);
  };
  visit(node);
  return { minX, maxX, minZ, maxZ };
}

/**
 * Joins all primitives sharing the same material inside each mesh of `doc`.
 * Sweet Home 3D exports high-detail chairs (e.g. `furniture_Adjustable_Office_Chair`)
 * as 500+ separate tiny primitives per chair -> 210,000+ WebGL draw calls!
 * Joining per-mesh primitives by material reduces each chair to ~2–4 draw calls
 * while keeping every furniture node's exact position and bounding box intact.
 */
function joinMeshPrimitivesByMaterial(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    const prims = mesh.listPrimitives();
    if (prims.length <= 1) continue;

    // Group primitives by (material, mode, attribute signature)
    const groups = new Map<string, Primitive[]>();
    for (const p of prims) {
      const mat = p.getMaterial();
      const matKey = mat ? `${mat.getName()}_${doc.getRoot().listMaterials().indexOf(mat)}` : 'none';
      const attrKey = p.listSemantics().sort().join(',');
      const key = `${p.getMode()}|${matKey}|${attrKey}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(p);
    }

    let changed = false;
    for (const list of groups.values()) {
      if (list.length <= 1) continue;
      changed = true;
      const joined = joinPrimitives(list);
      mesh.addPrimitive(joined);
      for (const old of list) {
        mesh.removePrimitive(old);
        old.dispose();
      }
    }
    if (changed) {
      // Nothing else needed; unused accessors are cleaned up by prune()
    }
  }
}

/**
 * Removes duplicate/unused empty collection wrappers and simplifies heavy decorative meshes
 * in a single part document before merging into the base document.
 */
async function preprocessPart(
  io: NodeIO,
  filePath: string,
  isHeavyFurniturePart: boolean,
): Promise<Document> {
  const name = basename(filePath);
  const doc = await io.read(filePath);

  // Drop empty rooms/ceilings/floors/walls/doors in overlay parts so only real content is merged
  for (const gName of ['rooms', 'ceilings']) {
    const g = findGroup(doc, gName);
    if (g) {
      for (const c of g.listChildren()) c.dispose();
      g.dispose();
    }
  }

  // Join primitives by material FIRST (collapsing 527 tiny pieces per chair into ~3 unified meshes),
  // THEN weld vertices across the joined mesh and gently simplify with a tight geometric error (0.01–0.015)
  // so chair seats, backrests, and frames stay completely solid without holes or shredded triangles!
  joinMeshPrimitivesByMaterial(doc);

  if (isHeavyFurniturePart) {
    const ratio = name.includes('desks_') ? 0.15 : 0.25;
    const error = name.includes('desks_') ? 0.015 : 0.01;
    await doc.transform(
      weld({ tolerance: 0.002 }),
      simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
      prune(),
      reorder({ encoder: MeshoptEncoder }),
      quantize(),
    );
  } else {
    await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }), quantize());
  }

  return doc;
}

async function main() {
  const inputDir = process.argv[2] ?? 'assets/l13';
  const outputPath = process.argv[3] ?? 'public/models/l13-floorplan.glb';

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });

  const allGlbs = readdirSync(inputDir)
    .filter((f) => f.toLowerCase().endsWith('.glb') && !f.startsWith('.'))
    .sort();

  const baseFile =
    allGlbs.find((f) => f.toLowerCase().includes('-base.glb')) ??
    (allGlbs.length === 1 ? allGlbs[0] : undefined);
  if (!baseFile) {
    throw new Error(`No *-base.glb (or single .glb) file found in ${inputDir}`);
  }
  const overlayFiles = allGlbs.filter((f) => f !== baseFile);

  console.log(`Base GLB:    ${join(inputDir, baseFile)}`);
  console.log(`Overlay GLBs (${overlayFiles.length}): ${overlayFiles.join(', ')}`);

  // 1. Load base floorplan and join per-mesh primitives by material
  const baseDoc = await io.read(join(inputDir, baseFile));
  joinMeshPrimitivesByMaterial(baseDoc);
  const baseScene = baseDoc.getRoot().listScenes()[0];
  const baseRoot =
    baseScene.listChildren()[0] ?? baseDoc.createNode(basename(baseFile, '.glb'));

  const ensureBaseGroup = (name: string): GNode => {
    let g = findGroup(baseDoc, name);
    if (!g) {
      g = baseDoc.createNode(name);
      baseRoot.addChild(g);
    }
    return g;
  };

  const baseFloors = ensureBaseGroup('floors');
  const baseWalls = ensureBaseGroup('walls');
  const baseDoors = ensureBaseGroup('doors');
  const baseFurniture = ensureBaseGroup('furniture');
  const baseCeilings = findGroup(baseDoc, 'ceilings');

  // 2. Synthesize clickable floor polygons from ceilings for all named rooms that don't have a floor node
  const existingFloorNames = new Set(baseFloors.listChildren().map((n) => n.getName()));
  // Create a clean neutral light-floor material (matching Level 12 room floor brightness)
  // for synthesized room floors so status overlays (Available/Reserve/Occupied) look identical to L12.
  const synthesizedFloorMat = baseDoc
    .createMaterial('synthesized_room_floor')
    .setBaseColorFactor([0.88, 0.87, 0.84, 1.0])
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0.0);

  const defaultFloorMat =
    baseFloors
      .listChildren()
      .map((n) => n.getMesh()?.listPrimitives()[0]?.getMaterial())
      .find((m) => !!m) ?? synthesizedFloorMat;

  // Track room IDs we've already created so duplicate room names (e.g. MeetingRoom_13_13 twice)
  // are disambiguated cleanly.
  const seenRoomIds = new Set<string>();
  for (const fn of baseFloors.listChildren()) {
    const nm = fn.getName();
    const m = nm.match(/^floor_room-.+?_(.+)$/);
    if (m) seenRoomIds.add(normalizeRoomSuffix(m[1]));
  }

  let synthesizedCount = 0;
  if (baseCeilings) {
    for (const cNode of baseCeilings.listChildren()) {
      const cName = cNode.getName();
      const match = cName.match(/^ceiling_(room-.+?)_(.+)$/);
      if (!match) continue;
      const roomUuid = match[1];
      let roomSuffix = normalizeRoomSuffix(match[2]);

      // Skip generic unnamed rooms like Room_57 (non-clickable background rooms)
      const isNamedResource =
        /^(MeetingRoom|PrivateRoom|FocusRoom)_\d+_\d+$/.test(roomSuffix) ||
        /^TOILET_(MALE|FEMALE|PWD)_L\d+$/i.test(roomSuffix) ||
        /^NURSING(_ROOM)?_L\d+$/i.test(roomSuffix);
      if (!isNamedResource) continue;

      // Disambiguate accidental duplicate room names (e.g., second MeetingRoom_13_13 -> MeetingRoom_13_1)
      if (seenRoomIds.has(roomSuffix)) {
        if (roomSuffix === 'MeetingRoom_13_13' && !seenRoomIds.has('MeetingRoom_13_1')) {
          roomSuffix = 'MeetingRoom_13_1';
        } else {
          let k = 2;
          while (seenRoomIds.has(`${roomSuffix}_${k}`)) k++;
          roomSuffix = `${roomSuffix}_${k}`;
        }
      }
      seenRoomIds.add(roomSuffix);

      const floorName = `floor_${roomUuid}_${roomSuffix}`;
      if (existingFloorNames.has(floorName)) continue;

      const fNode = createFloorFromCeilingNode(
        baseDoc,
        cNode,
        floorName,
        roomSuffix,
        synthesizedFloorMat,
      );
      if (fNode) {
        baseFloors.addChild(fNode);
        existingFloorNames.add(floorName);
        synthesizedCount++;
      }
    }
    // Remove ceilings from final output to save size (FloorplanEngine hides ceilings anyway)
    for (const c of baseCeilings.listChildren()) c.dispose();
    baseCeilings.dispose();
  }
  console.log(`Synthesized ${synthesizedCount} clickable room floor plates from base ceilings.`);

  // Also add a full perimeter floor slab at y=-0.005 so NavGrid has 100% floor coverage
  const baseBounds = subtreeBoundsXZ(baseWalls);
  if (Number.isFinite(baseBounds.minX)) {
    const buf = baseDoc.getRoot().listBuffers()[0];
    const slabPrim = baseDoc.createPrimitive();
    if (defaultFloorMat) slabPrim.setMaterial(defaultFloorMat);
    slabPrim.setAttribute(
      'POSITION',
      baseDoc
        .createAccessor()
        .setType('VEC3')
        .setArray(
          new Float32Array([
            baseBounds.minX + 0.05, -0.005, baseBounds.minZ + 0.05,
            baseBounds.maxX - 0.05, -0.005, baseBounds.minZ + 0.05,
            baseBounds.maxX - 0.05, -0.005, baseBounds.maxZ - 0.05,
            baseBounds.minX + 0.05, -0.005, baseBounds.maxZ - 0.05,
          ]),
        )
        .setBuffer(buf),
    );
    slabPrim.setAttribute(
      'NORMAL',
      baseDoc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]))
        .setBuffer(buf),
    );
    slabPrim.setIndices(
      baseDoc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 2, 1, 0, 3, 2])).setBuffer(buf),
    );
    const slabMesh = baseDoc.createMesh('floor_room_base_slab').addPrimitive(slabPrim);
    baseFloors.addChild(baseDoc.createNode('floor_room_base_slab').setMesh(slabMesh));
  }

  // 3. Layer every overlay GLB onto the base document
  for (const file of overlayFiles) {
    const fullPath = join(inputDir, file);
    const isHeavy = !file.toLowerCase().includes('-lifts.glb');
    console.log(`Merging overlay: ${file} (simplify=${isHeavy})...`);

    const partDoc = await preprocessPart(io, fullPath, isHeavy);
    const prevScenes = new Set(baseDoc.getRoot().listScenes());
    mergeDocuments(baseDoc, partDoc);

    // Find the newly merged scene and reparent its semantic children into base's semantic groups
    const newScenes = baseDoc.getRoot().listScenes().filter((s) => !prevScenes.has(s));
    for (const ns of newScenes) {
      const moveChildren = (groupName: string, targetGroup: GNode) => {
        const stack: GNode[] = [...ns.listChildren()];
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur.getName() === groupName) {
            for (const child of cur.listChildren()) {
              cur.removeChild(child);
              targetGroup.addChild(child);
            }
          } else {
            stack.push(...cur.listChildren());
          }
        }
      };

      moveChildren('floors', baseFloors);
      moveChildren('walls', baseWalls);
      moveChildren('doors', baseDoors);
      moveChildren('furniture', baseFurniture);

      // Dispose the temporary overlay scene and its now-empty shell nodes
      for (const rootChild of ns.listChildren()) {
        ns.removeChild(rootChild);
        rootChild.dispose();
      }
      ns.dispose();
    }
  }

  // 4. Consolidate all merged buffers into a single GLB buffer and apply Meshopt compression
  console.log('Consolidating buffers, pruning & applying Meshopt compression...');
  const primaryBuffer = baseDoc.getRoot().listBuffers()[0] ?? baseDoc.createBuffer();
  for (const acc of baseDoc.getRoot().listAccessors()) {
    acc.setBuffer(primaryBuffer);
  }
  for (const b of baseDoc.getRoot().listBuffers()) {
    if (b !== primaryBuffer) b.dispose();
  }
  await baseDoc.transform(prune());

  baseDoc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
    method: EXTMeshoptCompression.EncoderMethod.FILTER,
  });
  baseDoc.createExtension(KHRMeshQuantization).setRequired(true);

  console.log(
    `Summary -> floors: ${baseFloors.listChildren().length}, walls: ${baseWalls.listChildren().length}, doors: ${baseDoors.listChildren().length}, furniture: ${baseFurniture.listChildren().length}`,
  );
  console.log(`Writing ${outputPath}...`);
  await io.write(outputPath, baseDoc);
  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
