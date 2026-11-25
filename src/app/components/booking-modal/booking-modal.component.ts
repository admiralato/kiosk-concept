import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AzureAuthService } from '../../auth/azure-auth.service';
import { OutlookCalendarService } from '../../auth/outlook-calendar.service';
import { KioskStore, timeToMinutes } from '../../kiosk.store';
import { TIME_SLOTS, formatDisplayDate, formatTime12h } from '../../shared/formatters';
import type { KioskResource, Reservation } from '../../wayfinding/models';

/**
 * Create & Edit Reservation modal dialog.
 *
 * Automatically syncs directly with Outlook / Exchange via Microsoft Graph (`OutlookCalendarService`)
 * whenever the target resource has a non-empty `exchangeId` and the user is signed in with Azure AD.
 */
@Component({
  selector: 'app-booking-modal',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './booking-modal.component.html',
  styleUrl: './booking-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingModalComponent {
  readonly store = inject(KioskStore);
  readonly auth = inject(AzureAuthService);
  private readonly outlookCalendar = inject(OutlookCalendarService);

  readonly open = input<boolean>(false);
  readonly mode = input<'create' | 'edit'>('create');
  readonly resource = input<KioskResource | null>(null);
  readonly reservation = input<Reservation | null>(null);

  readonly closed = output<void>();
  readonly toast = output<string>();
  readonly cancelReservation = output<Reservation>();
  readonly endReservation = output<Reservation>();

  readonly subject = signal('');
  readonly organizer = signal('');
  readonly date = signal('');
  readonly startTime = signal('');
  readonly endTime = signal('');
  readonly startNow = signal(false);
  readonly attendees = signal('');
  readonly notes = signal('');
  readonly onlineMeeting = signal(false);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  readonly timeSlots = TIME_SLOTS;
  readonly formatTime12h = formatTime12h;

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const m = this.mode();
      const editRes = this.reservation();

      this.error.set(null);
      this.submitting.set(false);

      if (m === 'edit' && editRes) {
        this.subject.set(editRes.subject);
        this.organizer.set(editRes.organizer);
        this.date.set(editRes.date);
        this.startTime.set(editRes.startTime);
        this.endTime.set(editRes.endTime);
        this.startNow.set(editRes.status === 'started');
        this.attendees.set((editRes.attendees ?? []).join(', '));
        this.notes.set('');
        this.onlineMeeting.set(!!editRes.isOnlineMeeting);
      } else {
        this.subject.set('');
        this.organizer.set(this.auth.user()?.name ?? '');
        this.date.set(this.store.filterDate());
        this.startTime.set(this.store.startTime());
        this.endTime.set(this.store.endTime());
        this.startNow.set(false);
        this.attendees.set('');
        this.notes.set('');
        this.onlineMeeting.set(false);
      }
    });
  }

  close(): void {
    if (this.submitting()) return;
    this.error.set(null);
    this.closed.emit();
  }

  async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);

    if (this.mode() === 'edit') {
      const target = this.reservation();
      if (!target) return;

      const cleanSubject = this.subject().trim();
      if (!cleanSubject) {
        this.error.set('Subject cannot be empty.');
        return;
      }

      if (target.outlookEventId && this.auth.isAzureAdAuthenticated()) {
        this.submitting.set(true);
        try {
          await this.outlookCalendar.updateRoomEvent(target.outlookEventId, {
            subject: cleanSubject,
            ...(target.status === 'starting'
              ? {
                  date: this.date(),
                  startTime: this.startTime(),
                  endTime: this.endTime(),
                }
              : {}),
          });
        } catch (err) {
          this.error.set(
            err instanceof Error ? err.message : 'Unable to update Outlook calendar event.',
          );
          return;
        } finally {
          this.submitting.set(false);
        }
      }

      const result = this.store.updateReservation({
        id: target.id,
        subject: this.subject(),
        organizer: this.organizer(),
        date: this.date(),
        startTime: this.startTime(),
        endTime: this.endTime(),
      });
      if (!result.ok) {
        this.error.set(result.error ?? 'Unable to update reservation.');
        return;
      }
      this.closed.emit();
      this.toast.emit(
        target.outlookEventId
          ? `Updated Outlook reservation "${result.reservation?.subject}"`
          : `Updated reservation "${result.reservation?.subject}"`,
      );
      return;
    }

    const sel = this.resource();
    if (!sel) return;

    const sMin = timeToMinutes(this.startTime());
    const eMin = timeToMinutes(this.endTime());
    if (eMin <= sMin) {
      this.error.set('End time must be after start time.');
      return;
    }

    const exchangeId = sel.exchangeId?.trim() || '';
    const attendeeEmails = this.attendees()
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes('@'));

    let outlookEventId: string | undefined;
    let outlookWebLink: string | undefined;

    if (exchangeId && this.auth.isAzureAdAuthenticated()) {
      this.submitting.set(true);
      try {
        const created = await this.outlookCalendar.createRoomEvent({
          roomName: sel.name,
          exchangeId,
          subject: this.subject(),
          date: this.date(),
          startTime: this.startTime(),
          endTime: this.endTime(),
          attendeeEmails,
          notes: this.notes(),
          isOnlineMeeting: this.onlineMeeting(),
        });
        outlookEventId = created.id;
        outlookWebLink = created.webLink;
      } catch (err) {
        this.error.set(
          err instanceof Error ? err.message : 'Unable to create Outlook calendar event.',
        );
        return;
      } finally {
        this.submitting.set(false);
      }
    }

    const result = this.store.createBooking({
      resourceId: sel.id,
      subject: this.subject(),
      organizer: this.organizer(),
      date: this.date(),
      startTime: this.startTime(),
      endTime: this.endTime(),
      startNow: this.startNow(),
      outlookEventId,
      outlookWebLink,
      attendees: attendeeEmails,
      isOnlineMeeting: this.onlineMeeting(),
    });
    if (!result.ok) {
      this.error.set(result.error ?? 'Unable to complete booking.');
      return;
    }
    this.closed.emit();
    this.toast.emit(
      outlookEventId
        ? `Booked ${sel.name} in Outlook on ${formatDisplayDate(this.date())} (${formatTime12h(this.startTime())} – ${formatTime12h(this.endTime())})`
        : `Booked ${sel.name} on ${formatDisplayDate(this.date())} (${formatTime12h(this.startTime())} – ${formatTime12h(this.endTime())})`,
    );
  }
}
