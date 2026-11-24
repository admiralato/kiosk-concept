import { Injectable, inject } from '@angular/core';
import { AzureAuthService } from './azure-auth.service';

export interface CreateOutlookRoomEventRequest {
  roomName: string;
  exchangeId: string;
  subject: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  attendeeEmails?: string[];
  notes?: string;
  isOnlineMeeting?: boolean;
}

export interface UpdateOutlookRoomEventRequest {
  subject: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

export interface OutlookEventResult {
  id: string;
  webLink?: string;
}

const GRAPH_EVENTS_URL = 'https://graph.microsoft.com/v1.0/me/events';
const CALENDAR_SCOPES = ['Calendars.ReadWrite'];

/**
 * Books, updates, and cancels Exchange / Outlook room reservations directly in-app
 * using Microsoft Graph (`POST /me/events`, `PATCH /me/events/{id}`, `POST /me/events/{id}/cancel`).
 *
 * Keeps the user inside SpaceBoard PC (no new browser tab/window) while creating a real
 * Outlook calendar event and reserving the Exchange room mailbox (`exchangeId`).
 */
@Injectable({ providedIn: 'root' })
export class OutlookCalendarService {
  private readonly auth = inject(AzureAuthService);

  /** Creates a real Outlook/Exchange event for a resource with a non-empty `exchangeId`. */
  async createRoomEvent(req: CreateOutlookRoomEventRequest): Promise<OutlookEventResult> {
    const timeZone = this.localTimeZone();
    const attendees: Array<{
      emailAddress: { address: string; name?: string };
      type: 'required' | 'optional' | 'resource';
    }> = [
      {
        emailAddress: { address: req.exchangeId.trim(), name: req.roomName },
        type: 'resource',
      },
    ];

    for (const rawEmail of req.attendeeEmails ?? []) {
      const email = rawEmail.trim();
      if (!email || email.toLowerCase() === req.exchangeId.trim().toLowerCase()) continue;
      attendees.push({
        emailAddress: { address: email },
        type: 'required',
      });
    }

    const payload: Record<string, unknown> = {
      subject: req.subject.trim() || `Booking — ${req.roomName}`,
      body: {
        contentType: 'Text',
        content: req.notes?.trim() || `Booked via SpaceBoard PC (${req.roomName}).`,
      },
      start: {
        dateTime: `${req.date}T${req.startTime}:00`,
        timeZone,
      },
      end: {
        dateTime: `${req.date}T${req.endTime}:00`,
        timeZone,
      },
      location: {
        displayName: req.roomName,
        locationEmailAddress: req.exchangeId.trim(),
      },
      attendees,
      ...(req.isOnlineMeeting
        ? {
            isOnlineMeeting: true,
            onlineMeetingProvider: 'teamsForBusiness',
          }
        : {}),
    };

    const res = await this.auth.authFetch(
      GRAPH_EVENTS_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      CALENDAR_SCOPES,
    );

    if (!res.ok) {
      throw new Error(await this.extractGraphError(res));
    }

    const data = (await res.json()) as { id: string; webLink?: string };
    return { id: data.id, webLink: data.webLink };
  }

  /** Updates an existing Outlook event created via SpaceBoard PC. */
  async updateRoomEvent(eventId: string, req: UpdateOutlookRoomEventRequest): Promise<void> {
    const timeZone = this.localTimeZone();
    const payload: Record<string, unknown> = {
      subject: req.subject.trim(),
    };
    if (req.date && req.startTime && req.endTime) {
      payload['start'] = { dateTime: `${req.date}T${req.startTime}:00`, timeZone };
      payload['end'] = { dateTime: `${req.date}T${req.endTime}:00`, timeZone };
    }

    const res = await this.auth.authFetch(
      `${GRAPH_EVENTS_URL}/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      CALENDAR_SCOPES,
    );

    if (!res.ok) {
      throw new Error(await this.extractGraphError(res));
    }
  }

  /** Cancels an existing Outlook event and releases the Exchange room mailbox. */
  async cancelRoomEvent(eventId: string, comment = 'Cancelled via SpaceBoard PC.'): Promise<void> {
    const res = await this.auth.authFetch(
      `${GRAPH_EVENTS_URL}/${encodeURIComponent(eventId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment }),
      },
      CALENDAR_SCOPES,
    );

    if (!res.ok) {
      throw new Error(await this.extractGraphError(res));
    }
  }

  private localTimeZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  private async extractGraphError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.message) {
        return `Outlook Graph API (${res.status}): ${body.error.message}`;
      }
    } catch {
      // Ignore non-JSON error body
    }
    return `Outlook Graph API request failed (HTTP ${res.status}).`;
  }
}
