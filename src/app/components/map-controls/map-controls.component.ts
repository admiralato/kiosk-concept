import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { KioskStore } from '../../kiosk.store';
import { STATUS_COLORS, type ViewMode } from '../../three/floorplan-engine';

/**
 * Bottom-right floating map controls bar: live availability legend, floor switcher,
 * 3D/2D camera toggle, dollhouse cutaway toggle, GLB analyzer launcher, and camera reset button.
 */
@Component({
  selector: 'app-map-controls',
  standalone: true,
  templateUrl: './map-controls.component.html',
  styleUrl: './map-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapControlsComponent {
  readonly store = inject(KioskStore);
  readonly statusColors = STATUS_COLORS;
  readonly openAnalyzer = output<void>();

  setViewMode(mode: ViewMode): void {
    this.store.viewMode.set(mode);
  }

  toggleCutaway(): void {
    this.store.cutaway.update((v) => !v);
  }
}
