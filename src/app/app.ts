import {
  ChangeDetectionStrategy,
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
import { AzureAuthService } from './auth/azure-auth.service';
import { OutlookCalendarService } from './auth/outlook-calendar.service';
import { AuthGateComponent } from './components/auth-gate/auth-gate.component';
import { BookingModalComponent } from './components/booking-modal/booking-modal.component';
import {
  GlbAnalyzerComponent,
  type GlbPreviewPayload,
} from './components/glb-analyzer/glb-analyzer.component';
import { MapControlsComponent } from './components/map-controls/map-controls.component';
import { ResourceInspectorComponent } from './components/resource-inspector/resource-inspector.component';
import { SidebarComponent, type SidebarTab } from './components/sidebar/sidebar.component';
import { TopBarComponent } from './components/top-bar/top-bar.component';
import { KioskStore } from './kiosk.store';
import { BUILD_INFO } from './shared/build-info';
import { FloorplanEngine } from './three/floorplan-engine';
import { getFloorConfig, loadKioskConfig } from './wayfinding/kiosk-config';
import type { KioskResource, Reservation, RouteStep } from './wayfinding/models';

const IDLE_TIMEOUT_MS = 90_000;

/**
 * Root SpaceBoard PC Shell Component.
 *
 * Coordinates:
 * - Runtime configuration loading (`data/kiosk-config.json`) & Authentication bootstrap
 * - Three.js `FloorplanEngine` lifecycle, camera insets, multi-floor switching, and background preloading
 * - Idle auto-rotate timer, toast notifications, and composition of feature components
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    AuthGateComponent,
    TopBarComponent,
    SidebarComponent,
    ResourceInspectorComponent,
    BookingModalComponent,
    GlbAnalyzerComponent,
    MapControlsComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, OnDestroy {
  readonly store = inject(KioskStore);
  readonly auth = inject(AzureAuthService);
  private readonly outlookCalendar = inject(OutlookCalendarService);

  @ViewChild('viewport', { static: true }) viewportRef!: ElementRef<HTMLElement>;

  private engine?: FloorplanEngine;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private loadedActiveFloorId: string | null = null;
  private configReady = false;
  private floorPlansBooted = false;

  readonly sidebarCollapsed = signal(false);
  readonly sidebarTab = signal<SidebarTab>('search');
  readonly loadingFloorName = signal<string>('Floor Plan');
  readonly toastMessage = signal<string | null>(null);

  // Booking modal & GLB analyzer coordination signals
  readonly bookingModalOpen = signal(false);
  readonly bookingModalMode = signal<'create' | 'edit'>('create');
  readonly editingReservation = signal<Reservation | null>(null);
  readonly analyzerOpen = signal(false);

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
        void this.switchFloorScene(targetFloor);
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
      this.engine?.setInsets(collapsed ? 0 : 410, 0);
    });
  }

  ngOnInit(): void {
    (window as unknown as Record<string, unknown>)['__SPACEBOARD_VERSION__'] = BUILD_INFO;
    console.info(
      `[SpaceBoard PC] v${BUILD_INFO.version} (${BUILD_INFO.shortCommitId}${BUILD_INFO.dirty ? '-dirty' : ''} @ ${BUILD_INFO.branch}) • built ${BUILD_INFO.buildTime}`,
    );

    const host = this.viewportRef.nativeElement;
    this.engine = new FloorplanEngine(host);
    this.engine.setInsets(410, 0);

    this.engine.onPick = (id) => {
      this.bumpIdle();
      this.store.select(id ?? null, !!id);
    };

    this.engine.onInteraction = () => {
      this.bumpIdle();
      this.engine?.setAutoRotate(false);
    };

    void this.bootApplication();
    this.bumpIdle();
  }

  ngOnDestroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
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

  onSignOut(): void {
    void this.auth.logout();
  }

  async ensureFloorPlansBooted(): Promise<void> {
    if (this.floorPlansBooted) return;
    this.floorPlansBooted = true;
    this.configReady = true;
    void this.store.loadDataset();
    await this.bootFloorPlans();
  }

  onSelectResource(id: string): void {
    this.store.select(id, true);
  }

  onNavigateHere(id: string): void {
    this.sidebarTab.set('wayfinding');
    this.sidebarCollapsed.set(false);
    this.store.setTo(id);
  }

  onNavigateFromHere(id: string): void {
    this.sidebarTab.set('wayfinding');
    this.sidebarCollapsed.set(false);
    this.store.setFrom(id);
  }

  onStepClick(step: RouteStep): void {
    if (step.floor && step.floor !== this.store.floorFilter()) {
      this.store.viewRouteFloor(step.floor);
    }
  }

  openCreateBooking(res: KioskResource): void {
    this.store.select(res.id, true);
    this.bookingModalMode.set('create');
    this.editingReservation.set(null);
    this.bookingModalOpen.set(true);
  }

  openEditBooking(res: Reservation): void {
    this.store.select(res.resourceId, false);
    this.bookingModalMode.set('edit');
    this.editingReservation.set(res);
    this.bookingModalOpen.set(true);
  }

  closeBookingModal(): void {
    this.bookingModalOpen.set(false);
    this.editingReservation.set(null);
  }

  async onCancelReservation(res: Reservation): Promise<void> {
    if (res.outlookEventId && this.auth.isAzureAdAuthenticated()) {
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

  onEndReservation(res: Reservation): void {
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

  async onPreviewUploadedGlb(payload: GlbPreviewPayload): Promise<void> {
    if (!this.engine) return;
    this.loadingFloorName.set(`${payload.fileName} (Preview)`);
    this.store.status.set('loading');
    this.store.progress.set(50);
    try {
      const site = this.store.siteFilter() || 'Preview';
      const { resources, wayfinder } = await this.engine.loadFloorFromBuffer(
        payload.floorId,
        payload.buffer,
        payload.kioskId,
        site,
      );
      this.loadedActiveFloorId = payload.floorId;
      this.store.floors.update((list) =>
        list.includes(payload.floorId) ? list : [...list, payload.floorId],
      );
      this.store.floorFilter.set(payload.floorId);
      this.store.registerFloorData(payload.floorId, resources, wayfinder);
      this.store.status.set('ready');
      this.engine.syncResources(this.store.resources(), this.store.availabilityById());
      this.showToast(`Previewing ${payload.fileName} (${resources.length} resources detected)`);
    } catch (err) {
      console.error('Failed to preview uploaded GLB:', err);
      this.store.status.set('ready');
      this.showToast('Unable to preview GLB in 3D viewport.');
    }
  }

  showToast(message: string): void {
    this.toastMessage.set(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastMessage.set(null), 4000);
  }

  private async bootApplication(): Promise<void> {
    const runtimeCfg = await loadKioskConfig();
    this.store.applyRuntimeConfig(runtimeCfg);

    const authenticated = await this.auth.initialize(runtimeCfg.auth);
    if (!authenticated) return;

    await this.ensureFloorPlansBooted();
  }

  private async bootFloorPlans(): Promise<void> {
    if (!this.engine) return;
    const dev = this.store.activeDevice();
    await this.switchFloorScene(dev.floorId);

    for (const cfg of this.store.floorConfigs()) {
      if (cfg.id === dev.floorId) continue;
      this.engine
        .preloadFloor(cfg.id, cfg.modelUrl, undefined, cfg.site)
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
        cfg.site,
      );
      this.store.registerFloorData(cfg.id, resources, wayfinder);
      this.store.status.set('ready');
      this.engine.syncResources(this.store.resources(), this.store.availabilityById());

      const route = this.store.route();
      if (route) {
        this.engine.showRoute(route);
      } else if (this.store.selectedId()) {
        this.engine.focusResource(this.store.selectedId()!);
      }
    } catch (err) {
      console.error(`Failed to load ${cfg.id} GLB:`, err);
      this.store.error.set(
        `Could not load ${cfg.id} (${cfg.modelUrl}). Ensure the optimized model exists.`,
      );
      this.store.status.set('error');
    }
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.store.route() && !this.bookingModalOpen() && this.auth.isAuthenticated()) {
        this.engine?.setAutoRotate(true);
      }
    }, IDLE_TIMEOUT_MS);
  }
}
