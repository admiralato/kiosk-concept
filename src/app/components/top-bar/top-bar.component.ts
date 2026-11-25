import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AzureAuthService } from '../../auth/azure-auth.service';
import { KioskStore } from '../../kiosk.store';
import { BUILD_INFO } from '../../shared/build-info';
import { TIME_SLOTS, formatClock, formatDate, formatTime12h } from '../../shared/formatters';

/**
 * Top header bar containing the brand pill, kiosk/floor/date/time quick filters,
 * signed-in user pill with Sign Out action, and live clock.
 */
@Component({
  selector: 'app-top-bar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './top-bar.component.html',
  styleUrl: './top-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopBarComponent implements OnInit, OnDestroy {
  readonly store = inject(KioskStore);
  readonly auth = inject(AzureAuthService);

  readonly signOut = output<void>();

  readonly timeSlots = TIME_SLOTS;
  readonly formatTime12h = formatTime12h;
  readonly buildInfo = BUILD_INFO;
  readonly currentTime = signal(formatClock(new Date()));
  readonly currentDate = signal(formatDate(new Date()));

  private clockTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.clockTimer = setInterval(() => {
      const now = new Date();
      this.currentTime.set(formatClock(now));
      this.currentDate.set(formatDate(now));
    }, 10_000);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
  }
}
