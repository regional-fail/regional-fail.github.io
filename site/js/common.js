// Shared helpers for every page: where data lives, formatting, and the lateness scale.

// GitHub repo that holds the data branches. Change this one line if the repo is named differently.
export const REPO = 'regional-fail/regional-fail.github.io';
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// Local preview serves the logger output at /live. In production this points at the repo's `live` branch.
export const LIVE_BASE = LOCAL ? '/live' : `https://raw.githubusercontent.com/${REPO}/live/live`;

// The permanent daily archive (main branch).
export const DATA_BASE = LOCAL ? '/data' : `https://raw.githubusercontent.com/${REPO}/main/data`;

export async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function loadLive() {
  const latest = await getJson(`${LIVE_BASE}/latest.json`);
  const day = await getJson(`${LIVE_BASE}/days/${latest.current}.json`);
  return { latest, day };
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
export const fmtTime = sec => (sec ? timeFmt.format(new Date(sec * 1000)) : '–');
export const fmtPct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
export const fmtMin = v => (v == null ? '–' : `${Math.round(v)} min`);
export const fmtDate = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * Lateness bands (fixed status palette). Green and red are hard to tell apart for red-green colorblind
 * readers, so color is never alone: late trains are drawn larger and always labeled with their minutes late.
 */
export const BANDS = [
  { max: 5, key: 'good', label: 'On time', color: '#0ca30c', radius: 5 },
  { max: 15, key: 'warning', label: 'Late', color: '#fab219', radius: 7 },
  { max: Infinity, key: 'critical', label: 'Very late', color: '#d03b3b', radius: 9 },
];
export const GHOST_COLOR = '#d03b3b';
export const band = late => BANDS.find(b => Math.max(0, late ?? 0) <= b.max);

/** Plain-language status for a train record. */
export function statusText(rec) {
  switch (rec.status) {
    case 'ghost': return rec.ghost === 'confirmed' ? 'Ghost 👻 (SEPTA confirmed canceled)'
      : rec.ghost === 'pre-canceled' ? 'Ghost 👻 (removed from timetable)' : 'Ghost 👻 (never showed up)';
    case 'partial': return rec.legs?.some(l => l.ghost === 'skipped') ? 'Cut short (skipped part of its run)' : 'Partial trip';
    case 'running': return 'Running';
    case 'done': return 'Finished';
    case 'missing': return 'Not seen yet (overdue)';
    case 'upcoming': return 'Scheduled';
    default: return 'Unknown (we weren’t watching)';
  }
}

export function lineNames(rec, network) {
  const names = Object.fromEntries(network.lines.map(l => [l.id, l.name]));
  return rec.legs?.length ? rec.legs.map(l => `${names[l.route] || l.route} ${l.dir}`).join(' → ') : `${rec.tv_line || 'Unscheduled'} (not in timetable)`;
}

export const stopName = (network, id) => network.stops[id]?.[0] || id;

/** Set text on an element by id (never innerHTML for data). */
export function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export function renderRules(rules) {
  const ul = document.getElementById('rules');
  if (!ul || !rules) return;
  const items = [
    `On time means ${rules.onTimeMaxLate} minutes late or less at the last stop: SEPTA's own "within 6 minutes" rule.`,
    `A ghost train is a scheduled train that never appears in SEPTA's live feed from ${rules.ghostBeforeDep / 60} minutes before its departure until ${rules.ghostAfterArr / 60} minutes after its scheduled arrival, while we were checking. "Confirmed" ghosts are ones SEPTA itself marked or announced as canceled.`,
    'Trains SEPTA removes from the timetable after we captured it (usually the day before) still count as canceled.',
    'A train that runs through Center City onto a second line is scored on each line separately. If it turns back early, the part it skipped counts as a ghost.',
    `If our own checks had a gap, affected trains are marked "unknown", never counted against SEPTA.`,
    'Lateness is the last delay SEPTA reported before the train left the feed. Checking every 5 minutes can understate the final delay by a few minutes, which works in SEPTA\'s favor.',
  ];
  ul.replaceChildren(...items.map(t => el('li', {}, t)));
}
