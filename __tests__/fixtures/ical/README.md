# iCal fixtures

Peer-platform calendar feeds in the shapes vendors actually paste into
Calendar Sync. Served raw from this public repo so a deployed environment can
fetch them as an external feed during integration checks.

- `reservety-rv-multi-unit.ics`: a Reservety-style export for a multi-site RV
  listing. Two overlapping all-day stays (exclusive checkout day), one
  `STATUS:CANCELLED` stay that must not create a hold, and one timed stay with
  a `TZID` check-in/check-out that crosses local midnight.
- `google-calendar-reservety-mirror.ics`: the Google Calendar iCal export shape
  (VTIMEZONE, `TZID` timed events, `VALUE=DATE` all-day events, a
  `TRANSP:TRANSPARENT` "Free" event) mirroring six Reservety-style bookings
  that were created in a real Google calendar during the 2026-09-12 stage
  check. Used when that calendar's secret address is not available to the
  environment doing the fetch.
