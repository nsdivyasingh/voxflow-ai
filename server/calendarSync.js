/**
 * VoxFlow — Calendar Sync
 * Integrates with Google Calendar for scheduling and syncing events.
 */

import { google } from 'googleapis';

let calendarClient = null;

/**
 * Initialize Google Calendar client.
 */
export async function initCalendar() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[VoxFlow] ⚠️ Google Calendar not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.');
    calendarClient = null;
    return;
  }

  const oAuth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  oAuth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  calendarClient = google.calendar({ version: 'v3', auth: oAuth2Client });
  console.log('[VoxFlow] ✅ Google Calendar initialized');
}

/**
 * Add an event to Google Calendar.
 * @param {string} summary
 * @param {Date} startTime
 * @param {Date} endTime
 * @param {string} description
 */
export async function addCalendarEvent(summary, startTime, endTime, description = '') {
  if (!calendarClient) {
    throw new Error('Google Calendar is not configured or failed to initialize.');
  }

  try {
    const event = {
      summary,
      description,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'UTC',
      },
    };

    const response = await calendarClient.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    if (!response?.data) {
      throw new Error('Google Calendar API returned no event data.');
    }

    return response.data;
  } catch (err) {
    console.error('[VoxFlow] Calendar sync error:', err?.message || err);
    throw err;
  }
}

/**
 * Get upcoming events from Google Calendar.
 * @param {number} maxResults
 */
export async function getUpcomingEvents(maxResults = 10) {
  if (!calendarClient) return [];

  try {
    const response = await calendarClient.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return response.data.items || [];
  } catch (err) {
    console.error('[VoxFlow] Calendar fetch error:', err.message);
    return [];
  }
}