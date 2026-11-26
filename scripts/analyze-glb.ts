/**
 * Client-agnostic GLB Floor Plan Analyzer CLI.
 *
 * Reads `public/data/kiosk-config.json` (`resourceTypes`) and inspects any `.glb` file to report:
 *   - Matched bookable resources (Meeting Rooms, Private Rooms, Focus Rooms, Phone Booths, Desks, etc.)
 *   - Lifts, Kiosks, and Amenities
 *   - Ceiling-only named rooms (missing floor plates — run `assemble-floorplan.ts`)
 *   - Unmatched named room/door nodes (potential typos or new client resource types to add to config)
 *   - Ready-to-paste `kiosk-config.json` floor & kiosk entries
 *
 * Usage:
 *   npm run analyze-glb -- public/models/floorplan.glb
 *   npm run analyze-glb -- assets/l14/l14-floorplan-base.glb --json
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  DEFAULT_RESOURCE_TYPES,
  type ResourceTypeConfig,
} from '../src/app/wayfinding/kiosk-config';
import {
  formatResourcePropertyName,
  matchResource,
  setRuntimeResourceTypes,
} from '../src/app/wayfinding/resource-config';

interface DiscoveredItem {
  id: string;
  name: string;
  code: string;
  level: string;
  kind: string;
  resourceType: string;
  bookable: boolean;
  nodeName: string;
}

function loadConfiguredResourceTypes(): ResourceTypeConfig[] {
  const cfgPath = resolve(process.cwd(), 'public/data/kiosk-config.json');
  if (!existsSync(cfgPath)) return [...DEFAULT_RESOURCE_TYPES];
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      resourceTypes?: ResourceTypeConfig[];
    };
    return Array.isArray(parsed.resourceTypes) && parsed.resourceTypes.length > 0
      ? parsed.resourceTypes
      : [...DEFAULT_RESOURCE_TYPES];
  } catch {
    return [...DEFAULT_RESOURCE_TYPES];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    console.error('Usage: npm run analyze-glb -- <path/to/floorplan.glb> [--json]');
    process.exit(1);
  }

  const configuredTypes = loadConfiguredResourceTypes();
  setRuntimeResourceTypes(configuredTypes);

  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

  const absPath = resolve(process.cwd(), filePath);
  const doc = await io.read(absPath);

  const bookable: DiscoveredItem[] = [];
  const lifts: DiscoveredItem[] = [];
  const kiosks: DiscoveredItem[] = [];
  const amenities: DiscoveredItem[] = [];
  const ceilingOnlyRooms: string[] = [];
  const unmatchedNamed: string[] = [];

  const seenIds = new Set<string>();
  const floorRoomSuffixes = new Set<string>();
  const ceilingNamedNodes: string[] = [];

  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (!name) continue;

    const floorMatch = name.match(/^floor_room-.+?_(.+)$/);
    if (floorMatch) floorRoomSuffixes.add(floorMatch[1]);

    const ceilingMatch = name.match(/^ceiling_room-.+?_(.+)$/);
    if (ceilingMatch && !/^Room_\d+$/i.test(ceilingMatch[1])) {
      ceilingNamedNodes.push(ceilingMatch[1]);
    }

    const matched = matchResource(name);
    if (matched) {
      const id = matched.rule.id(matched.match);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const item: DiscoveredItem = {
        id,
        name: formatResourcePropertyName(id) || matched.rule.name(matched.match),
        code: matched.rule.code(matched.match),
        level: matched.rule.level(matched.match),
        kind: matched.rule.kind,
        resourceType: matched.rule.defaultSubType ?? matched.rule.kind,
        bookable: matched.rule.bookable,
        nodeName: name,
      };

      if (item.bookable) bookable.push(item);
      else if (item.kind === 'lift') lifts.push(item);
      else if (item.kind === 'kiosk') kiosks.push(item);
      else amenities.push(item);
    } else if (
      (floorMatch && !/^Room_\d+$/i.test(floorMatch[1])) ||
      (/^door_/i.test(name) &&
        !/_frame_|_hinge_|_handle|_door_|_Circle_|_Plane_|_mirror_|^door_Door/i.test(name) &&
        !name.includes('_sweethome3d_'))
    ) {
      unmatchedNamed.push(name);
    }
  }

  for (const suffix of ceilingNamedNodes) {
    if (!floorRoomSuffixes.has(suffix)) {
      ceilingOnlyRooms.push(suffix);
    }
  }

  const detectedLevel =
    bookable[0]?.level ?? kiosks[0]?.level ?? lifts[0]?.level ?? amenities[0]?.level ?? '1';
  const fileName = basename(absPath);

  const starterFloorConfig = {
    id: `Level ${detectedLevel}`,
    level: detectedLevel,
    shortCode: `L${detectedLevel}`,
    modelUrl: `models/${fileName}`,
    site: 'Main Building',
  };

  const starterKioskDevices = kiosks.map((k, idx) => ({
    deviceId: `l${k.level}-${idx + 1}`,
    resourceId: k.id,
    label: `Kiosk L${k.level}-${idx + 1} (Level ${k.level})`,
    floorId: `Level ${k.level}`,
    level: k.level,
    aliases: [`l${k.level}-${idx + 1}`, k.id.toLowerCase()],
  }));

  const report = {
    file: filePath,
    detectedLevel,
    configuredBookableTypes: configuredTypes.filter((t) => t.bookable).map((t) => t.key),
    summary: {
      bookable: bookable.length,
      lifts: lifts.length,
      kiosks: kiosks.length,
      amenities: amenities.length,
      ceilingOnlyRooms: ceilingOnlyRooms.length,
      unmatchedNamedNodes: unmatchedNamed.length,
    },
    bookable,
    lifts,
    kiosks,
    amenities,
    ceilingOnlyRooms,
    unmatchedNamedNodes: unmatchedNamed,
    starterConfig: {
      floor: starterFloorConfig,
      kioskDevices: starterKioskDevices,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n=== GLB Analysis Report: ${filePath} ===`);
  console.log(`Detected Floor Level: Level ${detectedLevel}`);
  console.log(
    `Configured Bookable Types: ${report.configuredBookableTypes.join(', ')}\n`,
  );

  const byType = new Map<string, number>();
  for (const b of bookable) byType.set(b.resourceType, (byType.get(b.resourceType) ?? 0) + 1);

  console.log(`Bookable Resources (${bookable.length}):`);
  for (const [type, count] of byType) console.log(`  - ${type}: ${count}`);
  console.log(`Lifts (${lifts.length}): ${lifts.map((l) => l.id).join(', ') || 'None'}`);
  console.log(`Kiosks (${kiosks.length}): ${kiosks.map((k) => k.id).join(', ') || 'None'}`);
  console.log(`Amenities (${amenities.length}): ${amenities.map((a) => a.name).join(', ') || 'None'}`);

  if (ceilingOnlyRooms.length) {
    console.log(
      `\n⚠ Ceiling-Only Named Rooms (${ceilingOnlyRooms.length}) — run assemble-floorplan.ts to synthesize clickable floor plates:`,
    );
    console.log(`  ${ceilingOnlyRooms.slice(0, 15).join(', ')}${ceilingOnlyRooms.length > 15 ? ' ...' : ''}`);
  }

  if (unmatchedNamed.length) {
    console.log(
      `\nℹ Unmatched Named Nodes (${unmatchedNamed.length}) — add to resourceTypes in kiosk-config.json if bookable:`,
    );
    console.log(`  ${unmatchedNamed.slice(0, 15).join(', ')}${unmatchedNamed.length > 15 ? ' ...' : ''}`);
  }

  console.log('\nStarter kiosk-config.json snippet:');
  console.log(JSON.stringify(report.starterConfig, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
