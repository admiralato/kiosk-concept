import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { KioskStore } from '../../kiosk.store';
import {
  formatDisplayDate,
  formatTime12h,
  kindColor,
  reservationBarStyle,
  statusColor,
  statusLabel,
} from '../../shared/formatters';
import { STATUS_COLORS } from '../../three/floorplan-engine';
import type { KioskResource, Reservation } from '../../wayfinding/models';

/**
 * Right-hand resource inspector drawer showing metadata, equipment, live availability,
 * 07:00–19:00 day timeline, upcoming/full-day schedule controls, and booking/wayfinding actions.
 */
@Component({
  selector: 'app-resource-inspector',
  standalone: true,
  templateUrl: './resource-inspector.component.html',
  styleUrl: './resource-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResourceInspectorComponent {
  readonly store = inject(KioskStore);

  readonly bookResource = output<KioskResource>();
  readonly editReservation = output<Reservation>();
  readonly cancelReservation = output<Reservation>();
  readonly endReservation = output<Reservation>();
  readonly navigateHere = output<string>();
  readonly navigateFromHere = output<string>();

  readonly showFullSchedule = signal(false);

  readonly statusColors = STATUS_COLORS;
  readonly formatTime12h = formatTime12h;
  readonly formatDisplayDate = formatDisplayDate;
  readonly statusLabel = statusLabel;
  readonly statusColor = statusColor;
  readonly kindColor = kindColor;
  readonly reservationBarStyle = reservationBarStyle;

  onEdit(res: Reservation, event: Event): void {
    event.stopPropagation();
    this.editReservation.emit(res);
  }

  onCancel(res: Reservation, event: Event): void {
    event.stopPropagation();
    this.cancelReservation.emit(res);
  }

  onEnd(res: Reservation, event: Event): void {
    event.stopPropagation();
    this.endReservation.emit(res);
  }
}
