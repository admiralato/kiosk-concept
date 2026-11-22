import { computed, Injectable, signal } from '@angular/core';
import type {
  AvailabilityStatus,
  KioskResource,
  Reservation,
  ReservationStatus,
  ResourceCatalogEntry,
  ResourceSubType,
  Route,
  SpaceBoardDataset,
} from './wayfinding/models';
import {
  FLOOR_CONFIGS,
  KIOSK_DEVICES,
  resolveKioskDevice,
  resolveKioskDeviceFromUrl,
  type KioskDeviceConfig,
} from './wayfinding/kiosk-config';
import type { ResourceKind } from './wayfinding/resource-config';
import type { Wayfinder } from './wayfinding/wayfinder';
import type { ViewMode } from './three/floorplan-engine';

export type KindFilter = ResourceKind | 'all';
export type ResourceTypeFilter = ResourceSubType | 'all';

const KIND_ORDER: ResourceKind[] = ['meeting-room', 'desk', 'amenity', 'lift', 'kiosk'];

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function defaultStartSlot(now: Date): string {
  const h = Math.min(22, Math.max(7, now.getHours()));
  const m = now.getMinutes() < 30 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
}

function defaultEndSlot(startSlot: string): string {
  const [hStr, mStr] = startSlot.split(':');
  let total = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + 60;
  total = Math.min(23 * 60 + 30, total);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map((v) => parseInt(v, 10) || 0);
  return h * 60 + m;
}

/** Application state of SpaceBoard PC (signals based, multi-floor & multi-kiosk aware). */
@Injectable({ providedIn: 'root' })
export class KioskStore {
  private readonly initialStart = defaultStartSlot(new Date());
  private readonly initialDevice = resolveKioskDeviceFromUrl();

  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);
  readonly cachedFloors = signal<string[]>([]);

  /** Active kiosk device resolved from `?kioskId=` or default config fallback. */
  readonly activeDevice = signal<KioskDeviceConfig>(this.initialDevice);
  readonly kioskDevices = KIOSK_DEVICES;
  readonly floorConfigs = FLOOR_CONFIGS;

  /** Per-floor raw 3D scene resources + wayfinders. */
  private readonly floorResourcesMap = signal<Map<string, KioskResource[]>>(new Map());
  private readonly wayfinders = new Map<string, Wayfinder>();
  private readonly catalogMap = signal<Map<string, ResourceCatalogEntry>>(new Map());
  readonly reservations = signal<Reservation[]>([]);

  readonly sites = signal<string[]>(['Marina Bay Tower']);
  readonly floors = signal<string[]>(FLOOR_CONFIGS.map((f) => f.id));
  readonly resourceTypes = signal<ResourceSubType[]>([
    'Meeting Room',
    'Private Room',
    'Focus Room',
    'Desk',
  ]);
  readonly equipmentOptions = signal<string[]>([]);

  // Search & Booking Filter Signals
  readonly siteFilter = signal<string>('Marina Bay Tower');
  /** Currently viewed 3D floor plan ('Level 12' or 'Level 13'). */
  readonly floorFilter = signal<string>(this.initialDevice.floorId);
  /** Whether the directory list searches across all loaded floors or only the active floor. */
  readonly searchAllFloors = signal<boolean>(true);
  readonly query = signal('');
  readonly filter = signal<KindFilter>('all');
  readonly resourceTypeFilter = signal<ResourceTypeFilter>('all');
  readonly selectedEquipment = signal<string[]>([]);
  readonly filterDate = signal<string>(toDateInputValue(new Date()));
  readonly startTime = signal<string>(this.initialStart);
  readonly endTime = signal<string>(defaultEndSlot(this.initialStart));
  readonly onlyAvailable = signal<boolean>(false);

  // Selection, Wayfinding & Viewport Signals
  readonly selectedId = signal<string | null>(null);
  readonly fromId = signal<string>(this.initialDevice.resourceId);
  readonly toId = signal<string | null>(null);
  readonly route = signal<Route | null>(null);
  readonly routeError = signal<string | null>(null);

  readonly viewMode = signal<ViewMode>('3d');
  readonly cutaway = signal(true);

  /** Bumped whenever the visitor explicitly asks to look at a resource. */
  readonly focusRequest = signal<{ id: string; n: number } | null>(null);
  readonly homeRequest = signal(0);

  /** All scene resources across all loaded floors merged with rich metadata from spaceboard-data.json. */
  readonly resources = computed<KioskResource[]>(() => {
    const byFloor = this.floorResourcesMap();
    const cat = this.catalogMap();
    const all: KioskResource[] = [];
    for (const list of byFloor.values()) {
      for (const r of list) {
        const entry = cat.get(r.id);
        if (!entry) {
          all.push(r);
        } else {
          all.push({
            ...r,
            name: r.name,
            subtitle:
              entry.displayName && entry.displayName !== r.name ? entry.displayName : undefined,
            code: r.code,
            site: entry.site,
            floor: entry.floor,
            resourceType: entry.resourceType || r.resourceType,
            capacity: entry.capacity,
            equipment: entry.equipment,
            description: entry.description,
            bookable: true,
          });
        }
      }
    }
    return all;
  });

  /** Resources belonging to the currently active 3D floor view. */
  readonly activeFloorResources = computed(() => {
    const fl = this.floorFilter();
    return this.resources().filter((r) => r.floor === fl);
  });

  readonly homeKioskId = computed(() => this.activeDevice().resourceId);
  readonly home = computed(() => this.byId(this.homeKioskId()));
  readonly selected = computed(() => this.byId(this.selectedId()));
  readonly from = computed(() => this.byId(this.fromId()));
  readonly to = computed(() => this.byId(this.toId()));

  /**
   * Availability status ('available' | 'reserved' | 'occupied') for every resource
   * across the selected Date + [startTime, endTime] window.
   */
  readonly availabilityById = computed<Record<string, AvailabilityStatus>>(() => {
    const date = this.filterDate();
    const startMin = timeToMinutes(this.startTime());
    const endMin = Math.max(startMin + 15, timeToMinutes(this.endTime()));
    const list = this.reservations();
    const map: Record<string, AvailabilityStatus> = {};

    for (const r of this.resources()) {
      if (!r.bookable) continue;
      map[r.id] = 'available';
    }

    for (const res of list) {
      if (res.date !== date) continue;
      const rStart = timeToMinutes(res.startTime);
      const rEnd = timeToMinutes(res.endTime);
      if (startMin < rEnd && endMin > rStart) {
        const current = map[res.resourceId];
        if (res.status === 'started') {
          map[res.resourceId] = 'occupied';
        } else if (current !== 'occupied') {
          map[res.resourceId] = 'reserved';
        }
      }
    }
    return map;
  });

  /** Summary counts of Available, Reserve, and Occupied bookable resources on the currently viewed floor. */
  readonly statusSummary = computed(() => {
    const avail = this.availabilityById();
    const counts = { available: 0, reserved: 0, occupied: 0 };
    for (const r of this.activeFloorResources()) {
      if (!r.bookable) continue;
      const st = avail[r.id] ?? 'available';
      counts[st]++;
    }
    return counts;
  });

  /** Reservations for the currently selected resource on the active date, sorted by start time. */
  readonly selectedDayReservations = computed<Reservation[]>(() => {
    const id = this.selectedId();
    const date = this.filterDate();
    if (!id) return [];
    return this.reservations()
      .filter((r) => r.resourceId === id && r.date === date)
      .slice()
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  });

  /** Next or active reservation for the currently selected resource (today or later). */
  readonly selectedNextReservation = computed<Reservation | null>(() => {
    const id = this.selectedId();
    if (!id) return null;
    const date = this.filterDate();
    const startMin = timeToMinutes(this.startTime());
    const allForResource = this.reservations()
      .filter((r) => r.resourceId === id && r.date >= date)
      .slice()
      .sort((a, b) =>
        a.date.localeCompare(b.date) || timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
      );
    return (
      allForResource.find(
        (r) => r.date > date || timeToMinutes(r.endTime) > startMin,
      ) ?? null
    );
  });

  /** Everything a visitor can navigate to/from across all loaded floors. */
  readonly places = computed(() =>
    this.resources()
      .filter((r) => r.anchor)
      .slice()
      .sort((a, b) =>
        a.floor.localeCompare(b.floor, undefined, { numeric: true }) ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.id.localeCompare(b.id, undefined, { numeric: true }),
      ),
  );

  readonly destinations = computed(() => this.places().filter((r) => r.kind !== 'kiosk'));

  readonly counts = computed(() => {
    const c: Record<string, number> = { all: 0 };
    const fl = this.floorFilter();
    const allFl = this.searchAllFloors();
    for (const r of this.destinations()) {
      if (!allFl && r.floor !== fl) continue;
      c[r.kind] = (c[r.kind] ?? 0) + 1;
      c['all']++;
    }
    return c;
  });

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase().replace(/[\s._-]+/g, '');
    const kindF = this.filter();
    const siteF = this.siteFilter();
    const floorF = this.floorFilter();
    const allFl = this.searchAllFloors();
    const typeF = this.resourceTypeFilter();
    const equipF = this.selectedEquipment();
    const onlyAvail = this.onlyAvailable();
    const availMap = this.availabilityById();

    return this.destinations().filter((r) => {
      if (!allFl && floorF && floorF !== 'all' && r.floor !== floorF) return false;
      if (kindF !== 'all' && r.kind !== kindF) return false;
      if (r.bookable) {
        if (siteF && siteF !== 'all' && r.site !== siteF) return false;
        if (typeF !== 'all' && r.resourceType !== typeF) return false;
        if (equipF.length > 0 && !equipF.every((eq) => r.equipment.includes(eq))) return false;
        if (onlyAvail && availMap[r.id] !== 'available') return false;
      } else {
        if (typeF !== 'all' && r.resourceType !== typeF) return false;
        if (equipF.length > 0 || onlyAvail) return false;
      }
      if (!q) return true;
      const hay = `${r.name}${r.subtitle ?? ''}${r.code}${r.id}${r.floor}${r.resourceType}${r.equipment.join('')}`
        .toLowerCase()
        .replace(/[\s._-]+/g, '');
      return hay.includes(q);
    });
  });

  /** Registers a loaded/preloaded floor's resources and Wayfinder into the multi-floor store. */
  registerFloorData(floorId: string, resources: KioskResource[], wayfinder: Wayfinder): void {
    this.wayfinders.set(floorId, wayfinder);
    this.floorResourcesMap.update((prev) => {
      const next = new Map(prev);
      next.set(floorId, resources);
      return next;
    });
    this.cachedFloors.update((list) => (list.includes(floorId) ? list : [...list, floorId]));
    // Recompute active route if a pending cross-floor destination just finished loading
    if (this.toId()) {
      this.computeRoute(false);
    }
  }

  /** Switches the active kiosk device (and updates URL `?kioskId=` without reloading the page). */
  setKioskDevice(deviceIdOrAlias: string): void {
    const dev = resolveKioskDevice(deviceIdOrAlias);
    this.activeDevice.set(dev);
    this.floorFilter.set(dev.floorId);
    this.fromId.set(dev.resourceId);
    this.toId.set(null);
    this.route.set(null);
    this.routeError.set(null);
    this.selectedId.set(null);

    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.set('kioskId', dev.deviceId);
      window.history.replaceState({}, '', url.toString());
    }
  }

  /**
   * Switches the currently displayed 3D floor plan.
   * By default (`clearNavigation = true`), switching floors clears any active wayfinding route.
   * When viewing a specific leg of a multi-floor route (`viewRouteFloor()`), `clearNavigation` is false.
   */
  setFloor(floorId: string, clearNavigation = true): void {
    if (this.floorFilter() === floorId) return;
    this.floorFilter.set(floorId);

    if (clearNavigation) {
      if (this.route() || this.toId()) {
        this.clearRoute();
      }
      this.selectedId.set(null);
      return;
    }

    // Update the active route's displayed segment if inspecting a multi-floor route leg
    const curRoute = this.route();
    if (curRoute?.multiFloor && curRoute.segments) {
      const seg = curRoute.segments.find((s) => s.floor === floorId) ?? curRoute.segments[0];
      this.route.set({
        ...curRoute,
        corners: seg.corners,
        smooth: seg.smooth,
      });
    }
  }

  /** Switches the 3D view to a specific floor leg of an active multi-floor route without clearing navigation. */
  viewRouteFloor(floorId: string): void {
    this.setFloor(floorId, false);
  }

  /** Loads the sample JSON dataset for catalog metadata and reservations. */
  async loadDataset(url = 'data/spaceboard-data.json'): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SpaceBoardDataset;

      const todayStr = toDateInputValue(new Date());
      const tomorrowStr = toDateInputValue(addDays(new Date(), 1));

      if (data.sites?.length) this.sites.set(data.sites);
      if (data.floors?.length) this.floors.set(data.floors);
      if (data.resourceTypes?.length) this.resourceTypes.set(data.resourceTypes);
      if (data.equipmentOptions?.length) this.equipmentOptions.set(data.equipmentOptions);

      const map = new Map<string, ResourceCatalogEntry>();
      for (const item of data.resources ?? []) {
        map.set(item.id, item);
      }
      this.catalogMap.set(map);

      const normalized: Reservation[] = (data.reservations ?? []).map((r) => {
        const status: ReservationStatus =
          r.status === 'started' || r.status === 'checked-in' ? 'started' : 'starting';
        return {
          id: r.id,
          resourceId: r.resourceId,
          subject: (r.subject ?? r.title ?? 'Workspace Reservation').trim(),
          organizer: r.organizer,
          date: r.date === 'TODAY' ? todayStr : r.date === 'TOMORROW' ? tomorrowStr : r.date,
          startTime: r.startTime,
          endTime: r.endTime,
          status,
        };
      });
      this.reservations.set(normalized);
    } catch (err) {
      console.error('Failed to load SpaceBoard JSON dataset:', err);
    }
  }

  byId(id: string | null): KioskResource | null {
    return id ? (this.resources().find((r) => r.id === id) ?? null) : null;
  }

  statusOf(id: string): AvailabilityStatus {
    return this.availabilityById()[id] ?? 'available';
  }

  toggleEquipment(eq: string): void {
    this.selectedEquipment.update((list) =>
      list.includes(eq) ? list.filter((x) => x !== eq) : [...list, eq],
    );
  }

  setStartTime(time: string): void {
    this.startTime.set(time);
    if (timeToMinutes(this.endTime()) <= timeToMinutes(time)) {
      this.endTime.set(defaultEndSlot(time));
    }
  }

  setEndTime(time: string): void {
    if (timeToMinutes(time) <= timeToMinutes(this.startTime())) {
      this.endTime.set(defaultEndSlot(this.startTime()));
    } else {
      this.endTime.set(time);
    }
  }

  /** Creates a new reservation for a bookable resource. */
  createBooking(payload: {
    resourceId: string;
    subject: string;
    organizer: string;
    date: string;
    startTime: string;
    endTime: string;
    startNow?: boolean;
  }): { ok: boolean; error?: string; reservation?: Reservation } {
    const resObj = this.byId(payload.resourceId);
    if (!resObj || !resObj.bookable) {
      return { ok: false, error: 'This resource cannot be booked.' };
    }
    const sMin = timeToMinutes(payload.startTime);
    const eMin = timeToMinutes(payload.endTime);
    if (eMin <= sMin) {
      return { ok: false, error: 'End time must be after start time.' };
    }

    const conflict = this.reservations().find((existing) => {
      if (existing.resourceId !== payload.resourceId || existing.date !== payload.date) return false;
      const exS = timeToMinutes(existing.startTime);
      const exE = timeToMinutes(existing.endTime);
      return sMin < exE && eMin > exS;
    });

    if (conflict) {
      return {
        ok: false,
        error: `Conflicts with "${conflict.subject}" (${conflict.startTime}–${conflict.endTime}).`,
      };
    }

    const newReservation: Reservation = {
      id: `RES-${Date.now().toString().slice(-5)}`,
      resourceId: payload.resourceId,
      subject: payload.subject.trim() || 'Ad-hoc Workspace Booking',
      organizer: payload.organizer.trim() || 'Kiosk Guest',
      date: payload.date,
      startTime: payload.startTime,
      endTime: payload.endTime,
      status: payload.startNow ? 'started' : 'starting',
    };

    this.reservations.update((list) => [...list, newReservation]);
    this.filterDate.set(payload.date);
    this.startTime.set(payload.startTime);
    this.endTime.set(payload.endTime);
    this.selectedId.set(payload.resourceId);
    return { ok: true, reservation: newReservation };
  }

  /**
   * Updates an existing reservation:
   * - If status === 'starting': all fields (subject, organizer, date, startTime, endTime) can be updated.
   * - If status === 'started': ONLY the subject can be updated.
   */
  updateReservation(payload: {
    id: string;
    subject: string;
    organizer?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
  }): { ok: boolean; error?: string; reservation?: Reservation } {
    const existing = this.reservations().find((r) => r.id === payload.id);
    if (!existing) {
      return { ok: false, error: 'Reservation not found.' };
    }

    const cleanSubject = payload.subject.trim();
    if (!cleanSubject) {
      return { ok: false, error: 'Subject cannot be empty.' };
    }

    if (existing.status === 'started') {
      const updated: Reservation = {
        ...existing,
        subject: cleanSubject,
      };
      this.reservations.update((list) => list.map((r) => (r.id === existing.id ? updated : r)));
      return { ok: true, reservation: updated };
    }

    const nextDate = payload.date ?? existing.date;
    const nextStart = payload.startTime ?? existing.startTime;
    const nextEnd = payload.endTime ?? existing.endTime;
    const nextOrganizer = (payload.organizer ?? existing.organizer).trim() || existing.organizer;

    const sMin = timeToMinutes(nextStart);
    const eMin = timeToMinutes(nextEnd);
    if (eMin <= sMin) {
      return { ok: false, error: 'End time must be after start time.' };
    }

    const conflict = this.reservations().find((other) => {
      if (other.id === existing.id) return false;
      if (other.resourceId !== existing.resourceId || other.date !== nextDate) return false;
      const oS = timeToMinutes(other.startTime);
      const oE = timeToMinutes(other.endTime);
      return sMin < oE && eMin > oS;
    });

    if (conflict) {
      return {
        ok: false,
        error: `Conflicts with "${conflict.subject}" (${conflict.startTime}–${conflict.endTime}).`,
      };
    }

    const updated: Reservation = {
      ...existing,
      subject: cleanSubject,
      organizer: nextOrganizer,
      date: nextDate,
      startTime: nextStart,
      endTime: nextEnd,
    };

    this.reservations.update((list) => list.map((r) => (r.id === existing.id ? updated : r)));
    this.filterDate.set(nextDate);
    this.startTime.set(nextStart);
    this.endTime.set(nextEnd);
    return { ok: true, reservation: updated };
  }

  /** Cancels an upcoming reservation (only allowed when status === 'starting'). */
  cancelReservation(reservationId: string): { ok: boolean; error?: string; cancelled?: Reservation } {
    const existing = this.reservations().find((r) => r.id === reservationId);
    if (!existing) {
      return { ok: false, error: 'Reservation not found.' };
    }
    if (existing.status !== 'starting') {
      return { ok: false, error: 'Only upcoming reservations (status = starting) can be cancelled.' };
    }
    this.reservations.update((list) => list.filter((r) => r.id !== reservationId));
    return { ok: true, cancelled: existing };
  }

  /** Ends an active reservation (only allowed when status === 'started'). */
  endReservation(reservationId: string): { ok: boolean; error?: string; ended?: Reservation } {
    const existing = this.reservations().find((r) => r.id === reservationId);
    if (!existing) {
      return { ok: false, error: 'Reservation not found.' };
    }
    if (existing.status !== 'started') {
      return { ok: false, error: 'Only active reservations (status = started) can be ended.' };
    }
    this.reservations.update((list) => list.filter((r) => r.id !== reservationId));
    return { ok: true, ended: existing };
  }

  /** Starts/Checks in an upcoming reservation (turning its status from 'starting' -> 'started'). */
  startReservation(reservationId: string): void {
    this.reservations.update((list) =>
      list.map((r) => (r.id === reservationId ? { ...r, status: 'started' } : r)),
    );
  }

  /** Tap on the map or in the directory. Automatically switches floor if resource is on another floor. */
  select(id: string | null, focus = false): void {
    const res = this.byId(id);
    if (res?.kind === 'kiosk') {
      this.selectedId.set(null);
      return;
    }
    if (res && res.floor !== this.floorFilter()) {
      this.setFloor(res.floor);
    }
    this.selectedId.set(id);
    if (id && focus) this.focusRequest.set({ id, n: (this.focusRequest()?.n ?? 0) + 1 });
  }

  /** Route from the current start (the active kiosk device by default) to `toId`. */
  navigateTo(toId: string): void {
    this.toId.set(toId);
    this.computeRoute(true);
  }

  /** Use `id` as the start of the route. */
  navigateFrom(id: string): void {
    const homeId = this.homeKioskId();
    this.fromId.set(id);
    if (this.toId() === id) this.toId.set(homeId === id ? null : homeId);
    if (!this.toId()) this.toId.set(homeId);
    this.computeRoute(true);
  }

  setFrom(id: string): void {
    this.fromId.set(id);
    this.computeRoute(true);
  }

  setTo(id: string): void {
    this.toId.set(id);
    this.computeRoute(true);
  }

  swap(): void {
    const from = this.fromId();
    const to = this.toId();
    if (!to) return;
    this.fromId.set(to);
    this.toId.set(from);
    this.computeRoute(true);
  }

  clearRoute(): void {
    this.route.set(null);
    this.routeError.set(null);
    this.toId.set(null);
    this.fromId.set(this.homeKioskId());
  }

  clearFilters(): void {
    this.query.set('');
    this.filter.set('all');
    this.resourceTypeFilter.set('all');
    this.selectedEquipment.set([]);
    this.onlyAvailable.set(false);
    this.siteFilter.set('Marina Bay Tower');
    this.searchAllFloors.set(true);
  }

  /** Back to the attract / home state for this kiosk device. */
  reset(): void {
    const dev = this.activeDevice();
    this.floorFilter.set(dev.floorId);
    this.clearRoute();
    this.selectedId.set(null);
    this.clearFilters();
    this.homeRequest.update((n) => n + 1);
  }

  private computeRoute(switchToOriginFloor = false): void {
    const fromId = this.fromId();
    const toId = this.toId();
    this.routeError.set(null);
    if (!toId) {
      this.route.set(null);
      return;
    }
    if (fromId === toId) {
      this.route.set(null);
      this.routeError.set('Start and destination are the same place.');
      return;
    }

    const fromRes = this.byId(fromId);
    const toRes = this.byId(toId);
    if (!fromRes || !toRes) {
      this.route.set(null);
      return;
    }

    const wfFrom = this.wayfinders.get(fromRes.floor);
    const wfTo = this.wayfinders.get(toRes.floor);
    if (!wfFrom || !wfTo) {
      this.route.set(null);
      this.routeError.set(`Loading ${!wfFrom ? fromRes.floor : toRes.floor} floor plan...`);
      return;
    }

    let r: Route | null = null;
    if (fromRes.floor === toRes.floor) {
      if (switchToOriginFloor && this.floorFilter() !== fromRes.floor) {
        this.floorFilter.set(fromRes.floor);
      }
      r = wfFrom.route(fromId, toId);
    } else {
      // Multi-floor route via Lift! Start by showing the origin floor leg (or current floor leg)
      if (switchToOriginFloor) {
        this.floorFilter.set(fromRes.floor);
      }
      r = wfFrom.routeMultiFloor(fromId, toId, wfTo, this.floorFilter());
    }

    if (!r) {
      this.route.set(null);
      this.routeError.set('Sorry, no walkable route could be found.');
      return;
    }

    // Enrich segments and endpoints with catalog display names
    const enrichedSegments = r.segments?.map((seg) => ({
      ...seg,
      from: this.byId(seg.from.id) ?? seg.from,
      to: this.byId(seg.to.id) ?? seg.to,
    }));

    this.route.set({
      ...r,
      from: fromRes,
      to: toRes,
      segments: enrichedSegments,
    });
    this.selectedId.set(toRes.kind === 'kiosk' ? null : toId);
  }
}
