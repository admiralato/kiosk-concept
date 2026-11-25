import { ChangeDetectionStrategy, Component, inject, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KioskStore } from '../../kiosk.store';
import {
  KIND_FILTERS,
  TIME_SLOTS,
  formatDistance,
  formatDuration,
  formatTime12h,
  resourceSwatchColor,
  statusColor,
  statusLabel,
  turnIconPath,
} from '../../shared/formatters';
import type { KioskResource, RouteStep } from '../../wayfinding/models';

export type SidebarTab = 'search' | 'wayfinding';

/**
 * Collapsible left-hand panel hosting:
 * - Tab 1: Search & Booking filters (Site, Floor, Date, Resource Type, Time, Equipment, Availability)
 * - Tab 2: Multi-floor Wayfinding Route Planner & Turn-by-Turn Directions
 * - Scrollable Resource Directory with quick Book and Navigate actions
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  readonly store = inject(KioskStore);

  readonly collapsed = model<boolean>(false);
  readonly activeTab = model<SidebarTab>('search');

  readonly selectResource = output<string>();
  readonly bookResource = output<KioskResource>();
  readonly navigateHere = output<string>();
  readonly stepClick = output<RouteStep>();

  readonly showEquipmentFilter = signal(false);

  readonly timeSlots = TIME_SLOTS;
  readonly kindFilters = KIND_FILTERS;
  readonly formatTime12h = formatTime12h;
  readonly formatDistance = formatDistance;
  readonly formatDuration = formatDuration;
  readonly statusLabel = statusLabel;
  readonly statusColor = statusColor;
  readonly turnIcon = turnIconPath;

  resourceSwatch(item: KioskResource): string {
    return resourceSwatchColor(item, (id) => this.store.statusOf(id));
  }

  onBookClick(item: KioskResource, event: Event): void {
    event.stopPropagation();
    this.bookResource.emit(item);
  }

  onNavigateClick(id: string, event: Event): void {
    event.stopPropagation();
    this.navigateHere.emit(id);
  }
}
