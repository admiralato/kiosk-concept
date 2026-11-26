import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { NavGrid, type Footprint } from '../wayfinding/nav-grid';
import {
  formatResourcePropertyName,
  matchResource,
  NODE_PREFIX,
  type ResourceKind,
} from '../wayfinding/resource-config';
import type { AvailabilityStatus, KioskResource, ResourceSubType, Route } from '../wayfinding/models';
import { Wayfinder } from '../wayfinding/wayfinder';
import { RouteVisual } from './route-visual';
import { trianglesOf } from './three-nav-input';
import { fetchCachedGlbBuffer } from './floorplan-cache';

export type ViewMode = '3d' | '2d';

export interface LoadResult {
  floorId: string;
  resources: KioskResource[];
  wayfinder: Wayfinder;
  fromCache: boolean;
}

export const KIND_COLORS: Record<ResourceKind, string> = {
  'meeting-room': '#4caf6a',
  desk: '#4caf6a',
  amenity: '#0284c7',
  lift: '#64748b',
  kiosk: '#e11d48',
};

/** Distinct sign badge colors per amenity facility type. */
export const AMENITY_COLORS: Partial<Record<ResourceSubType, string>> = {
  'Male Toilet': '#2563eb',    // Blue
  'Female Toilet': '#db2777',  // Pink / Rose
  'PWD Toilet': '#0d9488',     // Accessible Teal
  'Nursing Room': '#7c3aed',   // Soft Violet / Purple
};

/** Status colors matching the SpaceBoard availability legend. */
export const STATUS_COLORS: Record<AvailabilityStatus, string> = {
  available: '#4caf6a', // Green — Available
  reserved: '#f0b429',  // Yellow/Amber — Reserve
  occupied: '#d9534f',  // Red/Coral — Occupied
};

type VisualState = 'idle' | 'hover' | 'selected' | 'endpoint';

interface ResourceVisual {
  resource: KioskResource;
  object: THREE.Object3D;
  plateMaterial: THREE.MeshBasicMaterial;
  outline: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  emissive: THREE.MeshStandardMaterial[];
  label: CSS2DObject;
  color: THREE.Color;
  status: AvailabilityStatus | null;
  lastState: VisualState | null;
}

interface KioskBeacon {
  resource: KioskResource;
  group: THREE.Group;
  labelEl: HTMLElement;
  pulseRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  headMesh: THREE.Mesh;
}

interface CachedFloorNavData {
  resources: KioskResource[];
  wayfinder: Wayfinder;
}

/** In-memory cache entry for an already-parsed 3D floor plan. */
interface CachedFloorScene {
  floorId: string;
  url: string;
  rootGroup: THREE.Group;
  bounds: THREE.Box3;
  structural: THREE.Object3D[];
  hanging: THREE.Object3D[];
  visuals: Map<string, ResourceVisual>;
  kioskBeacons: Map<string, KioskBeacon>;
  pickables: THREE.Object3D[];
  resources: KioskResource[];
  wayfinder: Wayfinder;
}

interface CameraAnimation {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  from: THREE.Spherical;
  to: THREE.Spherical;
  t: number;
  duration: number;
}

/** Walls & doors are lowered to this height in "cutaway" mode (dollhouse view). */
const CUTAWAY_WALL_HEIGHT = 1.25;
const MODEL_WALL_HEIGHT = 2.5;
const PLATE_LIFT = 0.012;

/**
 * Owns the three.js scene of SpaceBoard PC: loading and caching multi-floor 3D
 * floor plans, classifying nodes, picking, status highlighting, camera moves,
 * and single/multi-floor route rendering.
 */
export class FloorplanEngine {
  /** Called when the visitor taps a resource (or empty space → null). */
  onPick?: (id: string | null) => void;
  /** Called on any user interaction with the map (used for idle reset). */
  onInteraction?: () => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  private readonly controls: MapControls;
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly routeVisual = new RouteVisual();
  private readonly sun = new THREE.DirectionalLight('#ffffff', 1.6);
  private readonly bounds = new THREE.Box3();
  private readonly resizeObserver: ResizeObserver;

  /** In-memory active floor 3D scene cache (LRU = 1 active floor to keep GPU/CPU RAM bounded). */
  private readonly floorCache = new Map<string, CachedFloorScene>();
  /** Lightweight metadata + Wayfinder cache retained for all floors (~1–2 MB/floor, zero GPU VRAM). */
  private readonly floorNavCache = new Map<string, CachedFloorNavData>();
  /** In-flight loading promises so concurrent load requests share work. */
  private readonly inFlightLoads = new Map<string, Promise<CachedFloorScene>>();
  private readonly inFlightPreloads = new Map<string, Promise<CachedFloorNavData>>();

  /** Reusable scratch objects to prevent per-frame garbage collection pressure. */
  private readonly tmpSpherical = new THREE.Spherical();
  private readonly tmpNdc = new THREE.Vector2();
  private readonly tmpVec = new THREE.Vector3();

  private activeFloor?: CachedFloorScene;
  private activeKioskId = 'WAYFINDING_KIOSK_L12_1';
  private hovered: string | null = null;
  private selected: string | null = null;
  private endpoints = new Set<string>();
  private wallScale = 1;
  private wallScaleTarget = CUTAWAY_WALL_HEIGHT / MODEL_WALL_HEIGHT;
  private cutawayEnabled = true;
  private camAnim: CameraAnimation | null = null;
  private viewMode: ViewMode = '3d';
  private insets = { left: 0, bottom: 0 };
  private size = { w: 1, h: 1 };
  private homeView?: { target: THREE.Vector3; spherical: THREE.Spherical };
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private hoverPending: PointerEvent | null = null;
  private raf = 0;
  private elapsed = 0;
  private lastActivityAt = performance.now();
  private lastRenderAt = 0;
  private isTabHidden = typeof document !== 'undefined' ? document.hidden : false;
  private disposed = false;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.classList.add('map-canvas');
    host.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.classList.add('map-labels');
    host.appendChild(this.labelRenderer.domElement);

    this.scene.background = new THREE.Color('#e8edf3');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    envScene.dispose();
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b9c2cf', 1.0));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.routeVisual.group);

    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 85;
    this.controls.maxPolarAngle = 1.2;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', () => {
      this.camAnim = null;
      this.markActivity();
      this.onInteraction?.();
    });
    this.controls.addEventListener('change', () => {
      this.markActivity();
      this.clampTarget();
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.handlePointerDown);
    el.addEventListener('pointerup', this.handlePointerUp);
    el.addEventListener('pointermove', this.handlePointerMove);
    el.addEventListener('pointerleave', this.handlePointerLeave);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    this.resizeObserver = new ResizeObserver(() => {
      this.markActivity();
      this.resize();
    });
    this.resizeObserver.observe(host);
    this.resize();
    this.timer.connect(document);
    if (!this.isTabHidden) {
      this.loop();
    }
  }

  // ================================================================ loading & caching

  /**Checks if a floor is already parsed and cached in memory. */
  isFloorInMemory(floorId: string): boolean {
    return this.floorCache.has(floorId);
  }

  /**
   * Loads a floor plan (or retrieves it from the in-memory / persistent CacheStorage cache)
   * and activates it in the 3D viewport.
   */
  async loadFloor(
    floorId: string,
    url: string,
    activeKioskId: string,
    onProgress?: (fraction: number) => void,
    site = 'Default Site',
  ): Promise<LoadResult> {
    this.activeKioskId = activeKioskId;
    const wasInMemory = this.floorCache.has(floorId);
    const cached = await this.ensureFloorLoaded(floorId, url, onProgress, site);
    this.activateFloorScene(cached);
    return {
      floorId,
      resources: cached.resources,
      wayfinder: cached.wayfinder,
      fromCache: wasInMemory,
    };
  }

  /**
   * Loads an uploaded/local GLB `ArrayBuffer` directly into the 3D viewport (used by the
   * in-browser GLB Upload & Analyzer tool for instant client onboarding previews).
   */
  async loadFloorFromBuffer(
    floorId: string,
    buffer: ArrayBuffer,
    activeKioskId: string,
    site = 'Preview',
  ): Promise<LoadResult> {
    this.activeKioskId = activeKioskId;
    this.floorCache.delete(floorId);
    this.floorNavCache.delete(floorId);
    const built = await this.parseAndBuildFromBuffer(floorId, 'uploaded://preview.glb', buffer, false, site);
    this.floorCache.set(floorId, built);
    this.activateFloorScene(built);
    return {
      floorId,
      resources: built.resources,
      wayfinder: built.wayfinder,
      fromCache: false,
    };
  }

  /**
   * Preloads a floor plan's disk cache + lightweight navigation data (`resources` & `Wayfinder`)
   * in the background, then immediately disposes the temporary 3D meshes so inactive floors
   * consume zero GPU VRAM while multi-floor search & wayfinding remain instant.
   */
  async preloadFloor(
    floorId: string,
    url: string,
    onProgress?: (fraction: number) => void,
    site = 'Default Site',
  ): Promise<LoadResult> {
    const existingScene = this.floorCache.get(floorId);
    if (existingScene) {
      onProgress?.(1);
      return {
        floorId,
        resources: existingScene.resources,
        wayfinder: existingScene.wayfinder,
        fromCache: true,
      };
    }

    const existingNav = this.floorNavCache.get(floorId);
    if (existingNav) {
      onProgress?.(1);
      return {
        floorId,
        resources: existingNav.resources,
        wayfinder: existingNav.wayfinder,
        fromCache: true,
      };
    }

    let promise = this.inFlightPreloads.get(floorId);
    if (!promise) {
      promise = this.extractNavDataAndDispose(floorId, url, onProgress, site);
      this.inFlightPreloads.set(floorId, promise);
    }

    try {
      const nav = await promise;
      this.floorNavCache.set(floorId, nav);
      return {
        floorId,
        resources: nav.resources,
        wayfinder: nav.wayfinder,
        fromCache: false,
      };
    } finally {
      this.inFlightPreloads.delete(floorId);
    }
  }

  /**
   * Parses a background floor GLB (populating persistent CacheStorage), extracts its
   * resources & NavGrid/Wayfinder, and immediately disposes all Three.js geometries/materials/textures.
   */
  private async extractNavDataAndDispose(
    floorId: string,
    url: string,
    onProgress?: (fraction: number) => void,
    site = 'Default Site',
  ): Promise<CachedFloorNavData> {
    const built = await this.parseAndBuildFloor(floorId, url, onProgress, true, site);
    const navData: CachedFloorNavData = {
      resources: built.resources,
      wayfinder: built.wayfinder,
    };
    disposeObjectTree(built.rootGroup);
    return navData;
  }

  private async ensureFloorLoaded(
    floorId: string,
    url: string,
    onProgress?: (fraction: number) => void,
    site = 'Default Site',
  ): Promise<CachedFloorScene> {
    const existing = this.floorCache.get(floorId);
    if (existing) {
      onProgress?.(1);
      return existing;
    }

    const inflight = this.inFlightLoads.get(floorId);
    if (inflight) return inflight;

    const promise = this.parseAndBuildFloor(floorId, url, onProgress, false, site);
    this.inFlightLoads.set(floorId, promise);
    try {
      const built = await promise;
      this.floorCache.set(floorId, built);
      return built;
    } finally {
      this.inFlightLoads.delete(floorId);
    }
  }

  private async parseAndBuildFloor(
    floorId: string,
    url: string,
    onProgress?: (fraction: number) => void,
    navOnly = false,
    site = 'Default Site',
  ): Promise<CachedFloorScene> {
    const arrayBuffer = await fetchCachedGlbBuffer(url, onProgress);
    return this.parseAndBuildFromBuffer(floorId, url, arrayBuffer, navOnly, site);
  }

  private async parseAndBuildFromBuffer(
    floorId: string,
    url: string,
    arrayBuffer: ArrayBuffer,
    navOnly = false,
    site = 'Default Site',
  ): Promise<CachedFloorScene> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(arrayBuffer, '');
    const model = gltf.scene;
    model.updateMatrixWorld(true);

    const group = (name: string, prefix: string): THREE.Object3D[] => {
      const g = model.getObjectByName(name);
      if (g) return g.children.slice();
      const found: THREE.Object3D[] = [];
      model.traverse((o) => o.name.startsWith(prefix) && found.push(o));
      return found;
    };

    const floors = group('floors', NODE_PREFIX.floor);
    const walls = group('walls', NODE_PREFIX.wall);
    const ceilings = group('ceilings', NODE_PREFIX.ceiling);
    const doors = group('doors', NODE_PREFIX.door);
    const furniture = group('furniture', NODE_PREFIX.furniture);

    // Dispose and detach hidden ceiling meshes immediately so they don't occupy GPU/CPU memory
    for (const c of ceilings) {
      c.removeFromParent();
      disposeObjectTree(c);
    }

    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    for (const f of floors) f.traverse((o) => (o.castShadow = false));

    // ---- classify ---------------------------------------------------------
    const resources: KioskResource[] = [];
    const objects = new Map<string, THREE.Object3D>();
    const obstacles: Footprint[] = [];
    const lifts: THREE.Object3D[] = [];
    const sealedDoors: THREE.Object3D[] = [];
    const hanging: THREE.Object3D[] = [];
    const box = new THREE.Box3();

    const register = (obj: THREE.Object3D, kindHint?: ResourceKind): KioskResource | null => {
      const m = matchResource(obj.name, obj.userData);
      if (!m || (kindHint && m.rule.kind !== kindHint)) return null;
      box.setFromObject(obj);
      const kind = m.rule.kind;
      const lvl = m.rule.level(m.match);
      const id = m.rule.id(m.match);
      const r: KioskResource = {
        id,
        kind,
        name: formatResourcePropertyName(id) || m.rule.name(m.match),
        code: m.rule.code(m.match),
        level: lvl,
        site,
        floor: `Level ${lvl}`,
        resourceType:
          m.rule.defaultSubType ??
          (kind === 'meeting-room'
            ? 'Meeting Room'
            : kind === 'desk'
              ? 'Desk'
              : kind === 'lift'
                ? 'Lift'
                : 'Kiosk'),
        capacity:
          m.rule.defaultCapacity ?? (kind === 'meeting-room' ? 6 : kind === 'desk' ? 1 : 0),
        equipment: m.rule.defaultEquipment ? [...m.rule.defaultEquipment] : [],
        bookable: m.rule.bookable,
        center: { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 },
        bounds: { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z },
        anchor: null,
      };
      resources.push(r);
      objects.set(r.id, obj);
      return r;
    };

    // Register doors first for lifts and door-anchored amenities (e.g. door_Toilet_Male_L13, door_NursingRoom_L13)
    const registeredAmenityTypes = new Set<ResourceSubType>();
    for (const d of doors) {
      if (register(d, 'lift')) {
        lifts.push(d);
      } else {
        const am = register(d, 'amenity');
        if (am) {
          registeredAmenityTypes.add(am.resourceType);
          // Seal toilet/nursing room doors in NavGrid so routes walk TO the door, never THROUGH it
          if (/(?:toilet|nursing|restroom|washroom)/i.test(d.name)) {
            sealedDoors.push(d);
          }
        }
      }
    }
    for (const f of floors) {
      if (!register(f, 'meeting-room')) {
        const m = matchResource(f.name, f.userData);
        if (m?.rule.kind === 'amenity' && m.rule.defaultSubType && !registeredAmenityTypes.has(m.rule.defaultSubType)) {
          const am = register(f, 'amenity');
          if (am) registeredAmenityTypes.add(am.resourceType);
        }
      }
    }
    // Collect closed-room footprints so indoor furniture groups (conference tables & chairs
    // inside a Meeting/Private/Focus/Quiet room) don't block the room's own doorway/interior.
    const roomBounds = resources
      .filter((r) => r.kind === 'meeting-room')
      .map((r) => r.bounds);

    const isInsideRoom = (cx: number, cz: number): boolean =>
      roomBounds.some((b) => cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ);

    for (const f of furniture) {
      const r = matchResource(f.name);
      if (r?.rule.kind === 'desk' || r?.rule.kind === 'kiosk' || r?.rule.bookable) {
        const res = register(f);
        if (res?.kind === 'kiosk') continue; // kiosks never block navigation
      }
      box.setFromObject(f);
      if (box.isEmpty()) continue;
      if (box.min.y > 1.2) {
        hanging.push(f);
        continue;
      }
      if (box.min.y > 0.3) continue;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      if (isInsideRoom(cx, cz)) continue;
      obstacles.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
    }

    // ---- navigation -------------------------------------------------------
    const cachedNav = this.floorNavCache.get(floorId);
    let wayfinder: Wayfinder;
    if (cachedNav) {
      wayfinder = cachedNav.wayfinder;
      // Restore previously snapped anchors onto freshly parsed resources
      const anchorById = new Map(cachedNav.resources.map((r) => [r.id, r.anchor]));
      for (const r of resources) {
        r.anchor = anchorById.get(r.id) ?? null;
      }
    } else {
      // Block restroom & nursing room interiors using exact triangle rasterisation (`blockedFloors`)
      // plus sealing their doors in `walls` — prevents routes from cutting through gendered toilets
      // while avoiding rectangular AABB bleed into adjacent foyers/rooms (e.g. L14 Quiet Room).
      const isNoPassThrough = (name: string) => /(?:toilet|nursing|restroom|washroom)/i.test(name);
      const walkableFloors: THREE.Object3D[] = [];
      const blockedFloorNodes: THREE.Object3D[] = [];
      for (const f of floors) {
        if (isNoPassThrough(f.name)) {
          blockedFloorNodes.push(f);
        } else {
          walkableFloors.push(f);
        }
      }
      const grid = NavGrid.build({
        floors: [trianglesOf(walkableFloors)],
        walls: [trianglesOf(walls), trianglesOf(lifts), trianglesOf(sealedDoors)],
        blockedFloors: [trianglesOf(blockedFloorNodes)],
        obstacles,
      });
      const firstKiosk = resources.find((r) => r.kind === 'kiosk')?.id;
      wayfinder = new Wayfinder(grid, resources, firstKiosk);
      this.floorNavCache.set(floorId, { resources, wayfinder });
    }

    // ---- build floor root group -------------------------------------------
    const rootGroup = new THREE.Group();
    rootGroup.name = `floor-scene:${floorId}`;
    rootGroup.add(model);

    const floorBounds = new THREE.Box3().setFromObject(model);
    if (navOnly) {
      return {
        floorId,
        url,
        rootGroup,
        bounds: floorBounds,
        structural: [],
        hanging: [],
        visuals: new Map(),
        kioskBeacons: new Map(),
        pickables: [],
        resources,
        wayfinder,
      };
    }
    const structural = [model.getObjectByName('walls'), model.getObjectByName('doors')].filter(
      (o): o is THREE.Object3D => !!o,
    );

    const size = floorBounds.getSize(new THREE.Vector3());
    const center = floorBounds.getCenter(new THREE.Vector3());
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size.x + 200, size.z + 200),
      new THREE.MeshStandardMaterial({ color: '#dde3ea', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, -0.02, center.z);
    ground.receiveShadow = true;
    rootGroup.add(ground);

    const visuals = new Map<string, ResourceVisual>();
    const kioskBeacons = new Map<string, KioskBeacon>();
    const pickables: THREE.Object3D[] = [];

    for (const r of resources) {
      const obj = objects.get(r.id)!;
      if (r.kind === 'kiosk') {
        const beacon = this.buildKioskBeacon(r);
        rootGroup.add(beacon.group);
        kioskBeacons.set(r.id, beacon);
        continue;
      }
      const vis = this.buildResourceVisual(r, obj, rootGroup, pickables);
      visuals.set(r.id, vis);
    }

    return {
      floorId,
      url,
      rootGroup,
      bounds: floorBounds,
      structural,
      hanging,
      visuals,
      kioskBeacons,
      pickables,
      resources,
      wayfinder,
    };
  }

  private activateFloorScene(target: CachedFloorScene): void {
    const prev = this.activeFloor;
    if (prev && prev !== target) {
      this.toggleCss2DLabels(prev.rootGroup, false);
      this.scene.remove(prev.rootGroup);
      // Evict and dispose inactive floor's 3D geometries/materials/textures so only
      // 1 floor's GPU/CPU meshes reside in memory at a time (NavGrid stays in floorNavCache).
      this.floorCache.delete(prev.floorId);
      disposeObjectTree(prev.rootGroup);
    }

    this.activeFloor = target;
    if (!this.scene.children.includes(target.rootGroup)) {
      this.scene.add(target.rootGroup);
    }
    this.toggleCss2DLabels(target.rootGroup, true);

    this.bounds.copy(target.bounds);
    this.configureSun();
    this.updateKioskBeaconLabels();
    this.setCutaway(this.cutawayEnabled);
    this.applyWallScale(this.wallScaleTarget);
    this.wallScale = this.wallScaleTarget;
    this.computeHomeView();
    this.goHome(false);
    this.renderer.shadowMap.needsUpdate = true;
    this.markActivity();
  }

  private toggleCss2DLabels(root: THREE.Object3D, visible: boolean): void {
    root.traverse((o) => {
      if (o instanceof CSS2DObject) {
        o.visible = visible;
        o.element.style.display = visible ? '' : 'none';
      }
    });
  }

  /** Sets which kiosk ID represents the physical device's "You are here" marker. */
  setActiveKioskId(kioskResourceId: string): void {
    this.activeKioskId = kioskResourceId;
    this.updateKioskBeaconLabels();
  }

  private updateKioskBeaconLabels(): void {
    for (const floor of this.floorCache.values()) {
      for (const [id, beacon] of floor.kioskBeacons.entries()) {
        const isHere = id === this.activeKioskId;
        const textSpan = beacon.labelEl.querySelector('.map-label__text') as HTMLElement | null;
        if (textSpan) {
          textSpan.textContent = isHere ? `You are here (${beacon.resource.code})` : beacon.resource.code;
        }
        beacon.labelEl.classList.toggle('map-label--here', isHere);
        beacon.group.scale.setScalar(isHere ? 1.0 : 0.78);
      }
    }
  }

  private configureSun(): void {
    const c = this.bounds.getCenter(new THREE.Vector3());
    const s = this.bounds.getSize(new THREE.Vector3());
    this.sun.position.set(c.x - s.x * 0.3, 35, c.z + s.z * 0.5);
    this.sun.target.position.copy(c);
    const r = Math.max(s.x, s.z) * 0.75;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 110;
    cam.updateProjectionMatrix();
  }

  private buildResourceVisual(
    r: KioskResource,
    obj: THREE.Object3D,
    parentGroup: THREE.Group,
    pickables: THREE.Object3D[],
  ): ResourceVisual {
    const defaultStatus: AvailabilityStatus | null = r.bookable ? 'available' : null;
    const hex = defaultStatus
      ? STATUS_COLORS[defaultStatus]
      : (AMENITY_COLORS[r.resourceType] ?? KIND_COLORS[r.kind]);
    const color = new THREE.Color(hex);
    const plateMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: r.kind === 'meeting-room' ? 0.42 : r.kind === 'amenity' ? 0.28 : 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const container = new THREE.Group();
    container.name = `resource:${r.id}`;
    let outlineGeometry: THREE.BufferGeometry;

    if (r.kind === 'meeting-room') {
      const outlines: THREE.BufferGeometry[] = [];
      // Neutral light-beige base material for synthesized room floors without UVs so the
      // semi-transparent status plate blends to the exact same shade as Level 12 rooms.
      const neutralRoomFloorMat = new THREE.MeshStandardMaterial({
        color: '#e5e2dc',
        roughness: 0.85,
        metalness: 0.0,
      });
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!mesh.geometry.getAttribute('uv')) {
          mesh.material = neutralRoomFloorMat;
        }
        const plate = new THREE.Mesh(mesh.geometry, plateMaterial);
        plate.matrixAutoUpdate = false;
        plate.matrix.copy(mesh.matrixWorld).premultiply(new THREE.Matrix4().makeTranslation(0, PLATE_LIFT, 0));
        plate.matrixWorldNeedsUpdate = true;
        plate.userData['resourceId'] = r.id;
        plate.renderOrder = 2;
        container.add(plate);
        pickables.push(plate);
        outlines.push(new THREE.EdgesGeometry(worldGeometry(mesh.geometry, plate.matrix), 1));
      });
      outlineGeometry = outlines[0] ?? new THREE.BufferGeometry();

      // Add an invisible 0.85m-tall room volume proxy so clicking the table or chairs
      // inside a meeting/private/focus room also selects the room cleanly.
      const b = r.bounds;
      const roomProxy = new THREE.Mesh(
        new THREE.BoxGeometry(
          Math.max(0.5, b.maxX - b.minX - 0.12),
          0.85,
          Math.max(0.5, b.maxZ - b.minZ - 0.12),
        ),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      roomProxy.position.set(r.center.x, 0.425, r.center.z);
      roomProxy.userData['resourceId'] = r.id;
      roomProxy.userData['isRoomVolume'] = true;
      container.add(roomProxy);
      pickables.push(roomProxy);
    } else {
      const b = r.bounds;
      const pad = r.kind === 'amenity' ? 0.02 : 0.18;
      const shape = roundedRect(b.minX - pad, b.minZ - pad, b.maxX + pad, b.maxZ + pad, 0.2);
      const geom = new THREE.ShapeGeometry(shape, 6);
      geom.rotateX(Math.PI / 2);
      geom.translate(0, PLATE_LIFT, 0);
      const plate = new THREE.Mesh(geom, plateMaterial);
      plate.renderOrder = 2;
      container.add(plate);
      outlineGeometry = new THREE.EdgesGeometry(geom, 1);

      // Add a 3D vertical signpost stem & base disc for amenity facilities
      if (r.kind === 'amenity') {
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035, 0.035, 1.35, 10),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 }),
        );
        stem.position.set(r.center.x, 0.675, r.center.z);
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(0.32, 24),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false }),
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(r.center.x, PLATE_LIFT + 0.005, r.center.z);
        container.add(stem, disc);
      }

      const height = r.kind === 'lift' ? 2.2 : r.kind === 'amenity' ? 1.4 : 1.0;
      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(b.maxX - b.minX + 0.3, height, b.maxZ - b.minZ + 0.3),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      proxy.position.set(r.center.x, height / 2, r.center.z);
      proxy.userData['resourceId'] = r.id;
      container.add(proxy);
      pickables.push(proxy);
    }

    const outline = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    outline.renderOrder = 3;
    container.add(outline);

    const emissive: THREE.MeshStandardMaterial[] = [];
    if (r.kind !== 'meeting-room' && r.kind !== 'amenity') {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const cloned = mats.map((m) => {
          const c = m.clone() as THREE.MeshStandardMaterial;
          if ('emissive' in c) emissive.push(c);
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      });
    }

    const label = this.makeLabel(r, color, defaultStatus);
    container.add(label);
    parentGroup.add(container);
    return {
      resource: r,
      object: obj,
      plateMaterial,
      outline,
      emissive,
      label,
      color,
      status: defaultStatus,
      lastState: null,
    };
  }

  private makeLabel(r: KioskResource, color: THREE.Color, status: AvailabilityStatus | null): CSS2DObject {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `map-label kind-${r.kind}` + (status ? ` status-${status}` : '');
    el.style.setProperty('--kind-color', color.getStyle());
    const iconSvg = this.amenityIconSvg(r.resourceType);
    if (iconSvg) {
      el.classList.add('map-label--amenity');
      el.innerHTML = `<span class="map-label__svg">${iconSvg}</span><span class="map-label__text"></span>`;
    } else {
      el.innerHTML = `<span class="map-label__icon"></span><span class="map-label__text"></span>`;
    }
    (el.querySelector('.map-label__text') as HTMLElement).textContent =
      r.kind === 'meeting-room' ? r.name : r.code;
    el.setAttribute('aria-label', r.name);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onInteraction?.();
      this.onPick?.(r.id);
    });
    const label = new CSS2DObject(el);
    const y = r.kind === 'meeting-room' ? 1.0 : r.kind === 'lift' ? 1.6 : r.kind === 'amenity' ? 1.45 : 1.0;
    label.position.set(r.center.x, y, r.center.z);
    label.center.set(0.5, 1);
    return label;
  }

  /** Returns an ISO restroom / accessibility / nursing room SVG pictogram for 3D map signage. */
  private amenityIconSvg(subType: ResourceSubType): string | null {
    switch (subType) {
      case 'Male Toilet':
        return `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-1.5 5h3a2 2 0 0 1 2 2v5.5h-1.5V22h-4v-7.5H8.5V9a2 2 0 0 1 2-2z"/></svg>`;
      case 'Female Toilet':
        return `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm1.8 5.2a1.8 1.8 0 0 0-3.6 0L7.5 15h2.5v7h4v-7h2.5l-2.7-7.8z"/></svg>`;
      case 'PWD Toilet':
        return `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm7 14.5v-2h-4.6l-1.3-3.5H17v-2h-4.5l-.4-1.2A2 2 0 0 0 10.2 8.5c-1.1 0-2 .9-2 2v5c0 1.1.9 2 2 2h4l1.4 3.5H19v-2.5zM10 20a4 4 0 0 1-1.5-7.7v2.2a2 2 0 1 0 2.8 2.5l.8 2A4 4 0 0 1 10 20z"/></svg>`;
      case 'Nursing Room':
        return `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
      default:
        return null;
    }
  }

  private buildKioskBeacon(r: KioskResource): KioskBeacon {
    const g = new THREE.Group();
    g.name = `kiosk-beacon:${r.id}`;
    const color = new THREE.Color(KIND_COLORS.kiosk);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    ring.name = 'pulse';
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.6, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }),
    );
    beam.position.y = 0.8;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 12), new THREE.MeshStandardMaterial({ color }));
    head.position.y = 1.7;
    head.name = 'head';
    g.add(disc, ring, beam, head);
    g.position.set(r.center.x, 0, r.center.z);

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'map-label map-label--here';
    el.innerHTML = `<span class="map-label__icon"></span><span class="map-label__text">You are here (${r.code})</span>`;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onInteraction?.();
      this.onPick?.(r.id);
    });
    const label = new CSS2DObject(el);
    label.position.set(0, 2.0, 0);
    label.center.set(0.5, 1);
    g.add(label);
    return { resource: r, group: g, labelEl: el, pulseRing: ring, headMesh: head };
  }

  // ============================================================ public API

  /** Syncs catalog names/codes and availability status colors across all cached floor scenes. */
  syncResources(resources: KioskResource[], statusMap: Record<string, AvailabilityStatus>): void {
    for (const floor of this.floorCache.values()) {
      for (const r of resources) {
        const v = floor.visuals.get(r.id);
        if (!v) continue;
        v.resource = r;
        const textEl = v.label.element.querySelector('.map-label__text') as HTMLElement | null;
        if (textEl) {
          textEl.textContent = r.kind === 'meeting-room' ? r.name : r.code;
        }
        v.label.element.setAttribute('aria-label', r.name);

        if (r.bookable) {
          const status: AvailabilityStatus = statusMap[r.id] ?? 'available';
          v.status = status;
          const hex = STATUS_COLORS[status];
          v.color.set(hex);
          v.plateMaterial.color.set(hex);
          v.outline.material.color.set(hex);
          v.label.element.style.setProperty('--kind-color', hex);
          v.label.element.classList.remove('status-available', 'status-reserved', 'status-occupied');
          v.label.element.classList.add(`status-${status}`);
        }
      }
    }
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.markActivity();
  }

  showRoute(route: Route | null): void {
    this.endpoints.clear();
    if (!route) {
      this.routeVisual.clear();
      return;
    }

    // Determine which segment of the route belongs to the currently active floor
    const activeFloorId = this.activeFloor?.floorId;
    const seg =
      route.segments?.find((s) => s.floor === activeFloorId) ??
      route.segments?.[0];

    this.endpoints.add(route.from.id).add(route.to.id);
    if (seg) {
      this.endpoints.add(seg.from.id).add(seg.to.id);
    }

    const pts = seg ? seg.smooth : route.smooth;
    const destCenter = seg ? seg.to.center : route.to.center;
    if (!pts || pts.length < 2) {
      this.routeVisual.clear();
      return;
    }

    this.routeVisual.show(pts, destCenter);

    const b = new THREE.Box3();
    for (const p of pts) b.expandByPoint(new THREE.Vector3(p.x, 0, p.z));
    b.expandByPoint(new THREE.Vector3(destCenter.x, 0, destCenter.z));
    b.expandByScalar(1.8);
    this.fitBox(b);
  }

  focusResource(id: string): void {
    const floor = this.activeFloor;
    if (!floor) return;
    const v = floor.visuals.get(id);
    const k = floor.kioskBeacons.get(id);
    const res = v?.resource ?? k?.resource;
    if (!res) return;
    const c = res.center;
    const target = new THREE.Vector3(c.x, 0, c.z);
    const s = this.currentSpherical();
    s.radius = Math.min(s.radius, res.kind === 'meeting-room' ? 16 : 13);
    this.animateCamera(target, s);
  }

  goHome(animate = true): void {
    if (!this.homeView) return;
    const s = this.homeView.spherical.clone();
    if (this.viewMode === '2d') s.phi = 0.0001;
    this.animateCamera(this.homeView.target.clone(), s, animate ? 1.2 : 0);
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    const s = this.currentSpherical();
    if (mode === '2d') {
      s.phi = 0.0001;
      this.controls.enableRotate = false;
    } else {
      s.phi = this.homeView?.spherical.phi ?? 0.8;
      this.controls.enableRotate = true;
    }
    this.animateCamera(this.controls.target.clone(), s, 0.9);
  }

  /** Lowers walls (dollhouse) or restores their full height. */
  setCutaway(enabled: boolean): void {
    this.cutawayEnabled = enabled;
    this.wallScaleTarget = enabled ? CUTAWAY_WALL_HEIGHT / MODEL_WALL_HEIGHT : 1;
    if (this.activeFloor) {
      for (const h of this.activeFloor.hanging) h.visible = !enabled;
    }
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled && this.viewMode === '3d';
    this.controls.autoRotateSpeed = 0.35;
  }

  /** Screen space (px) covered by UI panels, so the map centres in the free area. */
  setInsets(left: number, bottom: number): void {
    this.insets = { left, bottom };
    this.resize();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.handlePointerDown);
    el.removeEventListener('pointerup', this.handlePointerUp);
    el.removeEventListener('pointermove', this.handlePointerMove);
    el.removeEventListener('pointerleave', this.handlePointerLeave);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.timer.dispose();
    for (const floor of this.floorCache.values()) {
      this.scene.remove(floor.rootGroup);
      disposeObjectTree(floor.rootGroup);
    }
    this.floorCache.clear();
    this.floorNavCache.clear();
    this.routeVisual.clear();
    if (this.scene.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }

  private markActivity(): void {
    this.lastActivityAt = performance.now();
  }

  private handleVisibilityChange = () => {
    this.isTabHidden = document.hidden;
    if (this.isTabHidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.disposed && !this.raf) {
      this.markActivity();
      this.timer.reset();
      this.loop();
    }
  };

  private handlePointerLeave = () => {
    this.setHovered(null);
  };

  // ============================================================== picking

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.onInteraction?.();
  };

  private handlePointerUp = (e: PointerEvent) => {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > 8 || performance.now() - d.t > 700) return;
    this.onPick?.(this.pick(e));
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || this.pointerDown) return;
    this.hoverPending = e;
  };

  private pick(e: PointerEvent): string | null {
    const floor = this.activeFloor;
    if (!floor) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.tmpNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.tmpNdc, this.camera);
    const hits = this.raycaster.intersectObjects(floor.pickables, false);
    if (!hits.length) return null;
    // Prefer specific desk/lift pick volumes over room volumes/floor plates
    const deskOrLift = hits.find(
      (h) => (h.object as THREE.Mesh).geometry.type === 'BoxGeometry' && !h.object.userData['isRoomVolume'],
    );
    return ((deskOrLift ?? hits[0]).object.userData['resourceId'] as string) ?? null;
  }

  private setHovered(id: string | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.markActivity();
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
  }

  // ======================================================== camera helpers

  private currentSpherical(): THREE.Spherical {
    const offset = this.camera.position.clone().sub(this.controls.target);
    return new THREE.Spherical().setFromVector3(offset);
  }

  private computeHomeView(): void {
    const target = this.bounds.getCenter(new THREE.Vector3()).setY(0);
    const spherical = new THREE.Spherical(1, 0.78, 0);
    spherical.radius = this.radiusToFit(this.bounds, spherical) * 0.92;
    this.homeView = { target, spherical };
  }

  private fitBox(box: THREE.Box3): void {
    const s = this.currentSpherical();
    if (this.viewMode === '3d') s.phi = Math.min(s.phi, 0.75);
    s.radius = THREE.MathUtils.clamp(this.radiusToFit(box, s), this.controls.minDistance + 2, this.controls.maxDistance);
    this.animateCamera(box.getCenter(new THREE.Vector3()).setY(0), s, 1.2);
  }

  private radiusToFit(box: THREE.Box3, s: THREE.Spherical): number {
    const size = box.getSize(new THREE.Vector3());
    const freeW = Math.max(1, this.size.w - this.insets.left);
    const freeH = Math.max(1, this.size.h - this.insets.bottom);
    const aspect = freeW / freeH;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov) * (freeH / (this.size.h + this.insets.bottom));
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
    const cos = Math.abs(Math.cos(s.theta));
    const sin = Math.abs(Math.sin(s.theta));
    const width = size.x * cos + size.z * sin;
    const depth = (size.x * sin + size.z * cos) * Math.cos(s.phi) + 1.5 * Math.sin(s.phi);
    return Math.max((width / 2) / Math.tan(fovH / 2), (depth / 2) / Math.tan(fovV / 2)) * 1.08;
  }

  private animateCamera(target: THREE.Vector3, to: THREE.Spherical, duration = 1.0): void {
    const from = this.currentSpherical();
    let dTheta = to.theta - from.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const end = to.clone();
    end.theta = from.theta + dTheta;
    end.makeSafe();
    if (duration <= 0) {
      this.controls.target.copy(target);
      this.camera.position.setFromSpherical(end).add(target);
      this.camera.lookAt(target);
      this.camAnim = null;
      return;
    }
    this.camAnim = { fromTarget: this.controls.target.clone(), toTarget: target, from, to: end, t: 0, duration };
  }

  private clampTarget(): void {
    if (this.bounds.isEmpty()) return;
    const t = this.controls.target;
    const before = t.clone();
    t.x = THREE.MathUtils.clamp(t.x, this.bounds.min.x - 2, this.bounds.max.x + 2);
    t.z = THREE.MathUtils.clamp(t.z, this.bounds.min.z - 2, this.bounds.max.z + 2);
    t.y = 0;
    if (!before.equals(t)) this.camera.position.add(t.clone().sub(before));
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    const { left, bottom } = this.insets;
    this.camera.aspect = (w + left) / (h + bottom);
    this.camera.setViewOffset(w + left, h + bottom, 0, bottom, w, h);
    this.camera.updateProjectionMatrix();
  }

  // ============================================================ animation

  private applyWallScale(s: number): void {
    if (!this.activeFloor) return;
    for (const o of this.activeFloor.structural) o.scale.y = s;
  }

  private loop = () => {
    if (this.disposed || this.isTabHidden) {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.loop);

    const now = performance.now();
    const isAnimating =
      !!this.camAnim ||
      Math.abs(this.wallScale - this.wallScaleTarget) > 1e-4 ||
      !!this.hoverPending ||
      this.controls.autoRotate ||
      this.routeVisual.group.visible ||
      this.selected !== null ||
      now - this.lastActivityAt < 3000;

    // When idle, throttle rendering to ~12 FPS to cut GPU/CPU & GC memory pressure by ~80%
    if (!isAnimating && now - this.lastRenderAt < 80) {
      return;
    }
    this.lastRenderAt = now;

    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.elapsed += dt;

    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + dt / a.duration);
      const k = easeInOutCubic(a.t);
      this.controls.target.lerpVectors(a.fromTarget, a.toTarget, k);
      this.tmpSpherical.set(
        THREE.MathUtils.lerp(a.from.radius, a.to.radius, k),
        THREE.MathUtils.lerp(a.from.phi, a.to.phi, k),
        THREE.MathUtils.lerp(a.from.theta, a.to.theta, k),
      );
      this.camera.position.setFromSpherical(this.tmpSpherical).add(this.controls.target);
      if (a.t >= 1) this.camAnim = null;
    }

    if (Math.abs(this.wallScale - this.wallScaleTarget) > 1e-4) {
      this.wallScale += (this.wallScaleTarget - this.wallScale) * Math.min(1, dt * 6);
      if (Math.abs(this.wallScale - this.wallScaleTarget) < 1e-3) this.wallScale = this.wallScaleTarget;
      this.applyWallScale(this.wallScale);
      this.renderer.shadowMap.needsUpdate = true;
    }

    if (this.hoverPending) {
      this.setHovered(this.pick(this.hoverPending));
      this.hoverPending = null;
    }

    this.controls.update(dt);
    this.routeVisual.update(dt);
    this.updateHighlights();
    this.updateKioskBeacons();

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  private updateHighlights(): void {
    const floor = this.activeFloor;
    if (!floor) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 4);
    for (const [id, v] of floor.visuals) {
      const state: VisualState =
        id === this.selected ? 'selected'
          : this.endpoints.has(id) ? 'endpoint'
            : id === this.hovered ? 'hover'
              : 'idle';

      let target: number;
      let glow: number;
      if (state === 'selected') {
        target = 0.58 + 0.18 * pulse;
        glow = 0.35 + 0.28 * pulse;
      } else if (state === 'endpoint') {
        target = 0.66;
        glow = 0.4;
      } else if (state === 'hover') {
        target = v.resource.kind === 'meeting-room' ? 0.62 : 0.52;
        glow = 0.32;
      } else {
        target = v.resource.kind === 'meeting-room' ? 0.44 : v.resource.bookable ? 0.36 : 0.22;
        glow = v.resource.bookable ? 0.14 : 0;
      }

      if (Math.abs(target - v.plateMaterial.opacity) > 0.001) {
        v.plateMaterial.opacity += (target - v.plateMaterial.opacity) * 0.2;
      }
      const outlineOp = state === 'idle' ? 0.35 : state === 'hover' ? 0.75 : 1.0;
      if (v.outline.material.opacity !== outlineOp) {
        v.outline.material.opacity = outlineOp;
      }
      for (const m of v.emissive) {
        if (m.emissiveIntensity !== glow || state !== v.lastState) {
          m.emissive.copy(v.color);
          m.emissiveIntensity = glow;
        }
      }
      if (state !== v.lastState) {
        v.lastState = state;
        const el = v.label.element;
        el.classList.toggle('is-selected', state === 'selected');
        el.classList.toggle('is-endpoint', state === 'endpoint');
        el.classList.toggle('is-hover', state === 'hover');
      }
    }
  }

  private updateKioskBeacons(): void {
    const floor = this.activeFloor;
    if (!floor) return;
    const p = (this.elapsed % 2) / 2;
    const scale = 0.8 + p * 1.4;
    const opacity = 1 - p;
    const headY = 1.7 + Math.sin(this.elapsed * 2.5) * 0.05;
    for (const beacon of floor.kioskBeacons.values()) {
      beacon.pulseRing.scale.setScalar(scale);
      beacon.pulseRing.material.opacity = opacity;
      beacon.headMesh.position.y = headY;
    }
  }
}

/** Recursively disposes Three.js geometries, materials, textures, and CSS2D DOM elements. */
function disposeObjectTree(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();

  root.traverse((obj) => {
    if (obj instanceof CSS2DObject) {
      obj.element.remove();
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      geometries.add(mesh.geometry);
    }
    const mat = mesh.material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        materials.add(m);
        for (const val of Object.values(m as unknown as Record<string, unknown>)) {
          if (val && typeof val === 'object' && (val as THREE.Texture).isTexture) {
            textures.add(val as THREE.Texture);
          }
        }
      }
    }
  });

  for (const t of textures) t.dispose();
  for (const m of materials) m.dispose();
  for (const g of geometries) g.dispose();
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Copy of a geometry's positions transformed to world space as plain floats
 * (the optimised GLB uses quantised, normalised attributes).
 */
function worldGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const pos = source.getAttribute('position') as THREE.BufferAttribute;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (source.index) g.setIndex(source.index.clone());
  return g;
}

/** Rounded rectangle in the XY plane (Y is later mapped onto world Z). */
function roundedRect(x0: number, z0: number, x1: number, z1: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  r = Math.min(r, (x1 - x0) / 2, (z1 - z0) / 2);
  s.moveTo(x0 + r, z0);
  s.lineTo(x1 - r, z0);
  s.quadraticCurveTo(x1, z0, x1, z0 + r);
  s.lineTo(x1, z1 - r);
  s.quadraticCurveTo(x1, z1, x1 - r, z1);
  s.lineTo(x0 + r, z1);
  s.quadraticCurveTo(x0, z1, x0, z1 - r);
  s.lineTo(x0, z0 + r);
  s.quadraticCurveTo(x0, z0, x0 + r, z0);
  return s;
}
