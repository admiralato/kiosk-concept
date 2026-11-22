/**
 * Kiosk Device & Floor Plan Configuration.
 *
 * Allows multiple physical kiosk machines (or desktop browser instances) to load
 * the same application URL while specifying their starting kiosk position via query
 * parameter, e.g.:
 *   - ?kioskId=l12-1  (or ?kioskId=WAYFINDING_KIOSK_L12_1) -> Level 12, Kiosk 12-1
 *   - ?kioskId=l13-1  (or ?kioskId=WAYFINDING_KIOSK_L13_1) -> Level 13, Kiosk 13-1
 *   - ?kioskId=l13-2  (or ?kioskId=WAYFINDING_KIOSK_L13_2) -> Level 13, Kiosk 13-2
 *
 * If `kioskId` is omitted or not found in `KIOSK_DEVICES`, the application falls
 * back to `DEFAULT_KIOSK_DEVICE_ID`.
 */

export interface FloorConfig {
  /** Human-readable floor label used in filters (e.g. 'Level 12'). */
  id: string;
  /** Numeric level string matching GLB resource rules (e.g. '12'). */
  level: string;
  /** Short badge code (e.g. 'L12'). */
  shortCode: string;
  /** Path to the optimized Meshopt GLB file in `public/models/`. */
  modelUrl: string;
  /** Site this floor belongs to. */
  site: string;
}

export interface KioskDeviceConfig {
  /** Short device identifier used in `?kioskId=<deviceId>` (case-insensitive). */
  deviceId: string;
  /** Exact 3D scene resource ID of this kiosk in the floor plan GLB. */
  resourceId: string;
  /** Human-friendly display label for this kiosk device. */
  label: string;
  /** Default floor loaded when this kiosk device boots. */
  floorId: string;
  /** Level number ('12', '13', etc.). */
  level: string;
  /** Alternate query-param aliases accepted for this kiosk device. */
  aliases: string[];
}

export const FLOOR_CONFIGS: ReadonlyArray<FloorConfig> = [
  {
    id: 'Level 12',
    level: '12',
    shortCode: 'L12',
    modelUrl: 'models/floorplan.glb',
    site: 'Marina Bay Tower',
  },
  {
    id: 'Level 13',
    level: '13',
    shortCode: 'L13',
    modelUrl: 'models/l13-floorplan.glb',
    site: 'Marina Bay Tower',
  },
];

export const KIOSK_DEVICES: ReadonlyArray<KioskDeviceConfig> = [
  {
    deviceId: 'l12-1',
    resourceId: 'WAYFINDING_KIOSK_L12_1',
    label: 'Kiosk L12-1 (Level 12 Lobby)',
    floorId: 'Level 12',
    level: '12',
    aliases: ['l12-1', 'l12_1', '12-1', '12_1', 'wayfinding_kiosk_l12_1', 'kiosk_l12_1'],
  },
  {
    deviceId: 'l13-1',
    resourceId: 'WAYFINDING_KIOSK_L13_1',
    label: 'Kiosk L13-1 (Level 13 North)',
    floorId: 'Level 13',
    level: '13',
    aliases: ['l13-1', 'l13_1', '13-1', '13_1', 'wayfinding_kiosk_l13_1', 'kiosk_l13_1'],
  },
  {
    deviceId: 'l13-2',
    resourceId: 'WAYFINDING_KIOSK_L13_2',
    label: 'Kiosk L13-2 (Level 13 South)',
    floorId: 'Level 13',
    level: '13',
    aliases: ['l13-2', 'l13_2', '13-2', '13_2', 'wayfinding_kiosk_l13_2', 'kiosk_l13_2'],
  },
];

/**
 * Fallback kiosk device ID used when `?kioskId=` is not provided or does not match
 * any registered device in `KIOSK_DEVICES`.
 */
export const DEFAULT_KIOSK_DEVICE_ID = 'l12-1';

/** Resolves a query parameter string (or null) to a valid `KioskDeviceConfig`. */
export function resolveKioskDevice(rawParam?: string | null): KioskDeviceConfig {
  const cleaned = (rawParam ?? '').trim().toLowerCase();
  if (cleaned) {
    const found = KIOSK_DEVICES.find(
      (d) => d.deviceId.toLowerCase() === cleaned || d.aliases.includes(cleaned),
    );
    if (found) return found;
  }
  return (
    KIOSK_DEVICES.find((d) => d.deviceId === DEFAULT_KIOSK_DEVICE_ID) ?? KIOSK_DEVICES[0]
  );
}

/** Reads `?kioskId=` (case-insensitive query key) from `window.location.search`. */
export function resolveKioskDeviceFromUrl(search = window.location.search): KioskDeviceConfig {
  const params = new URLSearchParams(search);
  let raw: string | null = null;
  for (const [key, val] of params.entries()) {
    if (key.toLowerCase() === 'kioskid' || key.toLowerCase() === 'kiosk') {
      raw = val;
      break;
    }
  }
  return resolveKioskDevice(raw);
}

export function getFloorConfig(floorIdOrLevel: string): FloorConfig {
  return (
    FLOOR_CONFIGS.find(
      (f) => f.id === floorIdOrLevel || f.level === floorIdOrLevel || f.shortCode === floorIdOrLevel,
    ) ?? FLOOR_CONFIGS[0]
  );
}
