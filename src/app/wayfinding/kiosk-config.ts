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

export interface AzureAuthConfig {
  /** Set to false to bypass Azure AD login (e.g. offline development). */
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
}

export interface KioskRuntimeConfig {
  defaultKioskDeviceId: string;
  auth: AzureAuthConfig;
  floors: FloorConfig[];
  kioskDevices: KioskDeviceConfig[];
}

export const DEFAULT_AZURE_AUTH_CONFIG: AzureAuthConfig = {
  enabled: true,
  tenantId: 'dc6b3307-ad9c-4e58-ac57-4aea4db74ad4',
  clientId: '7c2aaf28-ef11-43ff-a71f-ac38365c4f2f',
  scopes: ['openid', 'profile', 'email', 'User.Read', 'Calendars.ReadWrite'],
  apiScopes: [],
  redirectUri: '',
  postLogoutRedirectUri: '',
  revalidateIntervalSeconds: 300,
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
    };

    return { defaultKioskDeviceId, auth, floors, kioskDevices };
  } catch (err) {
    console.warn('Could not load data/kiosk-config.json; using built-in defaults:', err);
    return {
      defaultKioskDeviceId: DEFAULT_KIOSK_DEVICE_ID,
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
