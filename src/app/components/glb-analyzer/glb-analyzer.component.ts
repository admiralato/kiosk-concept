import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { KioskStore } from '../../kiosk.store';
import {
  formatResourcePropertyName,
  matchResource,
} from '../../wayfinding/resource-config';

export interface AnalyzedNodeItem {
  id: string;
  name: string;
  code: string;
  level: string;
  kind: string;
  resourceType: string;
  bookable: boolean;
  nodeName: string;
}

export interface GlbAnalysisResult {
  fileName: string;
  fileSizeMb: string;
  detectedLevel: string;
  bookable: AnalyzedNodeItem[];
  lifts: AnalyzedNodeItem[];
  kiosks: AnalyzedNodeItem[];
  amenities: AnalyzedNodeItem[];
  ceilingOnlyRooms: string[];
  unmatchedNamed: string[];
  starterJson: string;
}

export interface GlbPreviewPayload {
  fileName: string;
  floorId: string;
  kioskId: string;
  buffer: ArrayBuffer;
}

/**
 * In-browser GLB Upload & Analyzer modal.
 *
 * Allows any client to drag-and-drop a `.glb` floor plan, inspect which nodes match
 * the configured `resourceTypes` in `kiosk-config.json` (bookable rooms, desks, phone booths,
 * lifts, kiosks, amenities, ceiling-only rooms, and unmatched nodes), copy starter JSON,
 * and preview the uploaded GLB directly inside the live 3D viewport.
 */
@Component({
  selector: 'app-glb-analyzer',
  standalone: true,
  templateUrl: './glb-analyzer.component.html',
  styleUrl: './glb-analyzer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlbAnalyzerComponent {
  readonly store = inject(KioskStore);

  readonly open = input<boolean>(false);
  readonly closed = output<void>();
  readonly previewGlb = output<GlbPreviewPayload>();
  readonly toast = output<string>();

  readonly dragging = signal(false);
  readonly analyzing = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<GlbAnalysisResult | null>(null);
  readonly activeSection = signal<'bookable' | 'infra' | 'warnings' | 'json'>('bookable');

  private lastBuffer: ArrayBuffer | null = null;

  readonly bookableSummary = computed(() => {
    const res = this.result();
    if (!res) return [];
    const counts = new Map<string, number>();
    for (const item of res.bookable) {
      counts.set(item.resourceType, (counts.get(item.resourceType) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
  });

  close(): void {
    this.dragging.set(false);
    this.closed.emit();
  }

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.analyzeFile(file);
  }

  onFileSelected(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.analyzeFile(file);
    input.value = '';
  }

  async analyzeFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.glb')) {
      this.error.set('Please select a valid .glb file.');
      return;
    }

    this.analyzing.set(true);
    this.error.set(null);
    this.result.set(null);

    try {
      const buffer = await file.arrayBuffer();
      this.lastBuffer = buffer;

      await MeshoptDecoder.ready;
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(buffer.slice(0), '');

      const bookable: AnalyzedNodeItem[] = [];
      const lifts: AnalyzedNodeItem[] = [];
      const kiosks: AnalyzedNodeItem[] = [];
      const amenities: AnalyzedNodeItem[] = [];
      const ceilingOnlyRooms: string[] = [];
      const unmatchedNamed: string[] = [];

      const seenIds = new Set<string>();
      const floorRoomSuffixes = new Set<string>();
      const ceilingNamed: string[] = [];

      gltf.scene.traverse((obj) => {
        const name = obj.name;
        if (!name) return;

        const floorMatch = name.match(/^floor_room-.+?_(.+)$/);
        if (floorMatch) floorRoomSuffixes.add(floorMatch[1]);

        const ceilingMatch = name.match(/^ceiling_room-.+?_(.+)$/);
        if (ceilingMatch && !/^Room_\d+$/i.test(ceilingMatch[1])) {
          ceilingNamed.push(ceilingMatch[1]);
        }

        const matched = matchResource(name, obj.userData);
        if (matched) {
          const id = matched.rule.id(matched.match);
          if (seenIds.has(id)) return;
          seenIds.add(id);

          const item: AnalyzedNodeItem = {
            id,
            name: formatResourcePropertyName(id) || matched.rule.name(matched.match),
            code: matched.rule.code(matched.match),
            level: matched.rule.level(matched.match),
            kind: matched.rule.kind,
            resourceType: matched.rule.defaultSubType ?? matched.rule.kind,
            bookable: matched.rule.bookable,
            nodeName: name,
          };

          if (item.bookable) bookable.push(item);
          else if (item.kind === 'lift') lifts.push(item);
          else if (item.kind === 'kiosk') kiosks.push(item);
          else amenities.push(item);
        } else if (
          (floorMatch && !/^Room_\d+$/i.test(floorMatch[1])) ||
          (/^door_/i.test(name) &&
            !/_frame_|_hinge_|_handle|_door_|_Circle_|_Plane_|_mirror_|^door_Door/i.test(name) &&
            !name.includes('_sweethome3d_'))
        ) {
          unmatchedNamed.push(name);
        }
      });

      for (const suffix of ceilingNamed) {
        if (!floorRoomSuffixes.has(suffix)) ceilingOnlyRooms.push(suffix);
      }

      const detectedLevel =
        bookable[0]?.level ?? kiosks[0]?.level ?? lifts[0]?.level ?? amenities[0]?.level ?? '1';

      const starterConfig = {
        floor: {
          id: `Level ${detectedLevel}`,
          level: detectedLevel,
          shortCode: `L${detectedLevel}`,
          modelUrl: `models/${file.name}`,
          site: this.store.siteFilter() || 'Main Building',
        },
        kioskDevices: kiosks.map((k, idx) => ({
          deviceId: `l${k.level}-${idx + 1}`,
          resourceId: k.id,
          label: `Kiosk L${k.level}-${idx + 1} (Level ${k.level})`,
          floorId: `Level ${k.level}`,
          level: k.level,
          aliases: [`l${k.level}-${idx + 1}`, k.id.toLowerCase()],
        })),
      };

      this.result.set({
        fileName: file.name,
        fileSizeMb: (file.size / (1024 * 1024)).toFixed(2),
        detectedLevel,
        bookable,
        lifts,
        kiosks,
        amenities,
        ceilingOnlyRooms,
        unmatchedNamed,
        starterJson: JSON.stringify(starterConfig, null, 2),
      });
      this.activeSection.set('bookable');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to parse GLB file.');
    } finally {
      this.analyzing.set(false);
    }
  }

  async copyStarterJson(): Promise<void> {
    const res = this.result();
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.starterJson);
      this.toast.emit('Copied starter kiosk-config.json snippet to clipboard.');
    } catch {
      this.toast.emit('Unable to copy automatically — select and copy from the JSON tab.');
    }
  }

  onPreviewInViewport(): void {
    const res = this.result();
    if (!res || !this.lastBuffer) return;
    this.previewGlb.emit({
      fileName: res.fileName,
      floorId: `Level ${res.detectedLevel}`,
      kioskId: res.kiosks[0]?.id ?? this.store.activeDevice().resourceId,
      buffer: this.lastBuffer.slice(0),
    });
    this.close();
  }
}
