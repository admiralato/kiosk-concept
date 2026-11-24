import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KioskStore, timeToMinutes, type KindFilter } from './kiosk.store';
import { AzureAuthService } from './auth/azure-auth.service';
import { OutlookCalendarService } from './auth/outlook-calendar.service';
import {
  AMENITY_COLORS,
  FloorplanEngine,
  KIND_COLORS,
  STATUS_COLORS,
  type ViewMode,
} from './three/floorplan-engine';
import { getFloorConfig, loadKioskConfig } from './wayfinding/kiosk-config';
import { KIND_LABELS, type ResourceKind } from './wayfinding/resource-config';
import type {
  AvailabilityStatus,
  KioskResource,
  Reservation,
  RouteStep,
  TurnKind,
} from './wayfinding/models';

const IDLE_TIMEOUT_MS = 90_000;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  readonly store = inject(KioskStore);
  readonly auth = inject(AzureAuthService);
  private readonly outlookCalendar = inject(OutlookCalendarService);

  @ViewChild('viewport', { static: true }) viewportRef!: ElementRef<HTMLElement>;

  private engine?: FloorplanEngine;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private loadedActiveFloorId: string | null = null;
  private configReady = false;

  readonly currentTime = signal(this.formatClock(new Date()));
  readonly currentDate = signal(this.formatDate(new Date()));
  readonly sidebarCollapsed = signal(false);
  readonly sidebarTab = signal<'search' | 'wayfinding'>('search');
  readonly showEquipmentFilter = signal(false);
  readonly showFullSchedule = signal(false);
  readonly loadingFloorName = signal<string>('Floor Plan');

  // Create / Update Booking Modal State
  readonly bookingModalOpen = signal(false);
  readonly bookingModalMode = signal<'create' | 'edit'>('create');
  readonly editingReservation = signal<Reservation | null>(null);
  readonly bookingSubject = signal('');
  readonly bookingOrganizer = signal('');
  readonly bookingDate = signal('');
  readonly bookingStartTime = signal('');
  readonly bookingEndTime = signal('');
  readonly bookingStartNow = signal(false);
  readonly bookingAttendees = signal('');
  readonly bookingNotes = signal('');
  readonly bookingOnlineMeeting = signal(false);
  readonly bookingSubmitting = signal(false);
  readonly bookingError = signal<string | null>(null);
  readonly bookingSuccessBanner = signal<string | null>(null);

  readonly timeSlots: string[] = Array.from({ length: 34 }, (_, i) => {
    const totalMinutes = 6 * 60 + i * 30; // 06:00 to 22:30
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  });

  readonly dayTimelineHours: number[] = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

  readonly kindFilters: ReadonlyArray<{ id: KindFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'meeting-room', label: 'Rooms' },
    { id: 'desk', label: 'Desks' },
    { id: 'amenity', label: 'Amenities' },
    { id: 'lift', label: 'Lifts' },
  ];

  readonly kindLabels = KIND_LABELS;
  readonly kindColors = KIND_COLORS;
  readonly statusColors = STATUS_COLORS;

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this.bookingModalOpen.set(false);
      }
    });

    effect(() => {
      const dev = this.store.activeDevice();
      this.engine?.setActiveKioskId(dev.resourceId);
    });

    effect(() => {
      const targetFloor = this.store.floorFilter();
      if (this.configReady && this.engine && targetFloor && targetFloor !== this.loadedActiveFloorId) {
        this.switchFloorScene(targetFloor);
      }
    });

    effect(() => {
      const sel = this.store.selectedId();
      this.engine?.setSelected(sel);
    });

    effect(() => {
      const resources = this.store.resources();
      const statusMap = this.store.availabilityById();
      if (resources.length) {
        this.engine?.syncResources(resources, statusMap);
      }
    });

    effect(() => {
      const r = this.store.route();
      this.engine?.showRoute(r);
    });

    effect(() => {
      const mode = this.store.viewMode();
      this.engine?.setViewMode(mode);
    });

    effect(() => {
      const cut = this.store.cutaway();
      this.engine?.setCutaway(cut);
    });

    effect(() => {
      const req = this.store.focusRequest();
      if (req) this.engine?.focusResource(req.id);
    });

    effect(() => {
      const n = this.store.homeRequest();
      if (n > 0) this.engine?.goHome(true);
    });

    effect(() => {
      const collapsed = this.sidebarCollapsed();
      const left = collapsed ? 0 : 410;
      this.engine?.setInsets(left, 0);
    });
  }

  ngOnInit(): void {
    this.clockTimer = setInterval(() => {
      const now = new Date();
      this.currentTime.set(this.formatClock(now));
      this.currentDate.set(this.formatDate(now));
    }, 10_000);

    const host = this.viewportRef.nativeElement;
    this.engine = new FloorplanEngine(host);
    this.engine.setInsets(410, 0);

    this.engine.onPick = (id) => {
      this.bumpIdle();
      if (!id) {
        this.store.select(null);
        return;
      }
      this.store.select(id, true);
    };

    this.engine.onInteraction = () => {
      this.bumpIdle();
      this.engine?.setAutoRotate(false);
    };

    this.bootApplication();
    this.bumpIdle();
  }

  ngOnDestroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.auth.dispose();
    this.engine?.dispose();
  }

  @HostListener('window:pointerdown')
  @HostListener('window:keydown')
  onUserActivity(): void {
    this.bumpIdle();
    this.engine?.setAutoRotate(false);
  }

  /**
   * Loads runtime floor & kiosk configuration from `data/kiosk-config.json` first,
   * validates Azure AD OAuth 2.0 + OIDC authentication, and then boots the default
   * floor plan + background preloading of remaining floors.
   */
  private async bootApplication(): Promise<void> {
    const runtimeCfg = await loadKioskConfig();
    this.store.applyRuntimeConfig(runtimeCfg);

    const authenticated = await this.auth.initialize(runtimeCfg.auth);
    if (!authenticated) {
      return;
    }

    this.configReady = true;
    this.store.loadDataset();
    await this.bootFloorPlans();
  }

  signIn(): void {
    void this.auth.login();
  }

  signOut(): void {
    void this.auth.logout();
  }

  /**
   * Loads the default floor plan for the active kiosk device first, then
   * preloads and caches the other floor plan(s) in the background so multi-floor
   * wayfinding and floor switching are instant.
   */
  private async bootFloorPlans(): Promise<void> {
    if (!this.engine) return;
    const dev = this.store.activeDevice();
    await this.switchFloorScene(dev.floorId);

    // Preload remaining floors in the background into CacheStorage + memory
    for (const cfg of this.store.floorConfigs()) {
      if (cfg.id === dev.floorId) continue;
      this.engine
        .preloadFloor(cfg.id, cfg.modelUrl)
        .then(({ floorId, resources, wayfinder }) => {
          this.store.registerFloorData(floorId, resources, wayfinder);
          this.engine?.syncResources(this.store.resources(), this.store.availabilityById());
        })
        .catch((err) => console.warn(`Background preload of ${cfg.id} skipped:`, err));
    }
  }

  private async switchFloorScene(floorId: string): Promise<void> {
    if (!this.engine) return;
    const cfg = getFloorConfig(floorId, this.store.floorConfigs());
    const alreadyInMemory = this.engine.isFloorInMemory(cfg.id);
    this.loadedActiveFloorId = cfg.id;
    this.loadingFloorName.set(cfg.id);

    if (!alreadyInMemory) {
      this.store.status.set('loading');
      this.store.progress.set(0);
    }

    try {
      const { resources, wayfinder } = await this.engine.loadFloor(
        cfg.id,
        cfg.modelUrl,
        this.store.activeDevice().resourceId,
        (fraction) => this.store.progress.set(Math.round(fraction * 100)),
      );
      this.store.registerFloorData(cfg.id, resources, wayfinder);
      this.store.status.set('ready');
      this.engine.syncResources(this.store.resources(), this.store.availabilityById());

      // Re-display the active route segment or selected focus on the newly activated floor
      const route = this.store.route();
      if (route) {
        this.engine.showRoute(route);
      } else if (this.store.selectedId()) {
        this.engine.focusResource(this.store.selectedId()!);
      }
    } catch (err) {
      console.error(`Failed to load ${cfg.id} GLB:`, err);
      this.store.status.set('error');
      this.store.error.set(err instanceof Error ? err.message : `Failed to load ${cfg.id}`);
    }
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.bookingModalOpen.set(false);
      this.editingReservation.set(null);
      this.showFullSchedule.set(false);
      this.store.reset();
      this.engine?.setAutoRotate(true);
    }, IDLE_TIMEOUT_MS);
  }

  private showToast(message: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.bookingSuccessBanner.set(message);
    this.toastTimer = setTimeout(() => this.bookingSuccessBanner.set(null), 5000);
  }

  setViewMode(mode: ViewMode): void {
    this.store.viewMode.set(mode);
  }

  toggleCutaway(): void {
    this.store.cutaway.update((v) => !v);
  }

  onSelectFromList(id: string): void {
    this.store.select(id, true);
  }

  onNavigateHere(id: string, event?: Event): void {
    event?.stopPropagation();
    this.sidebarTab.set('wayfinding');
    this.store.navigateTo(id);
  }

  onNavigateFromHere(id: string, event?: Event): void {
    event?.stopPropagation();
    this.sidebarTab.set('wayfinding');
    this.store.navigateFrom(id);
  }

  onStepClick(step: RouteStep): void {
    if (step.floor && step.floor !== this.store.floorFilter()) {
      this.store.viewRouteFloor(step.floor);
    }
  }

  /** Opens modal to create a new reservation. */
  openBookingModal(res: KioskResource, event?: Event): void {
    event?.stopPropagation();
    this.store.select(res.id, true);
    this.bookingModalMode.set('create');
    this.editingReservation.set(null);
    this.bookingSubject.set('');
    this.bookingOrganizer.set(this.auth.user()?.name ?? '');
    this.bookingDate.set(this.store.filterDate());
    this.bookingStartTime.set(this.store.startTime());
    this.bookingEndTime.set(this.store.endTime());
    this.bookingStartNow.set(false);
    this.bookingAttendees.set('');
    this.bookingNotes.set('');
    this.bookingOnlineMeeting.set(false);
    this.bookingSubmitting.set(false);
    this.bookingError.set(null);
    this.bookingModalOpen.set(true);
  }

  /**
   * Opens modal to edit an existing reservation:
   * - If res.status === 'starting': all fields are editable.
   * - If res.status === 'started': only Subject is editable.
   */
  openEditReservationModal(res: Reservation, event?: Event): void {
    event?.stopPropagation();
    this.store.select(res.resourceId, false);
    this.bookingModalMode.set('edit');
    this.editingReservation.set(res);
    this.bookingSubject.set(res.subject);
    this.bookingOrganizer.set(res.organizer);
    this.bookingDate.set(res.date);
    this.bookingStartTime.set(res.startTime);
    this.bookingEndTime.set(res.endTime);
    this.bookingStartNow.set(res.status === 'started');
    this.bookingAttendees.set((res.attendees ?? []).join(', '));
    this.bookingNotes.set('');
    this.bookingOnlineMeeting.set(!!res.isOnlineMeeting);
    this.bookingSubmitting.set(false);
    this.bookingError.set(null);
    this.bookingModalOpen.set(true);
  }

  closeBookingModal(): void {
    this.bookingModalOpen.set(false);
    this.editingReservation.set(null);
    this.bookingError.set(null);
  }

  async submitBooking(): Promise<void> {
    if (this.bookingSubmitting()) return;
    this.bookingError.set(null);

    if (this.bookingModalMode() === 'edit') {
      const target = this.editingReservation();
      if (!target) return;

      const cleanSubject = this.bookingSubject().trim();
      if (!cleanSubject) {
        this.bookingError.set('Subject cannot be empty.');
        return;
      }

      // Sync changes to Outlook Calendar if this reservation is linked to a Graph event
      if (target.outlookEventId && this.auth.status() === 'authenticated') {
        this.bookingSubmitting.set(true);
        try {
          await this.outlookCalendar.updateRoomEvent(target.outlookEventId, {
            subject: cleanSubject,
            ...(target.status === 'starting'
              ? {
                  date: this.bookingDate(),
                  startTime: this.bookingStartTime(),
                  endTime: this.bookingEndTime(),
                }
              : {}),
          });
        } catch (err) {
          this.bookingError.set(
            err instanceof Error ? err.message : 'Unable to update Outlook calendar event.',
          );
          return;
        } finally {
          this.bookingSubmitting.set(false);
        }
      }

      const result = this.store.updateReservation({
        id: target.id,
        subject: this.bookingSubject(),
        organizer: this.bookingOrganizer(),
        date: this.bookingDate(),
        startTime: this.bookingStartTime(),
        endTime: this.bookingEndTime(),
      });
      if (!result.ok) {
        this.bookingError.set(result.error ?? 'Unable to update reservation.');
        return;
      }
      this.closeBookingModal();
      this.showToast(
        target.outlookEventId
          ? `Updated Outlook reservation "${result.reservation?.subject}"`
          : `Updated reservation "${result.reservation?.subject}"`,
      );
      return;
    }

    const sel = this.store.selected();
    if (!sel) return;

    const sMin = timeToMinutes(this.bookingStartTime());
    const eMin = timeToMinutes(this.bookingEndTime());
    if (eMin <= sMin) {
      this.bookingError.set('End time must be after start time.');
      return;
    }

    const exchangeId = sel.exchangeId?.trim() || '';
    const attendeeEmails = this.bookingAttendees()
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes('@'));

    let outlookEventId: string | undefined;
    let outlookWebLink: string | undefined;

    // Book directly in Outlook / Exchange via Microsoft Graph when exchangeId is present
    if (exchangeId && this.auth.status() === 'authenticated') {
      this.bookingSubmitting.set(true);
      try {
        const created = await this.outlookCalendar.createRoomEvent({
          roomName: sel.name,
          exchangeId,
          subject: this.bookingSubject(),
          date: this.bookingDate(),
          startTime: this.bookingStartTime(),
          endTime: this.bookingEndTime(),
          attendeeEmails,
          notes: this.bookingNotes(),
          isOnlineMeeting: this.bookingOnlineMeeting(),
        });
        outlookEventId = created.id;
        outlookWebLink = created.webLink;
      } catch (err) {
        this.bookingError.set(
          err instanceof Error ? err.message : 'Unable to create Outlook calendar event.',
        );
        return;
      } finally {
        this.bookingSubmitting.set(false);
      }
    }

    const result = this.store.createBooking({
      resourceId: sel.id,
      subject: this.bookingSubject(),
      organizer: this.bookingOrganizer(),
      date: this.bookingDate(),
      startTime: this.bookingStartTime(),
      endTime: this.bookingEndTime(),
      startNow: this.bookingStartNow(),
      outlookEventId,
      outlookWebLink,
      attendees: attendeeEmails,
      isOnlineMeeting: this.bookingOnlineMeeting(),
    });
    if (!result.ok) {
      this.bookingError.set(result.error ?? 'Unable to complete booking.');
      return;
    }
    this.closeBookingModal();
    this.showToast(
      outlookEventId
        ? `Booked ${sel.name} in Outlook on ${this.formatDisplayDate(this.bookingDate())} (${this.formatTime12h(this.bookingStartTime())} – ${this.formatTime12h(this.bookingEndTime())})`
        : `Booked ${sel.name} on ${this.formatDisplayDate(this.bookingDate())} (${this.formatTime12h(this.bookingStartTime())} – ${this.formatTime12h(this.bookingEndTime())})`,
    );
  }

  /** Cancels an upcoming reservation (status === 'starting'). */
  async onCancelReservation(res: Reservation, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (res.outlookEventId && this.auth.status() === 'authenticated') {
      try {
        await this.outlookCalendar.cancelRoomEvent(res.outlookEventId);
      } catch (err) {
        this.showToast(
          err instanceof Error ? err.message : 'Unable to cancel Outlook calendar event.',
        );
        return;
      }
    }

    const result = this.store.cancelReservation(res.id);
    if (!result.ok) {
      this.showToast(result.error ?? 'Unable to cancel reservation.');
      return;
    }
    if (this.editingReservation()?.id === res.id) {
      this.closeBookingModal();
    }
    this.showToast(
      res.outlookEventId
        ? `Cancelled Outlook reservation "${res.subject}".`
        : `Cancelled upcoming reservation "${res.subject}".`,
    );
  }

  /** Ends an active reservation (status === 'started'). */
  onEndReservation(res: Reservation, event?: Event): void {
    event?.stopPropagation();
    const result = this.store.endReservation(res.id);
    if (!result.ok) {
      this.showToast(result.error ?? 'Unable to end reservation.');
      return;
    }
    if (this.editingReservation()?.id === res.id) {
      this.closeBookingModal();
    }
    this.showToast(`Ended reservation "${res.subject}". Resource is now Available.`);
  }

  statusLabel(status: AvailabilityStatus): string {
    switch (status) {
      case 'available':
        return 'Available';
      case 'reserved':
        return 'Reserve';
      case 'occupied':
        return 'Occupied';
    }
  }

  statusColor(status: AvailabilityStatus): string {
    return STATUS_COLORS[status];
  }

  resourceSwatchColor(item: KioskResource): string {
    if (!item.bookable) return AMENITY_COLORS[item.resourceType] ?? KIND_COLORS[item.kind];
    return STATUS_COLORS[this.store.statusOf(item.id)];
  }

  formatTime12h(time24: string): string {
    const [hStr, mStr] = time24.split(':');
    const h = parseInt(hStr, 10);
    if (Number.isNaN(h)) return time24;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mStr} ${suffix}`;
  }

  formatDisplayDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
    if (!y || !m || !d) return dateStr;
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  /** Computes left% and width% for a reservation bar on the 07:00–19:00 day timeline. */
  reservationBarStyle(startTime: string, endTime: string): { left: string; width: string } {
    const dayStart = 7 * 60;
    const daySpan = 12 * 60; // 07:00 to 19:00
    const s = Math.max(dayStart, Math.min(dayStart + daySpan, timeToMinutes(startTime)));
    const e = Math.max(s + 15, Math.min(dayStart + daySpan, timeToMinutes(endTime)));
    const left = ((s - dayStart) / daySpan) * 100;
    const width = ((e - s) / daySpan) * 100;
    return { left: `${left.toFixed(1)}%`, width: `${width.toFixed(1)}%` };
  }

  formatDistance(m: number): string {
    if (m < 1) return '< 1 m';
    return `${Math.round(m)} m`;
  }

  formatDuration(sec: number): string {
    const mins = Math.max(1, Math.round(sec / 60));
    return sec < 45 ? `${Math.max(5, Math.round(sec / 5) * 5)} sec` : `${mins} min`;
  }

  turnIcon(turn: TurnKind): string {
    switch (turn) {
      case 'start':
        return 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z';
      case 'left':
        return 'M11 9l1.42 1.42L8.83 14H18v7h2v-9H8.83l3.59-3.58L11 7l-6 6 6 6z';
      case 'right':
        return 'M13 9l-1.42 1.42L15.17 14H6v7H4v-9h11.17l-3.59-3.58L13 7l6 6-6 6z';
      case 'slight-left':
        return 'M11.67 6L9 8.67l1.41 1.41L12 8.5V20h2V8c0-.55-.22-1.05-.59-1.41L11.67 6z';
      case 'slight-right':
        return 'M12.33 6L15 8.67l-1.41 1.41L12 8.5V20h-2V8c0-.55.22-1.05.59-1.41L12.33 6z';
      case 'u-turn':
        return 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z';
      case 'lift':
        return 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM8.5 6a1.25 1.25 0 110 2.5 1.25 1.25 0 010-2.5zM11 14h-1v4H7v-4H6v-2.5c0-1.1.9-2 2-2h1c1.1 0 2 .9 2 2V14zm4.5 3L13 14h5l-2.5 3zm-2.5-5l2.5-3 2.5 3h-5z';
      case 'arrive':
        return 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm-1.2 11.7L7.4 10.3l1.4-1.4 2 2 4.4-4.4 1.4 1.4-5.8 5.8z';
      default:
        return 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z';
    }
  }

  kindColor(kind: ResourceKind): string {
    return KIND_COLORS[kind];
  }

  private formatClock(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private formatDate(d: Date): string {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
}
