// Fetch SEPTA's live Regional Rail feeds. Each fetch fails independently and returns { ok, data | error }.
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;

export const SOURCES = {
  trainView: 'https://www3.septa.org/api/TrainView/index.php',
  alerts: 'https://www3.septa.org/api/Alerts/index.php',
  rtTrips: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb',
  rtAlerts: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Service/rtServiceAlerts.pb',
};

const HEADERS = { 'User-Agent': 'regional-fail-logger (open-source transit reliability tracker)' };

async function get(url, as) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: as === 'buffer' ? new Uint8Array(await res.arrayBuffer()) : await res.json() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Normalize one TrainView entry. */
export function normalizeTrain(t) {
  const late = Number(t.late);
  return {
    trainno: String(t.trainno).trim(),
    train: String(t.trainno).trim().replace(/\D+$/, ''),   // "1723P" -> "1723"
    lat: Number(t.lat), lon: Number(t.lon),
    line: t.line || null,
    service: t.service || null,
    source: t.SOURCE || null,
    dest: t.dest || null,
    cur: t.currentstop || null,
    next: t.nextstop || null,
    cars: t.consist ? String(t.consist).split(',').map(s => s.trim()).filter(Boolean) : [],
    // 999 = not reporting yet (usually not departed); positions are unreliable then.
    late: Number.isFinite(late) && late !== 999 ? late : null,
    reporting: Number.isFinite(late) && late !== 999,
  };
}

export async function fetchTrainView() {
  const r = await get(SOURCES.trainView);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { ok: false, error: 'TrainView did not return a list' };
  return { ok: true, data: r.data.map(normalizeTrain) };
}

/** Legacy JSON alerts: keep only Regional Rail-relevant text. */
export async function fetchAlerts() {
  const r = await get(SOURCES.alerts);
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { ok: false, error: 'Alerts did not return a list' };
  const out = [];
  for (const a of r.data) {
    const mode = String(a.mode || '');
    if (!/rail|generic/i.test(mode) && !/^rr_/i.test(a.route_id || '')) continue;
    for (const field of ['alert', 'advisory']) {
      const text = stripHtml(a[field]);
      if (text) out.push({ source: 'alerts-json', route: a.route_id || a.route || null, text, updated: a.last_updated || null });
    }
  }
  return { ok: true, data: out };
}

function decode(buf) {
  return transit_realtime.FeedMessage.toObject(transit_realtime.FeedMessage.decode(buf), { enums: String, longs: Number });
}

/** GTFS-realtime trip updates: we only care about trips SEPTA marks as something other than SCHEDULED. */
export async function fetchRtTrips() {
  const r = await get(SOURCES.rtTrips, 'buffer');
  if (!r.ok) return r;
  try {
    const feed = decode(r.data);
    const trips = (feed.entity || []).filter(e => e.tripUpdate).map(e => ({
      trip: e.tripUpdate.trip?.tripId || null,
      route: e.tripUpdate.trip?.routeId || null,
      rel: e.tripUpdate.trip?.scheduleRelationship || 'SCHEDULED',
      skipped: (e.tripUpdate.stopTimeUpdate || []).filter(s => s.scheduleRelationship === 'SKIPPED').length,
    }));
    return { ok: true, data: trips };
  } catch (e) {
    return { ok: false, error: `decode: ${e.message}` };
  }
}

export async function fetchRtAlerts() {
  const r = await get(SOURCES.rtAlerts, 'buffer');
  if (!r.ok) return r;
  try {
    const feed = decode(r.data);
    const tr = x => (x?.translation || []).map(t => t.text).join(' ');
    const alerts = (feed.entity || []).filter(e => e.alert).map(e => ({
      source: 'gtfs-rt',
      id: e.id,
      route: (e.alert.informedEntity || []).map(i => i.routeId).filter(Boolean).join(',') || null,
      trips: (e.alert.informedEntity || []).map(i => i.trip?.tripId).filter(Boolean),
      effect: e.alert.effect || null,
      text: stripHtml(`${tr(e.alert.headerText)} — ${tr(e.alert.descriptionText)}`),
    }));
    return { ok: true, data: alerts };
  } catch (e) {
    return { ok: false, error: `decode: ${e.message}` };
  }
}

export function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"').replace(/&ndash;|&mdash;/g, '-')
    .replace(/\s+/g, ' ').trim();
}

export async function fetchAll() {
  const [trainView, alerts, rtTrips, rtAlerts] = await Promise.all([fetchTrainView(), fetchAlerts(), fetchRtTrips(), fetchRtAlerts()]);
  return { trainView, alerts, rtTrips, rtAlerts };
}
