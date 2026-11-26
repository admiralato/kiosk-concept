/**
 * Client-agnostic GLB Resource Classification Rules.
 *
 * Interactive & bookable resource types (MeetingRoom, PrivateRoom, FocusRoom, PhoneBooth,
 * HuddleRoom, Desk, etc.) are loaded dynamically at runtime from `public/data/kiosk-config.json`
 * (`resourceTypes`) via {@link setRuntimeResourceTypes}.
 *
 * Only objects whose names match one of the active rules become interactive resources.
 * All other furniture is treated strictly as decoration and pathfinding obstacles.
 */
import { DEFAULT_RESOURCE_TYPES, type ResourceTypeConfig } from './kiosk-config';

export type ResourceKind = 'meeting-room' | 'desk' | 'amenity' | 'lift' | 'kiosk';

export interface ResourceRule {
  kind: ResourceKind;
  /** Whether this resource type is bookable by users. */
  bookable: boolean;
  /** Default sub-type label assigned when not overridden by catalog JSON / API. */
  defaultSubType?: string;
  /** Default seating capacity when not overridden by catalog JSON / API. */
  defaultCapacity?: number;
  /** Default equipment list when not overridden by catalog JSON / API. */
  defaultEquipment?: string[];
  /** Optional custom color for non-bookable amenities. */
  color?: string;
  /** Matched against the node name of the GLB. */
  pattern: RegExp;
  /** Builds the stable resource id from the regex match. */
  id: (m: RegExpMatchArray) => string;
  /** Human-friendly display name shown on the kiosk. */
  name: (m: RegExpMatchArray) => string;
  /** Short code shown on map labels. */
  code: (m: RegExpMatchArray) => string;
  /** Level / floor number. */
  level: (m: RegExpMatchArray) => string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a single client-defined `ResourceTypeConfig` into a GLB node matching rule. */
function compileResourceTypeRule(cfg: ResourceTypeConfig): ResourceRule {
  const keyEsc = escapeRegExp(cfg.key.trim());
  const prefix =
    cfg.nodeGroup === 'floor'
      ? 'floor_room-.+?_'
      : cfg.nodeGroup === 'furniture'
        ? 'furniture_'
        : cfg.nodeGroup === 'door'
          ? 'door_'
          : '(?:floor_room-.+?_|furniture_|door_)';

  // Matches e.g. `floor_room-<uuid>_PhoneBooth_14_01` or `furniture_Desk_12_001` (also tolerates hyphen `14-01`)
  const pattern = new RegExp(`^${prefix}(${keyEsc}_(\\d+)[_-](\\d+))$`, 'i');

  return {
    kind: cfg.kind,
    bookable: cfg.bookable,
    defaultSubType: cfg.label,
    defaultCapacity: cfg.defaultCapacity ?? (cfg.kind === 'desk' ? 1 : cfg.bookable ? 4 : 0),
    defaultEquipment: cfg.defaultEquipment ? [...cfg.defaultEquipment] : [],
    color: cfg.color,
    pattern,
    id: (m) => m[1].replace(/-/g, '_'),
    name: (m) => `${cfg.label} ${m[2]}-${m[3]}`,
    code: (m) => `${cfg.codePrefix} ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  };
}

/** Built-in structural rules for wayfinding infrastructure (lifts, kiosks, standard restrooms). */
const STRUCTURAL_RULES: ReadonlyArray<ResourceRule> = [
  {
    // door_WAYFINDING_LIFT_12_1, door_LIFT_12_1, door_WAYFINDING_LIFT_13_1, or door_Lifts_L13_1..8
    kind: 'lift',
    bookable: false,
    defaultSubType: 'Lift',
    defaultCapacity: 0,
    pattern: /^door_(?:((?:WAYFINDING_)?LIFT_(\d+)_(\d+))|(Lifts_L(\d+)_(\d+)))$/i,
    id: (m) => m[1] ?? m[4],
    name: (m) => `Lift ${m[3] ?? m[6]} (L${m[2] ?? m[5]})`,
    code: (m) => `Lift ${m[3] ?? m[6]}`,
    level: (m) => m[2] ?? m[5],
  },
  {
    // furniture_WAYFINDING_KIOSK_L12_1 or furniture_WAYFINDING_KIOSK_L13_1 / L13_2
    kind: 'kiosk',
    bookable: false,
    defaultSubType: 'Kiosk',
    defaultCapacity: 0,
    pattern: /^furniture_(WAYFINDING_KIOSK_L(\d+)_(\d+))$/i,
    id: (m) => m[1],
    name: (m) => `Kiosk L${m[2]}-${m[3]}`,
    code: (m) => `Kiosk ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // door_Toilet_Male_L12/L13, floor_room-<uuid>_MaleToilet_12_1, or floor_room-<uuid>_TOILET_MALE_L13
    kind: 'amenity',
    bookable: false,
    defaultSubType: 'Male Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_Male_L(\d+))|floor_room-.+?_(?:(MaleToilet_(\d+)_(\d+))|(TOILET_MALE_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Male Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => 'Male WC',
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_Toilet_Female_L12/L13, floor_room-<uuid>_FemaleToilet_12_1, or floor_room-<uuid>_TOILET_FEMALE_L13
    kind: 'amenity',
    bookable: false,
    defaultSubType: 'Female Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_Female_L(\d+))|floor_room-.+?_(?:(FemaleToilet_(\d+)_(\d+))|(TOILET_FEMALE_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Female Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => 'Female WC',
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_Toilet_PWD_L12/L13, floor_room-<uuid>_PWDToilet_12_1, or floor_room-<uuid>_TOILET_PWD_L13
    kind: 'amenity',
    bookable: false,
    defaultSubType: 'PWD Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_PWD_L(\d+))|floor_room-.+?_(?:(PWDToilet_(\d+)_(\d+))|(TOILET_PWD_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `PWD Accessible Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => 'PWD WC',
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_NursingRoom_L13, floor_room-<uuid>_NursingRoom_12_1, or floor_room-<uuid>_NURSING_ROOM_L13
    kind: 'amenity',
    bookable: false,
    defaultSubType: 'Nursing Room',
    defaultCapacity: 0,
    pattern: /^(?:door_(NursingRoom_L(\d+))|floor_room-.+?_(?:(NursingRoom_(\d+)_(\d+))|(NURSING_?ROOM_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Nursing Room (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => 'Nursing',
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
];

let activeResourceTypeConfigs: ReadonlyArray<ResourceTypeConfig> = [...DEFAULT_RESOURCE_TYPES];

/** Active GLB resource matching rules (dynamically rebuilt when `kiosk-config.json` loads). */
export let RESOURCE_RULES: ResourceRule[] = [
  ...activeResourceTypeConfigs.map(compileResourceTypeRule),
  ...STRUCTURAL_RULES,
];

/**
 * Updates the active resource classification rules from runtime `kiosk-config.json`.
 * Allows adding any client-specific resource types (e.g. `PhoneBooth`, `BoardRoom`, `Pantry`)
 * without rebuilding the application.
 */
export function setRuntimeResourceTypes(configs: ReadonlyArray<ResourceTypeConfig>): void {
  activeResourceTypeConfigs = configs.length > 0 ? [...configs] : [...DEFAULT_RESOURCE_TYPES];
  RESOURCE_RULES = [
    ...activeResourceTypeConfigs.map(compileResourceTypeRule),
    ...STRUCTURAL_RULES,
  ];
}

/** Returns the active client-configured resource type definitions. */
export function getRuntimeResourceTypes(): ReadonlyArray<ResourceTypeConfig> {
  return activeResourceTypeConfigs;
}

/** Default kiosk ID used as fallback when no kiosk is specified in URL or config. */
export const HOME_KIOSK_ID = 'WAYFINDING_KIOSK_L12_1';

export const KIND_LABELS: Record<ResourceKind, string> = {
  'meeting-room': 'Rooms',
  desk: 'Desks',
  amenity: 'Amenities',
  lift: 'Lifts',
  kiosk: 'Kiosk',
};

/** Node name prefixes of the structural elements of the floor plan exports. */
export const NODE_PREFIX = {
  floor: 'floor_',
  ceiling: 'ceiling_',
  wall: 'wall_',
  door: 'door_',
  furniture: 'furniture_',
} as const;

export interface MatchedResource {
  rule: ResourceRule;
  match: RegExpMatchArray;
}

/**
 * Formats a raw room/resource property ID (e.g. `MeetingRoom_13_52`, `PhoneBooth_14_01`,
 * `Desk_12_001`) into its canonical human-readable display name using the active
 * `resourceTypes` config.
 */
export function formatResourcePropertyName(rawId: string): string {
  for (const cfg of activeResourceTypeConfigs) {
    const m = rawId.match(new RegExp(`^${escapeRegExp(cfg.key)}_(\\d+)[_-](\\d+)$`, 'i'));
    if (m) return `${cfg.label} ${m[1]}-${m[2]}`;
  }
  const lift = rawId.match(/^(?:(?:WAYFINDING_)?LIFT|Lifts_L)_?(\d+)_(\d+)$/i);
  if (lift) return `Lift ${lift[2]} (L${lift[1]})`;
  const kiosk = rawId.match(/^WAYFINDING_KIOSK_L(\d+)_(\d+)$/i);
  if (kiosk) return `Kiosk L${kiosk[1]}-${kiosk[2]}`;
  const amenity = rawId.match(/^(MaleToilet|FemaleToilet|PWDToilet|NursingRoom)_(\d+)_(\d+)$/i);
  if (amenity) {
    const key = amenity[1].toLowerCase();
    const label =
      key === 'maletoilet'
        ? 'Male Toilet'
        : key === 'femaletoilet'
          ? 'Female Toilet'
          : key === 'pwdtoilet'
            ? 'PWD Accessible Toilet'
            : 'Nursing Room';
    return `${label} (L${amenity[2]})`;
  }
  const sh3dToilet = rawId.match(/^TOILET_(MALE|FEMALE|PWD)_L(\d+)$/i);
  if (sh3dToilet) {
    const t = sh3dToilet[1].toUpperCase();
    const label = t === 'MALE' ? 'Male Toilet' : t === 'FEMALE' ? 'Female Toilet' : 'PWD Accessible Toilet';
    return `${label} (L${sh3dToilet[2]})`;
  }
  const sh3dNursing = rawId.match(/^NURSING(?:_?ROOM)?_L(\d+)$/i);
  if (sh3dNursing) return `Nursing Room (L${sh3dNursing[1]})`;
  return rawId.replace(/_/g, ' ');
}

export function matchResource(
  nodeName: string,
  userData?: Record<string, unknown>,
): MatchedResource | null {
  const propId =
    (typeof userData?.['roomName'] === 'string' && userData['roomName']) ||
    (typeof userData?.['displayName'] === 'string' && userData['displayName']) ||
    null;

  const candidates = propId ? [`floor_room-prop_${propId}`, nodeName] : [nodeName];
  for (const candidate of candidates) {
    for (const rule of RESOURCE_RULES) {
      const match = candidate.match(rule.pattern);
      if (match) return { rule, match };
    }
  }
  return null;
}
