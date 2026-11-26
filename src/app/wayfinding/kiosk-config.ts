/**
 * Kiosk Device & Floor Plan Configuration.
 *
 * Loaded at runtime from `data/kiosk-config.json` (with `cache: 'no-cache'`) so
 * new floors (Level 14, Level 15, etc.) and new physical kiosk terminals can be
 * deployed directly on the server without rebuilding the Angular application.
 *
 * Allows multiple physical kiosk machines (or desktop browser instances) to load
 * the same application URL while specifying their starting kiosk position via query
 * parameter, e.g.:
 *   - ?kioskId=l12-1  (or ?kioskId=WAYFINDING_KIOSK_L12_1) -> Level 12, Kiosk 12-1
 *   - ?kioskId=l13-1  (or ?kioskId=WAYFINDING_KIOSK_L13_1) -> Level 13, Kiosk 13-1
 *   - ?kioskId=l13-2  (or ?kioskId=WAYFINDING_KIOSK_L13_2) -> Level 13, Kiosk 13-2
 *
 * If `kioskId` is omitted or not found in `kioskDevices`, the application falls
 * back to `defaultKioskDeviceId`.
 */

export interface BrandingConfig {
  /** Application display title (e.g. 'SpaceBoard PC'). */
  title: string;
  /** Short 1–3 letter monogram shown in the logo badge (e.g. 'SB'). */
  badge: string;
  /** Subtitle shown on the Sign-In modal. */
  subtitle: string;
}

export interface ResourceTypeConfig {
  /** Node name prefix/key in the GLB (e.g. 'MeetingRoom', 'PrivateRoom', 'FocusRoom', 'PhoneBooth', 'Desk'). */
  key: string;
  /** Human-readable label shown in UI & filters (e.g. 'Meeting Room', 'Phone Booth'). */
  label: string;
  /** Short code prefix shown on map badges (e.g. 'MR', 'PR', 'FR', 'PB', 'D'). */
  codePrefix: string;
  /** Which GLB group this resource lives in: 'floor', 'furniture', 'door', or 'any'. */
  nodeGroup: 'floor' | 'furniture' | 'door' | 'any';
  /** Semantic category controlling visual style & directory tab. */
  kind: 'meeting-room' | 'desk' | 'amenity';
  /** Whether users can book this resource type (true -> availability colors & booking actions). */
  bookable: boolean;
  /** Default seating capacity when not overridden by catalog JSON / API. */
  defaultCapacity?: number;
  /** Default equipment list when not overridden by catalog JSON / API. */
  defaultEquipment?: string[];
  /** Optional badge hex color for non-bookable amenities. */
  color?: string;
}

export interface FloorConfig {
  /** Human-readable floor label used in filters (e.g. 'Level 12'). */
  id: string;
  /** Numeric level string matching GLB resource rules (e.g. '12'). */
  level: string;
  /** Short badge code (e.g. 'L12'). */
  shortCode: string;
  /** Path to the optimized Meshopt GLB file in `models/` (relative to base URL). */
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
  /** Level number ('12', '13', '14', etc.). */
  level: string;
  /** Alternate query-param aliases accepted for this kiosk device. */
  aliases: string[];
}

export interface LocalAuthConfig {
  /** Show the Username & Password login option in the Sign-In modal. */
  enabled: boolean;
  /**
   * Backend API endpoint for username/password login (POST `{ username, password }`).
   * Expected JSON response: `{ accessToken: string, user: { id?, name, email?, username? } }`.
   * Leave blank until your backend API is deployed.
   */
  loginUrl?: string;
  /**
   * Optional Backend API endpoint to silently revalidate/refresh a local session
   * (GET/POST with `Authorization: Bearer <token>`). Returns 200 if valid or 401 if revoked.
   */
  validateUrl?: string;
  /** Optional Backend API endpoint called on Sign Out to revoke the server session. */
  logoutUrl?: string;
  /**
   * Enables the built-in hardcoded demo credential (`demo` / `demo123`) for offline/demo testing.
   * Set to `false` in production once your backend API is connected.
   */
  demoLoginEnabled?: boolean;
}

export interface AzureAuthConfig {
  /** Set to false to bypass login entirely (e.g. offline development). */
  enabled: boolean;
  /** Azure AD (Microsoft Entra ID) Tenant ID (GUID or domain). */
  tenantId: string;
  /** Azure AD App Registration Client ID (SPA Public Client — never store ClientSecret in frontend). */
  clientId: string;
  /** OIDC / Graph scopes requested during sign-in. */
  scopes: string[];
  /**
   * Optional scopes for your future Backend API (e.g. `["api://<api-client-id>/access_as_user"]`).
   * Used by `AzureAuthService.getApiAccessToken()` and `authFetch()`.
   */
  apiScopes: string[];
  /** Optional explicit Redirect URI. Defaults to current origin + pathname (supports any relative subpath). */
  redirectUri?: string;
  /** Optional explicit Post-Logout Redirect URI. Defaults to `redirectUri`. */
  postLogoutRedirectUri?: string;
  /** Interval in seconds between silent token revalidation checks (default: 300s). */
  revalidateIntervalSeconds?: number;
  /** Optional Username & Password login backed by your local user database API (plus demo login). */
  local?: LocalAuthConfig;
}

export interface KioskRuntimeConfig {
  branding: BrandingConfig;
  defaultKioskDeviceId: string;
  resourceTypes: ResourceTypeConfig[];
  auth: AzureAuthConfig;
  floors: FloorConfig[];
  kioskDevices: KioskDeviceConfig[];
}

export const DEFAULT_BRANDING_CONFIG: BrandingConfig = {
  title: 'SpaceBoard PC',
  badge: 'SB',
  subtitle: '3D Workspace Booking & Wayfinding',
};

export const DEFAULT_RESOURCE_TYPES: ReadonlyArray<ResourceTypeConfig> = [
  {
    key: 'MeetingRoom',
    label: 'Meeting Room',
    codePrefix: 'MR',
    nodeGroup: 'floor',
    kind: 'meeting-room',
    bookable: true,
    defaultCapacity: 8,
    defaultEquipment: ['TV', 'Whiteboard', 'Video Conferencing'],
  },
  {
    key: 'PrivateRoom',
    label: 'Private Room',
    codePrefix: 'PR',
    nodeGroup: 'floor',
    kind: 'meeting-room',
    bookable: true,
    defaultCapacity: 3,
    defaultEquipment: ['TV', 'Soundproofing'],
  },
  {
    key: 'FocusRoom',
    label: 'Focus Room',
    codePrefix: 'FR',
    nodeGroup: 'floor',
    kind: 'meeting-room',
    bookable: true,
    defaultCapacity: 2,
    defaultEquipment: ['Whiteboard', 'Soundproofing'],
  },
  {
    key: 'PhoneBooth',
    label: 'Phone Booth',
    codePrefix: 'PB',
    nodeGroup: 'any',
    kind: 'meeting-room',
    bookable: true,
    defaultCapacity: 1,
    defaultEquipment: ['Soundproofing'],
  },
  {
    key: 'HuddleRoom',
    label: 'Huddle Room',
    codePrefix: 'HR',
    nodeGroup: 'floor',
    kind: 'meeting-room',
    bookable: true,
    defaultCapacity: 4,
    defaultEquipment: ['TV', 'Whiteboard'],
  },
  {
    key: 'Desk',
    label: 'Desk',
    codePrefix: 'D',
    nodeGroup: 'furniture',
    kind: 'desk',
    bookable: true,
    defaultCapacity: 1,
    defaultEquipment: ['Dual Monitor', 'Standing Desk'],
  },
];

export const DEFAULT_LOCAL_AUTH_CONFIG: LocalAuthConfig = {
  enabled: true,
  loginUrl: '',
  validateUrl: '',
  logoutUrl: '',
  demoLoginEnabled: true,
};

export const DEFAULT_AZURE_AUTH_CONFIG: AzureAuthConfig = {
  enabled: true,
  tenantId: 'dc6b3307-ad9c-4e58-ac57-4aea4db74ad4',
  clientId: '7c2aaf28-ef11-43ff-a71f-ac38365c4f2f',
  scopes: ['openid', 'profile', 'email', 'User.Read', 'Calendars.ReadWrite'],
  apiScopes: [],
  redirectUri: '',
  postLogoutRedirectUri: '',
  revalidateIntervalSeconds: 300,
  local: { ...DEFAULT_LOCAL_AUTH_CONFIG },
};

/** Built-in fallback floors used if `data/kiosk-config.json` cannot be fetched. */
export const DEFAULT_FLOOR_CONFIGS: ReadonlyArray<FloorConfig> = [
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

/** Built-in fallback kiosk devices used if `data/kiosk-config.json` cannot be fetched. */
export const DEFAULT_KIOSK_DEVICES: ReadonlyArray<KioskDeviceConfig> = [
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
 * any registered device.
 */
export const DEFAULT_KIOSK_DEVICE_ID = 'l12-1';

/**
 * Loads floor plans and kiosk device mappings from `data/kiosk-config.json` at runtime.
 * Uses `cache: 'no-cache'` so newly added floors/kiosks take effect on the next refresh
 * without rebuilding the Angular bundle. Falls back to built-in defaults on error.
 */
export async function loadKioskConfig(
  url = 'data/kiosk-config.json',
): Promise<KioskRuntimeConfig> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = (await res.json()) as Partial<KioskRuntimeConfig>;

    const floors =
      Array.isArray(parsed.floors) && parsed.floors.length > 0
        ? parsed.floors
        : [...DEFAULT_FLOOR_CONFIGS];
    const kioskDevices =
      Array.isArray(parsed.kioskDevices) && parsed.kioskDevices.length > 0
        ? parsed.kioskDevices.map((d) => ({
          ...d,
          aliases: Array.isArray(d.aliases) ? d.aliases : [d.deviceId.toLowerCase()],
        }))
        : [...DEFAULT_KIOSK_DEVICES];
    const defaultKioskDeviceId =
      typeof parsed.defaultKioskDeviceId === 'string' && parsed.defaultKioskDeviceId.trim()
        ? parsed.defaultKioskDeviceId.trim()
        : (kioskDevices[0]?.deviceId ?? DEFAULT_KIOSK_DEVICE_ID);
    const auth: AzureAuthConfig = {
      ...DEFAULT_AZURE_AUTH_CONFIG,
      ...(parsed.auth ?? {}),
      scopes:
        Array.isArray(parsed.auth?.scopes) && parsed.auth.scopes.length > 0
          ? parsed.auth.scopes
          : [...DEFAULT_AZURE_AUTH_CONFIG.scopes],
      apiScopes: Array.isArray(parsed.auth?.apiScopes) ? parsed.auth.apiScopes : [],
      local: {
        ...DEFAULT_LOCAL_AUTH_CONFIG,
        ...(parsed.auth?.local ?? {}),
      },
    };

    const branding: BrandingConfig = {
      ...DEFAULT_BRANDING_CONFIG,
      ...(parsed.branding ?? {}),
    };
    const resourceTypes: ResourceTypeConfig[] =
      Array.isArray(parsed.resourceTypes) && parsed.resourceTypes.length > 0
        ? parsed.resourceTypes
        : [...DEFAULT_RESOURCE_TYPES];

    return { branding, defaultKioskDeviceId, resourceTypes, auth, floors, kioskDevices };
  } catch (err) {
    console.warn('Could not load data/kiosk-config.json; using built-in defaults:', err);
    return {
      branding: { ...DEFAULT_BRANDING_CONFIG },
      defaultKioskDeviceId: DEFAULT_KIOSK_DEVICE_ID,
      resourceTypes: [...DEFAULT_RESOURCE_TYPES],
      auth: { ...DEFAULT_AZURE_AUTH_CONFIG },
      floors: [...DEFAULT_FLOOR_CONFIGS],
      kioskDevices: [...DEFAULT_KIOSK_DEVICES],
    };
  }
}

/** Resolves a query parameter string (or null) to a valid `KioskDeviceConfig`. */
export function resolveKioskDevice(
  rawParam?: string | null,
  devices: ReadonlyArray<KioskDeviceConfig> = DEFAULT_KIOSK_DEVICES,
  defaultDeviceId = DEFAULT_KIOSK_DEVICE_ID,
): KioskDeviceConfig {
  const cleaned = (rawParam ?? '').trim().toLowerCase();
  if (cleaned) {
    const found = devices.find(
      (d) =>
        d.deviceId.toLowerCase() === cleaned ||
        d.resourceId.toLowerCase() === cleaned ||
        d.aliases.some((a) => a.toLowerCase() === cleaned),
    );
    if (found) return found;
  }
  return (
    devices.find((d) => d.deviceId.toLowerCase() === defaultDeviceId.toLowerCase()) ??
    devices[0] ??
    DEFAULT_KIOSK_DEVICES[0]
  );
}

/** Reads `?kioskId=` (case-insensitive query key) from `window.location.search`. */
export function resolveKioskDeviceFromUrl(
  search = window.location.search,
  devices: ReadonlyArray<KioskDeviceConfig> = DEFAULT_KIOSK_DEVICES,
  defaultDeviceId = DEFAULT_KIOSK_DEVICE_ID,
): KioskDeviceConfig {
  const params = new URLSearchParams(search);
  let raw: string | null = null;
  for (const [key, val] of params.entries()) {
    if (key.toLowerCase() === 'kioskid' || key.toLowerCase() === 'kiosk') {
      raw = val;
      break;
    }
  }
  return resolveKioskDevice(raw, devices, defaultDeviceId);
}

export function getFloorConfig(
  floorIdOrLevel: string,
  floors: ReadonlyArray<FloorConfig> = DEFAULT_FLOOR_CONFIGS,
): FloorConfig {
  const norm = floorIdOrLevel.trim().toLowerCase();
  return (
    floors.find(
      (f) =>
        f.id.toLowerCase() === norm ||
        f.level.toLowerCase() === norm ||
        f.shortCode.toLowerCase() === norm,
    ) ??
    floors[0] ??
    DEFAULT_FLOOR_CONFIGS[0]
  );
}
