// Time helpers. SEPTA runs on America/New_York time; GTFS service days can run past 24:00.
export const TZ = 'America/New_York';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hour12: false,
});

/** Parts of an instant in Philadelphia time. */
export function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday.toLowerCase(),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Milliseconds to add to UTC to get Philadelphia wall-clock time at that instant. */
function offsetMs(ms) {
  const p = etParts(ms);
  const [y, m, d] = p.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * GTFS defines times relative to "noon minus 12 hours" of the service date, which keeps
 * times correct across daylight-saving changes. Returns that base instant in ms.
 */
export function serviceDayBase(date) {
  const [y, m, d] = date.split('-').map(Number);
  const noonGuess = Date.UTC(y, m - 1, d, 12);
  const noonEt = noonGuess - offsetMs(noonGuess);
  return noonEt - 12 * 3600 * 1000;
}

/** "HH:MM:SS" (may exceed 24h) on a service date -> epoch seconds. */
export function gtfsTimeToEpoch(date, hms) {
  const [h, m, s = 0] = hms.split(':').map(Number);
  return Math.round(serviceDayBase(date) / 1000) + h * 3600 + m * 60 + s;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Local wall-clock minutes-after-midnight for an epoch-seconds instant (0..1439). */
export function etMinuteOfDay(sec) {
  const p = etParts(sec * 1000);
  return p.hour * 60 + p.minute;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
