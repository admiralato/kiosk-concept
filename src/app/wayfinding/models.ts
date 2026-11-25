import type { Footprint, Vec2 } from './nav-grid';
import type { ResourceKind } from './resource-config';

export type AvailabilityStatus = 'available' | 'reserved' | 'occupied';

/**
 * Reservation lifecycle status:
 * - 'starting': Upcoming / reserved booking (Yellow — Reserve). Users can update all fields or Cancel it.
 * - 'started': Active / checked-in booking (Red — Occupied). Users can only update its Subject or End it.
 */
export type ReservationStatus = 'starting' | 'started';

export type ResourceSubType =
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

export interface ResourceCatalogEntry {
  id: string;
  displayName: string;
  code: string;
  site: string;
  floor: string;
  resourceType: ResourceSubType;
  capacity: number;
  equipment: string[];
  description?: string;
  /** Exchange / Outlook room mailbox SMTP address (e.g. `mr13-52@company.com`). When set, bookings sync directly to Outlook via Microsoft Graph. */
  exchangeId?: string | null;
}

export interface Reservation {
  id: string;
  resourceId: string;
  /** Reservation subject / title */
  subject: string;
  organizer: string;
  /** YYYY-MM-DD (or 'TODAY' / 'TOMORROW' in seed JSON before normalization) */
  date: string;
  /** HH:mm (24h) */
  startTime: string;
  /** HH:mm (24h) */
  endTime: string;
  /** 'starting' -> Yellow (Reserve), 'started' -> Red (Occupied) */
  status: ReservationStatus;
  /** Microsoft Graph Event ID when booked via Outlook/Exchange. */
  outlookEventId?: string;
  /** Direct Outlook Web link returned by Microsoft Graph. */
  outlookWebLink?: string;
  /** Optional attendee email addresses invited to the event. */
  attendees?: string[];
  /** Whether a Microsoft Teams meeting link was attached. */
  isOnlineMeeting?: boolean;
}

export interface SpaceBoardDataset {
  sites: string[];
  floors: string[];
  resourceTypes: ResourceSubType[];
  equipmentOptions: string[];
  resources: ResourceCatalogEntry[];
  reservations: Array<
    Omit<Reservation, 'subject' | 'status'> & {
      subject?: string;
      title?: string;
      status: ReservationStatus | 'reserved' | 'checked-in';
    }
  >;
}

export interface KioskResource {
  id: string;
  kind: ResourceKind;
  name: string;
  /** Secondary room title (e.g. "Orion — Meeting Room 12.1") */
  subtitle?: string;
  code: string;
  level: string;
  site: string;
  floor: string;
  resourceType: ResourceSubType;
  capacity: number;
  equipment: string[];
  description?: string;
  /** Exchange / Outlook room mailbox SMTP address (null/empty for non-Exchange resources). */
  exchangeId?: string | null;
  /** Whether users can book this resource */
  bookable: boolean;
  /** Centre of the resource on the floor plane. */
  center: Vec2;
  /** Axis aligned footprint on the floor plane. */
  bounds: Footprint;
  /** Walkable point where routes to / from this resource start or end. */
  anchor: Vec2 | null;
}

export type TurnKind =
  | 'start'
  | 'straight'
  | 'slight-left'
  | 'slight-right'
  | 'left'
  | 'right'
  | 'u-turn'
  | 'lift'
  | 'arrive';

export interface RouteStep {
  turn: TurnKind;
  text: string;
  /** Distance (m) to walk after this instruction. */
  distance: number;
  /** Where the instruction applies. */
  at: Vec2;
  /** Floor ID (e.g. 'Level 12' or 'Level 13') this step takes place on. */
  floor?: string;
}

/** A single-floor leg of a (potentially multi-floor) route. */
export interface RouteSegment {
  floor: string;
  level: string;
  from: KioskResource;
  to: KioskResource;
  corners: Vec2[];
  smooth: Vec2[];
  length: number;
  seconds: number;
  steps: RouteStep[];
}

export interface Route {
  from: KioskResource;
  to: KioskResource;
  /** True when the route spans across two floors via a lift transfer. */
  multiFloor?: boolean;
  /** Ordered per-floor segments (1 for same-floor, 2 for cross-floor via lift). */
  segments?: RouteSegment[];
  /** Currently displayed floor segment corners. */
  corners: Vec2[];
  /** Currently displayed floor segment smoothed polyline. */
  smooth: Vec2[];
  /** Total walking distance in metres across all segments. */
  length: number;
  /** Estimated total walking + lift time in seconds. */
  seconds: number;
  /** Combined turn-by-turn steps across all segments. */
  steps: RouteStep[];
}
