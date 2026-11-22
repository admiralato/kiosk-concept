/**
 * Naming conventions used by the floor plan GLB files (Level 12 & Level 13).
 *
 * Only objects whose names match one of the {@link RESOURCE_RULES} become
 * interactive resources. All other furniture is treated as decoration: it is
 * rendered and used as an obstacle for path finding, but it is never clickable
 * and never offered as a destination.
 */

export type ResourceKind = 'meeting-room' | 'desk' | 'amenity' | 'lift' | 'kiosk';

export interface ResourceRule {
  kind: ResourceKind;
  /** Default sub-type assigned when not overridden by spaceboard-data.json. */
  defaultSubType?:
    | 'Meeting Room'
    | 'Private Room'
    | 'Focus Room'
    | 'Desk'
    | 'Lift'
    | 'Kiosk'
    | 'Male Toilet'
    | 'Female Toilet'
    | 'PWD Toilet'
    | 'Nursing Room';
  /** Default seating capacity when not overridden by spaceboard-data.json. */
  defaultCapacity?: number;
  /** Default equipment list when not overridden by spaceboard-data.json. */
  defaultEquipment?: string[];
  /** Matched against the (sanitised) node name of the GLB. */
  pattern: RegExp;
  /** Builds the stable resource id from the regex match. */
  id: (m: RegExpMatchArray) => string;
  /** Human friendly name shown on the kiosk. */
  name: (m: RegExpMatchArray) => string;
  /** Short code shown on map labels. */
  code: (m: RegExpMatchArray) => string;
  /** Level / floor number. */
  level: (m: RegExpMatchArray) => string;
}

export const RESOURCE_RULES: ResourceRule[] = [
  {
    // floor_room-<uuid>_MeetingRoom_12_6  (Level 12 or Level 13 Meeting Rooms)
    kind: 'meeting-room',
    defaultSubType: 'Meeting Room',
    defaultCapacity: 8,
    defaultEquipment: ['TV', 'Whiteboard', 'Video Conferencing'],
    pattern: /^floor_room-.+?_(MeetingRoom_(\d+)_(\d+))$/,
    id: (m) => m[1],
    name: (m) => `Meeting Room ${m[2]}-${m[3]}`,
    code: (m) => `MR ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // floor_room-l13_PrivateRoom_13_42 (Level 13 Private Rooms)
    kind: 'meeting-room',
    defaultSubType: 'Private Room',
    defaultCapacity: 3,
    defaultEquipment: ['TV', 'Soundproofing'],
    pattern: /^floor_room-.+?_(PrivateRoom_(\d+)_(\d+))$/,
    id: (m) => m[1],
    name: (m) => `Private Room ${m[2]}-${m[3]}`,
    code: (m) => `PR ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // floor_room-l13_FocusRoom_13_28 (Level 13 Focus Rooms)
    kind: 'meeting-room',
    defaultSubType: 'Focus Room',
    defaultCapacity: 2,
    defaultEquipment: ['Whiteboard', 'Soundproofing'],
    pattern: /^floor_room-.+?_(FocusRoom_(\d+)_(\d+))$/,
    id: (m) => m[1],
    name: (m) => `Focus Room ${m[2]}-${m[3]}`,
    code: (m) => `FR ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // furniture_Desk_12_001 or furniture_Desk_13_001
    kind: 'desk',
    defaultSubType: 'Desk',
    defaultCapacity: 1,
    defaultEquipment: ['Dual Monitor', 'Standing Desk'],
    pattern: /^furniture_(Desk_(\d+)_(\d+))$/,
    id: (m) => m[1],
    name: (m) => `Desk ${m[2]}-${m[3]}`,
    code: (m) => `D ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // door_WAYFINDING_LIFT_12_1, door_WAYFINDING_LIFT_13_1, or door_Lifts_L13_1..8
    kind: 'lift',
    defaultSubType: 'Lift',
    defaultCapacity: 0,
    pattern: /^door_(?:(WAYFINDING_LIFT_(\d+)_(\d+))|(Lifts_L(\d+)_(\d+)))$/,
    id: (m) => m[1] ?? m[4],
    name: (m) => `Lift ${m[3] ?? m[6]} (L${m[2] ?? m[5]})`,
    code: (m) => `Lift ${m[3] ?? m[6]}`,
    level: (m) => m[2] ?? m[5],
  },
  {
    // furniture_WAYFINDING_KIOSK_L12_1 or furniture_WAYFINDING_KIOSK_L13_1 / L13_2
    kind: 'kiosk',
    defaultSubType: 'Kiosk',
    defaultCapacity: 0,
    pattern: /^furniture_(WAYFINDING_KIOSK_L(\d+)_(\d+))$/,
    id: (m) => m[1],
    name: (m) => `Kiosk L${m[2]}-${m[3]}`,
    code: (m) => `Kiosk ${m[2]}-${m[3]}`,
    level: (m) => m[2],
  },
  {
    // door_Toilet_Male_L13, floor_room-<uuid>_MaleToilet_12_1, or floor_room-<uuid>_TOILET_MALE_L13
    kind: 'amenity',
    defaultSubType: 'Male Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_Male_L(\d+))|floor_room-.+?_(?:(MaleToilet_(\d+)_(\d+))|(TOILET_MALE_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Male Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => `Male WC`,
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_Toilet_Female_L13, floor_room-<uuid>_FemaleToilet_12_1, or floor_room-<uuid>_TOILET_FEMALE_L13
    kind: 'amenity',
    defaultSubType: 'Female Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_Female_L(\d+))|floor_room-.+?_(?:(FemaleToilet_(\d+)_(\d+))|(TOILET_FEMALE_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Female Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => `Female WC`,
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_Toilet_PWD_L13, floor_room-<uuid>_PWDToilet_12_1, or floor_room-<uuid>_TOILET_PWD_L13
    kind: 'amenity',
    defaultSubType: 'PWD Toilet',
    defaultCapacity: 0,
    pattern: /^(?:door_(Toilet_PWD_L(\d+))|floor_room-.+?_(?:(PWDToilet_(\d+)_(\d+))|(TOILET_PWD_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `PWD Accessible Toilet (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => `PWD WC`,
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
  {
    // door_NursingRoom_L13, floor_room-<uuid>_NursingRoom_12_1, or floor_room-<uuid>_NURSING_ROOM_L13
    kind: 'amenity',
    defaultSubType: 'Nursing Room',
    defaultCapacity: 0,
    pattern: /^(?:door_(NursingRoom_L(\d+))|floor_room-.+?_(?:(NursingRoom_(\d+)_(\d+))|(NURSING(?:_ROOM)?_L(\d+))))$/i,
    id: (m) => m[1] ?? m[3] ?? m[6],
    name: (m) => `Nursing Room (L${m[2] ?? m[4] ?? m[7]})`,
    code: () => `Nursing`,
    level: (m) => m[2] ?? m[4] ?? m[7],
  },
];

/** Default kiosk ID fallback when no device config is active. */
export const HOME_KIOSK_ID = 'WAYFINDING_KIOSK_L12_1';

export const KIND_LABELS: Record<ResourceKind, string> = {
  'meeting-room': 'Rooms',
  desk: 'Desks',
  amenity: 'Amenities',
  lift: 'Lifts',
  kiosk: 'Kiosks',
};

export interface FloorAmenitySeed {
  id: string;
  name: string;
  code: string;
  level: string;
  floor: string;
  resourceType: 'Male Toilet' | 'Female Toilet' | 'PWD Toilet' | 'Nursing Room';
  description: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * Built-in central core Restroom (Male, Female, PWD Accessible) & Nursing Room
 * signage and wayfinding anchors for Level 12 and Level 13.
 */
export const FLOOR_AMENITIES: Record<string, ReadonlyArray<FloorAmenitySeed>> = {
  'Level 12': [
    {
      id: 'MaleToilet_12_1',
      name: 'Male Toilet (L12)',
      code: 'Male WC',
      level: '12',
      floor: 'Level 12',
      resourceType: 'Male Toilet',
      description: 'Level 12 central core male washroom facilities near West Lift.',
      bounds: { minX: 14.5, maxX: 18.8, minZ: 16.2, maxZ: 18.4 },
    },
    {
      id: 'FemaleToilet_12_1',
      name: 'Female Toilet (L12)',
      code: 'Female WC',
      level: '12',
      floor: 'Level 12',
      resourceType: 'Female Toilet',
      description: 'Level 12 central core female washroom facilities.',
      bounds: { minX: 14.5, maxX: 19.4, minZ: 11.4, maxZ: 14.8 },
    },
    {
      id: 'PWDToilet_12_1',
      name: 'PWD Accessible Toilet (L12)',
      code: 'PWD WC',
      level: '12',
      floor: 'Level 12',
      resourceType: 'PWD Toilet',
      description: 'Wheelchair-accessible unisex washroom with grab bars and emergency call button.',
      bounds: { minX: 20.1, maxX: 22.4, minZ: 16.1, maxZ: 18.3 },
    },
    {
      id: 'NursingRoom_12_1',
      name: 'Nursing Room (L12)',
      code: 'Nursing',
      level: '12',
      floor: 'Level 12',
      resourceType: 'Nursing Room',
      description: 'Private parents & lactation suite with sink, armchair, and changing station.',
      bounds: { minX: 12.2, maxX: 13.5, minZ: 11.0, maxZ: 14.8 },
    },
  ],
  'Level 13': [
    {
      id: 'MaleToilet_13_1',
      name: 'Male Toilet (L13)',
      code: 'Male WC',
      level: '13',
      floor: 'Level 13',
      resourceType: 'Male Toilet',
      description: 'Level 13 east core male washroom facilities.',
      bounds: { minX: 34.2, maxX: 43.2, minZ: 19.3, maxZ: 24.3 },
    },
    {
      id: 'FemaleToilet_13_1',
      name: 'Female Toilet (L13)',
      code: 'Female WC',
      level: '13',
      floor: 'Level 13',
      resourceType: 'Female Toilet',
      description: 'Level 13 east core female washroom facilities.',
      bounds: { minX: 34.2, maxX: 43.2, minZ: 27.6, maxZ: 30.1 },
    },
    {
      id: 'PWDToilet_13_1',
      name: 'PWD Accessible Toilet (L13)',
      code: 'PWD WC',
      level: '13',
      floor: 'Level 13',
      resourceType: 'PWD Toilet',
      description: 'Level 13 wheelchair-accessible unisex washroom with grab bars and emergency call button.',
      bounds: { minX: 34.1, maxX: 36.6, minZ: 17.4, maxZ: 19.1 },
    },
    {
      id: 'NursingRoom_13_1',
      name: 'Nursing Room (L13)',
      code: 'Nursing',
      level: '13',
      floor: 'Level 13',
      resourceType: 'Nursing Room',
      description: 'Level 13 private lactation & nursing suite with sink,fridge, and comfortable seating.',
      bounds: { minX: 42.5, maxX: 44.6, minZ: 24.5, maxZ: 25.8 },
    },
  ],
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
 * Formats a raw room/resource property ID (e.g. `MeetingRoom_13_52`, `PrivateRoom_13_42`,
 * `FocusRoom_13_28`, `Desk_12_001`) into its canonical human-readable display name
 * (e.g. `Meeting Room 13-52`, `Private Room 13-42`, `Focus Room 13-28`, `Desk 12-001`).
 */
export function formatResourcePropertyName(rawId: string): string {
  const m = rawId.match(/^(MeetingRoom|PrivateRoom|FocusRoom|Desk)_(\d+)_(\d+)$/);
  if (m) {
    const label =
      m[1] === 'MeetingRoom'
        ? 'Meeting Room'
        : m[1] === 'PrivateRoom'
          ? 'Private Room'
          : m[1] === 'FocusRoom'
            ? 'Focus Room'
            : 'Desk';
    return `${label} ${m[2]}-${m[3]}`;
  }
  const lift = rawId.match(/^(?:WAYFINDING_LIFT|Lifts_L)_?(\d+)_(\d+)$/);
  if (lift) return `Lift ${lift[2]} (L${lift[1]})`;
  const kiosk = rawId.match(/^WAYFINDING_KIOSK_L(\d+)_(\d+)$/);
  if (kiosk) return `Kiosk L${kiosk[1]}-${kiosk[2]}`;
  const amenity = rawId.match(/^(MaleToilet|FemaleToilet|PWDToilet|NursingRoom)_(\d+)_(\d+)$/);
  if (amenity) {
    const label =
      amenity[1] === 'MaleToilet'
        ? 'Male Toilet'
        : amenity[1] === 'FemaleToilet'
          ? 'Female Toilet'
          : amenity[1] === 'PWDToilet'
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
