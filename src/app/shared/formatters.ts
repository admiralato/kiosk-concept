import type { KindFilter } from '../kiosk.store';
import { AMENITY_COLORS, KIND_COLORS, STATUS_COLORS } from '../three/floorplan-engine';
import { timeToMinutes } from '../kiosk.store';
import type { AvailabilityStatus, KioskResource, TurnKind } from '../wayfinding/models';
import type { ResourceKind } from '../wayfinding/resource-config';

/** 30-minute booking time slots from 06:00 to 22:30. */
export const TIME_SLOTS: readonly string[] = Array.from({ length: 34 }, (_, i) => {
  const totalMinutes = 6 * 60 + i * 30;
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const mm = String(totalMinutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
});

/** Category filter tabs displayed in the resource directory. */
export const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'meeting-room', label: 'Rooms' },
  { id: 'desk', label: 'Desks' },
  { id: 'amenity', label: 'Amenities' },
  { id: 'lift', label: 'Lifts' },
];

export function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime12h(time24: string): string {
  const [hStr, mStr] = time24.split(':');
  const h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return time24;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr} ${suffix}`;
}

export function formatDisplayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function statusLabel(status: AvailabilityStatus): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'reserved':
      return 'Reserve';
    case 'occupied':
      return 'Occupied';
  }
}

export function statusColor(status: AvailabilityStatus): string {
  return STATUS_COLORS[status];
}

export function kindColor(kind: ResourceKind): string {
  return KIND_COLORS[kind];
}

export function resourceSwatchColor(
  item: KioskResource,
  statusOf: (id: string) => AvailabilityStatus,
): string {
  if (!item.bookable) return AMENITY_COLORS[item.resourceType] ?? KIND_COLORS[item.kind];
  return STATUS_COLORS[statusOf(item.id)];
}

/** Computes left% and width% for a reservation bar on the 07:00–19:00 day timeline. */
export function reservationBarStyle(startTime: string, endTime: string): { left: string; width: string } {
  const dayStart = 7 * 60;
  const daySpan = 12 * 60;
  const s = Math.max(dayStart, Math.min(dayStart + daySpan, timeToMinutes(startTime)));
  const e = Math.max(s + 15, Math.min(dayStart + daySpan, timeToMinutes(endTime)));
  const left = ((s - dayStart) / daySpan) * 100;
  const width = ((e - s) / daySpan) * 100;
  return { left: `${left.toFixed(1)}%`, width: `${width.toFixed(1)}%` };
}

export function formatDistance(m: number): string {
  if (m < 1) return '< 1 m';
  return `${Math.round(m)} m`;
}

export function formatDuration(sec: number): string {
  const mins = Math.max(1, Math.round(sec / 60));
  return sec < 45 ? `${Math.max(5, Math.round(sec / 5) * 5)} sec` : `${mins} min`;
}

export function turnIconPath(turn: TurnKind): string {
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
